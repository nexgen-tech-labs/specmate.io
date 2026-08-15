"""Issue #110, gap 2: every existing billing test is stage-isolated —
test_reconciliation.py starts from a hand-built UsagePeriod, test_billing.py's
resolve tests create their flag against the same hand-built fixture, and the
publish-router tests only assert publish succeeds/fails around the inline
report call without asserting on the resulting UsagePeriod or chaining into
reconciliation. This test drives the real chain: a real PublishedItem row ->
report_workspace_current_usage() (real metering + a mocked Stripe write) ->
reconcile_workspace_usage() (a mocked Stripe read disagreeing with what was
reported) -> a flag that's created and resolvable via the real HTTP endpoint.

Real Postgres throughout; only the two Stripe API calls (meter_events.create,
event_summaries.list) are mocked, since neither has a usable test-mode
default in this codebase (see stripe_reporting.py's module docstring)."""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.core import db as db_module
from app.core.config import settings
from app.main import app
from app.models import (
    DraftItem,
    PricingTier,
    Project,
    PublishedItem,
    UsagePeriod,
    UsageReconciliationFlag,
    Workspace,
)
from app.services.billing.metering import report_workspace_current_usage
from app.services.billing.reconciliation import reconcile_workspace_usage
from tests.audit_cleanup import purge_audit_events


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _dispose_app_engine() -> None:
    asyncio.run(db_module.engine.dispose())


async def _fixture() -> dict[str, object]:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            now = _now()
            ws = Workspace(
                name="Pipeline Integration WS",
                pricingTier=PricingTier.STARTER,
                stripeCustomerId=f"cus_pipeline_integration_{uuid.uuid4().hex[:12]}",
                createdAt=now,
                updatedAt=now,
            )
            session.add(ws)
            await session.flush()
            project = Project(
                workspaceId=ws.id, name="Pipeline Integration Project", createdAt=now, updatedAt=now
            )
            session.add(project)
            await session.flush()
            item = DraftItem(
                projectId=project.id, type="STORY", title="Item", description="d",
                status="APPROVED", createdAt=now, updatedAt=now,
            )
            session.add(item)
            await session.flush()
            published = PublishedItem(
                draftItemId=item.id, targetTool="JIRA", externalKey="PAY-1",
                externalUrl="https://example.com/1", createdAt=now,
            )
            session.add(published)
            await session.flush()
            ids = {"workspace_id": ws.id, "project_id": project.id, "item_id": item.id}
            await session.commit()
            return ids
    finally:
        await engine.dispose()


async def _cleanup(ids: dict[str, object]) -> None:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            usage_period_ids = [
                r.id
                for r in (
                    await session.execute(
                        select(UsagePeriod).where(UsagePeriod.workspaceId == ids["workspace_id"])
                    )
                ).scalars()
            ]
            if usage_period_ids:
                await session.execute(
                    delete(UsageReconciliationFlag).where(
                        UsageReconciliationFlag.usagePeriodId.in_(usage_period_ids)
                    )
                )
                await session.execute(delete(UsagePeriod).where(UsagePeriod.id.in_(usage_period_ids)))
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


def test_publish_to_reportable_flag_to_resolution_chain() -> None:
    ids = asyncio.run(_fixture())
    workspace_id = str(ids["workspace_id"])

    async def meter_and_report() -> None:
        engine = create_async_engine(settings.database_url)
        try:
            async with AsyncSession(engine) as session:
                mock_stripe_client = MagicMock()
                mock_stripe_client.v1.billing.meter_events.create.return_value = None
                with (
                    patch.object(settings, "stripe_secret_key", "sk_test_fake"),
                    patch("stripe.StripeClient", return_value=mock_stripe_client),
                ):
                    await report_workspace_current_usage(session, workspace_id)
        finally:
            await engine.dispose()

    # Step 1: real PublishedItem -> real metering -> a (mocked-write) Stripe
    # report. This is the same inline call each publish router makes.
    asyncio.run(meter_and_report())

    async def get_usage_period() -> UsagePeriod:
        engine = create_async_engine(settings.database_url)
        try:
            async with AsyncSession(engine) as session:
                row = (
                    await session.execute(
                        select(UsagePeriod).where(UsagePeriod.workspaceId == workspace_id)
                    )
                ).scalar_one()
                return row
        finally:
            await engine.dispose()

    usage_period = asyncio.run(get_usage_period())
    assert usage_period.publishedItemCount == 1
    assert usage_period.reportedCount == 1  # the (mocked) Stripe report succeeded

    # Step 2: reconciliation, with a mocked Stripe readback that disagrees
    # with what step 1 actually reported — simulating real drift.
    async def reconcile() -> str:
        engine = create_async_engine(settings.database_url)
        try:
            async with AsyncSession(engine) as session:
                row = await session.get(UsagePeriod, usage_period.id)
                assert row is not None

                async def disagreeing_fetch(workspace: object, usage_period_arg: object) -> int:
                    return 0  # Stripe's own total says 0, SpecMate reported 1

                with patch(
                    "app.services.billing.reconciliation.fetch_stripe_reported_total",
                    new=disagreeing_fetch,
                ):
                    flag = await reconcile_workspace_usage(session, row)
                assert flag is not None
                await session.flush()  # populate flag.id (default=_cuid, applied at flush/INSERT)
                flag_id = flag.id
                await session.commit()
                return flag_id
        finally:
            await engine.dispose()

    flag_id = asyncio.run(reconcile())
    # Step 3: the flag is resolvable through the real HTTP endpoint.
    _dispose_app_engine()
    client = TestClient(app)
    response = client.post(
        f"/billing/reconciliation-flags/{flag_id}/resolve",
        json={"resolved_by_user_id": None},
    )
    _dispose_app_engine()

    assert response.status_code == 200
    assert response.json()["ok"] is True

    asyncio.run(_cleanup(ids))
