"""Billing reconciliation router tests (Issue 12.5) — real Postgres,
monkeypatched Stripe readback, mirroring test_drift.py's TestClient conventions."""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.core import db as db_module
from app.core.config import settings
from app.main import app
from app.models import (
    DraftItem,
    Project,
    PublishedItem,
    UsagePeriod,
    UsageReconciliationFlag,
    Workspace,
)
from app.services.billing.metering import current_period_bounds
from tests.audit_cleanup import purge_audit_events


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _dispose() -> None:
    asyncio.run(db_module.engine.dispose())


async def _fixture(reported_count: int = 5) -> dict[str, object]:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            now = _now()
            ws = Workspace(
                name="Billing Router WS",
                stripeCustomerId=f"cus_test_{uuid.uuid4().hex[:12]}",
                createdAt=now,
                updatedAt=now,
            )
            session.add(ws)
            await session.flush()
            project = Project(
                workspaceId=ws.id, name="Billing Router Project", createdAt=now, updatedAt=now
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


def test_reconcile_usage_with_matching_counts_returns_empty_flagged_list(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ids = asyncio.run(_fixture(reported_count=5))

    async def fake_fetch(workspace: object, usage_period: object) -> int:
        return 5

    monkeypatch.setattr(
        "app.services.billing.reconciliation.fetch_stripe_reported_total", fake_fetch
    )

    client = TestClient(app)
    try:
        response = client.post("/billing/reconcile-usage")
    finally:
        _dispose()

    assert response.status_code == 200
    body = response.json()
    assert body["flagged"] == []
    assert body["checked"] >= 1
    assert body["stripe_reconciliation_skipped"] is False

    asyncio.run(_cleanup(ids))


def test_reconcile_usage_with_mismatch_flags_and_persists_row(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ids = asyncio.run(_fixture(reported_count=5))

    async def fake_fetch(workspace: object, usage_period: object) -> int:
        return 9

    monkeypatch.setattr(
        "app.services.billing.reconciliation.fetch_stripe_reported_total", fake_fetch
    )

    client = TestClient(app)
    try:
        response = client.post("/billing/reconcile-usage")
    finally:
        _dispose()

    assert response.status_code == 200
    body = response.json()
    matches = [f for f in body["flagged"] if f["usage_period_id"] == ids["usage_period_id"]]
    assert len(matches) == 1
    assert matches[0]["internal_count"] == 5
    assert matches[0]["stripe_count"] == 9

    async def fetch_flag() -> UsageReconciliationFlag | None:
        engine = create_async_engine(settings.database_url)
        try:
            async with AsyncSession(engine) as session:
                return (
                    await session.execute(
                        select(UsageReconciliationFlag).where(
                            UsageReconciliationFlag.usagePeriodId == ids["usage_period_id"]
                        )
                    )
                ).scalar_one_or_none()
        finally:
            await engine.dispose()

    flag = asyncio.run(fetch_flag())
    assert flag is not None
    assert flag.stripeCount == 9

    asyncio.run(_cleanup(ids))


def test_resolve_reconciliation_flag_404_for_nonexistent_flag() -> None:
    client = TestClient(app)
    try:
        response = client.post(
            "/billing/reconciliation-flags/does-not-exist/resolve", json={}
        )
    finally:
        _dispose()

    assert response.status_code == 404


def test_resolve_reconciliation_flag_409_when_already_resolved(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ids = asyncio.run(_fixture(reported_count=5))

    async def fake_fetch(workspace: object, usage_period: object) -> int:
        return 9

    monkeypatch.setattr(
        "app.services.billing.reconciliation.fetch_stripe_reported_total", fake_fetch
    )

    client = TestClient(app)
    try:
        client.post("/billing/reconcile-usage")
        _dispose()

        async def fetch_flag_id() -> str:
            engine = create_async_engine(settings.database_url)
            try:
                async with AsyncSession(engine) as session:
                    flag = (
                        await session.execute(
                            select(UsageReconciliationFlag).where(
                                UsageReconciliationFlag.usagePeriodId
                                == ids["usage_period_id"]
                            )
                        )
                    ).scalar_one()
                    return flag.id
            finally:
                await engine.dispose()

        flag_id = asyncio.run(fetch_flag_id())

        first = client.post(f"/billing/reconciliation-flags/{flag_id}/resolve", json={})
        _dispose()
        assert first.status_code == 200

        second = client.post(f"/billing/reconciliation-flags/{flag_id}/resolve", json={})
        _dispose()
        assert second.status_code == 409
    finally:
        _dispose()

    asyncio.run(_cleanup(ids))


def test_resolve_reconciliation_flag_happy_path_sets_resolved_fields(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ids = asyncio.run(_fixture(reported_count=5))

    async def fake_fetch(workspace: object, usage_period: object) -> int:
        return 9

    monkeypatch.setattr(
        "app.services.billing.reconciliation.fetch_stripe_reported_total", fake_fetch
    )

    client = TestClient(app)
    try:
        client.post("/billing/reconcile-usage")
        _dispose()

        async def fetch_flag_id() -> str:
            engine = create_async_engine(settings.database_url)
            try:
                async with AsyncSession(engine) as session:
                    flag = (
                        await session.execute(
                            select(UsageReconciliationFlag).where(
                                UsageReconciliationFlag.usagePeriodId
                                == ids["usage_period_id"]
                            )
                        )
                    ).scalar_one()
                    return flag.id
            finally:
                await engine.dispose()

        flag_id = asyncio.run(fetch_flag_id())

        response = client.post(
            f"/billing/reconciliation-flags/{flag_id}/resolve",
            json={"resolved_by_user_id": "user-123"},
        )
        _dispose()
        assert response.status_code == 200
        assert response.json()["ok"] is True
    finally:
        _dispose()

    async def fetch_flag() -> UsageReconciliationFlag:
        engine = create_async_engine(settings.database_url)
        try:
            async with AsyncSession(engine) as session:
                return (
                    await session.execute(
                        select(UsageReconciliationFlag).where(
                            UsageReconciliationFlag.usagePeriodId == ids["usage_period_id"]
                        )
                    )
                ).scalar_one()
        finally:
            await engine.dispose()

    flag = asyncio.run(fetch_flag())
    assert flag.resolvedAt is not None
    assert flag.resolvedByUserId == "user-123"

    asyncio.run(_cleanup(ids))
