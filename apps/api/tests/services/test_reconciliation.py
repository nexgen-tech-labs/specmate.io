"""Reconciliation tests (Issue 12.5) — real Postgres, monkeypatched Stripe readback
(no real Stripe call needed to prove the diff/flag logic), mirroring
test_billing_metering.py's fixture/cleanup conventions."""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.core.config import settings
from app.models import (
    DraftItem,
    Project,
    PublishedItem,
    UsagePeriod,
    UsageReconciliationFlag,
    Workspace,
)
from app.services.billing.metering import current_period_bounds
from app.services.billing.reconciliation import reconcile_workspace_usage
from tests.audit_cleanup import purge_audit_events


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


async def _fixture(
    reported_count: int = 5, stripe_customer_id: str | None = "_default_"
) -> dict[str, object]:
    if stripe_customer_id == "_default_":
        stripe_customer_id = f"cus_test_{uuid.uuid4().hex[:12]}"
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            now = _now()
            ws = Workspace(
                name="Reconciliation WS",
                stripeCustomerId=stripe_customer_id,
                createdAt=now,
                updatedAt=now,
            )
            session.add(ws)
            await session.flush()
            project = Project(
                workspaceId=ws.id, name="Reconciliation Project", createdAt=now, updatedAt=now
            )
            session.add(project)
            await session.flush()

            item = DraftItem(
                projectId=project.id, type="STORY", title="Item", description="d",
                status="APPROVED", createdAt=now, updatedAt=now,
            )
            session.add(item)
            await session.flush()

            period_start, period_end = current_period_bounds(now)
            usage_period = UsagePeriod(
                workspaceId=ws.id,
                periodStart=period_start,
                periodEnd=period_end,
                publishedItemCount=reported_count,
                reportedCount=reported_count,
                reportedToStripeAt=now,
                createdAt=now,
                updatedAt=now,
            )
            session.add(usage_period)
            await session.flush()

            ids = {
                "workspace_id": ws.id,
                "project_id": project.id,
                "item_id": item.id,
                "usage_period_id": usage_period.id,
            }
            await session.commit()
            return ids
    finally:
        await engine.dispose()


async def _cleanup(ids: dict[str, object]) -> None:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            await session.execute(
                delete(UsageReconciliationFlag).where(
                    UsageReconciliationFlag.usagePeriodId == ids["usage_period_id"]
                )
            )
            await session.execute(
                delete(UsagePeriod).where(UsagePeriod.id == ids["usage_period_id"])
            )
            await session.execute(
                delete(PublishedItem).where(PublishedItem.draftItemId == ids["item_id"])
            )
            await session.execute(delete(DraftItem).where(DraftItem.id == ids["item_id"]))
            await session.execute(delete(Project).where(Project.id == ids["project_id"]))
            await purge_audit_events(session, str(ids["workspace_id"]))
            await session.execute(delete(Workspace).where(Workspace.id == ids["workspace_id"]))
            await session.commit()
    finally:
        await engine.dispose()


def test_reconcile_creates_no_flag_when_counts_match(monkeypatch) -> None:
    ids = asyncio.run(_fixture(reported_count=5))

    async def fake_fetch(workspace: object, usage_period: object) -> int:
        return 5

    monkeypatch.setattr(
        "app.services.billing.reconciliation.fetch_stripe_reported_total", fake_fetch
    )

    async def run() -> UsageReconciliationFlag | None:
        engine = create_async_engine(settings.database_url)
        try:
            async with AsyncSession(engine) as session:
                usage_period = await session.get(UsagePeriod, ids["usage_period_id"])
                assert usage_period is not None
                flag = await reconcile_workspace_usage(session, usage_period)
                await session.commit()
                return flag
        finally:
            await engine.dispose()

    flag = asyncio.run(run())
    assert flag is None

    async def count_flags() -> int:
        engine = create_async_engine(settings.database_url)
        try:
            async with AsyncSession(engine) as session:
                rows = (
                    await session.execute(
                        select(UsageReconciliationFlag).where(
                            UsageReconciliationFlag.usagePeriodId == ids["usage_period_id"]
                        )
                    )
                ).scalars().all()
                return len(rows)
        finally:
            await engine.dispose()

    assert asyncio.run(count_flags()) == 0

    asyncio.run(_cleanup(ids))


def test_reconcile_creates_a_flag_on_mismatch(monkeypatch) -> None:
    ids = asyncio.run(_fixture(reported_count=5))

    async def fake_fetch(workspace: object, usage_period: object) -> int:
        return 8

    monkeypatch.setattr(
        "app.services.billing.reconciliation.fetch_stripe_reported_total", fake_fetch
    )

    async def run() -> dict[str, object] | None:
        engine = create_async_engine(settings.database_url)
        try:
            async with AsyncSession(engine) as session:
                usage_period = await session.get(UsagePeriod, ids["usage_period_id"])
                assert usage_period is not None
                flag = await reconcile_workspace_usage(session, usage_period)
                if flag is None:
                    await session.commit()
                    return None
                result = {
                    "internalCount": flag.internalCount,
                    "stripeCount": flag.stripeCount,
                    "resolvedAt": flag.resolvedAt,
                }
                await session.commit()
                return result
        finally:
            await engine.dispose()

    flag = asyncio.run(run())
    assert flag is not None
    assert flag["internalCount"] == 5
    assert flag["stripeCount"] == 8
    assert flag["resolvedAt"] is None

    asyncio.run(_cleanup(ids))


def test_reconcile_refreshes_existing_flag_instead_of_duplicating(monkeypatch) -> None:
    ids = asyncio.run(_fixture(reported_count=5))

    stripe_values = iter([8, 12])

    async def fake_fetch(workspace: object, usage_period: object) -> int:
        return next(stripe_values)

    monkeypatch.setattr(
        "app.services.billing.reconciliation.fetch_stripe_reported_total", fake_fetch
    )

    async def run_once() -> str:
        engine = create_async_engine(settings.database_url)
        try:
            async with AsyncSession(engine) as session:
                usage_period = await session.get(UsagePeriod, ids["usage_period_id"])
                assert usage_period is not None
                flag = await reconcile_workspace_usage(session, usage_period)
                assert flag is not None
                await session.flush()
                flag_id = flag.id
                await session.commit()
                return flag_id
        finally:
            await engine.dispose()

    first_id = asyncio.run(run_once())
    second_id = asyncio.run(run_once())
    assert first_id == second_id

    async def fetch_all() -> list[UsageReconciliationFlag]:
        engine = create_async_engine(settings.database_url)
        try:
            async with AsyncSession(engine) as session:
                rows = (
                    await session.execute(
                        select(UsageReconciliationFlag).where(
                            UsageReconciliationFlag.usagePeriodId == ids["usage_period_id"]
                        )
                    )
                ).scalars().all()
                return list(rows)
        finally:
            await engine.dispose()

    rows = asyncio.run(fetch_all())
    assert len(rows) == 1
    assert rows[0].stripeCount == 12

    asyncio.run(_cleanup(ids))


def test_reconcile_skips_workspace_without_stripe_customer_id(monkeypatch) -> None:
    ids = asyncio.run(_fixture(reported_count=5, stripe_customer_id=None))

    called = False

    async def fake_fetch(workspace: object, usage_period: object) -> int:
        nonlocal called
        called = True
        return 999

    monkeypatch.setattr(
        "app.services.billing.reconciliation.fetch_stripe_reported_total", fake_fetch
    )

    async def run() -> UsageReconciliationFlag | None:
        engine = create_async_engine(settings.database_url)
        try:
            async with AsyncSession(engine) as session:
                usage_period = await session.get(UsagePeriod, ids["usage_period_id"])
                assert usage_period is not None
                flag = await reconcile_workspace_usage(session, usage_period)
                await session.commit()
                return flag
        finally:
            await engine.dispose()

    flag = asyncio.run(run())
    assert flag is None
    assert called is False

    asyncio.run(_cleanup(ids))
