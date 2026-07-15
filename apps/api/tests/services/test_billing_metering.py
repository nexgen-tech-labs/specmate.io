"""Issue 10.9: usage metering counts PublishedItem rows per workspace per UTC
calendar-month period, idempotently. Real Postgres, no fakes needed."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.core.config import settings
from app.models import DraftItem, Project, PublishedItem, UsagePeriod, Workspace
from app.services.billing.metering import current_period_bounds, meter_workspace_for_period
from tests.audit_cleanup import purge_audit_events


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


async def _fixture() -> dict[str, object]:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            now = _now()
            ws = Workspace(name="Metering WS", createdAt=now, updatedAt=now)
            session.add(ws)
            await session.flush()
            project = Project(workspaceId=ws.id, name="Metering Project", createdAt=now, updatedAt=now)
            session.add(project)
            await session.flush()

            items = [
                DraftItem(
                    projectId=project.id, type="STORY", title=f"Item {i}", description="d",
                    status="APPROVED", createdAt=now, updatedAt=now,
                )
                for i in range(3)
            ]
            session.add_all(items)
            await session.flush()

            period_start, period_end = current_period_bounds(now)
            # Two published items inside the current period, one outside (last month).
            published = [
                PublishedItem(
                    draftItemId=items[0].id, targetTool="JIRA", externalKey="PAY-1",
                    externalUrl="https://example.com/1", createdAt=period_start,
                ),
                PublishedItem(
                    draftItemId=items[1].id, targetTool="JIRA", externalKey="PAY-2",
                    externalUrl="https://example.com/2",
                    createdAt=period_start.replace(day=min(period_start.day + 1, 28)),
                ),
                PublishedItem(
                    draftItemId=items[2].id, targetTool="JIRA", externalKey="PAY-3",
                    externalUrl="https://example.com/3",
                    createdAt=period_start.replace(year=period_start.year - 1),
                ),
            ]
            session.add_all(published)
            await session.flush()
            result = {
                "workspace_id": ws.id, "project_id": project.id, "item_ids": [i.id for i in items],
                "period_start": period_start, "period_end": period_end,
            }
            await session.commit()
            return result
    finally:
        await engine.dispose()


async def _cleanup(ids: dict[str, object]) -> None:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            item_ids = ids["item_ids"]
            assert isinstance(item_ids, list)
            await session.execute(delete(PublishedItem).where(PublishedItem.draftItemId.in_(item_ids)))
            await session.execute(delete(DraftItem).where(DraftItem.id.in_(item_ids)))
            await session.execute(delete(UsagePeriod).where(UsagePeriod.workspaceId == ids["workspace_id"]))
            await session.execute(delete(Project).where(Project.id == ids["project_id"]))
            await purge_audit_events(session, str(ids["workspace_id"]))
            await session.execute(delete(Workspace).where(Workspace.id == ids["workspace_id"]))
            await session.commit()
    finally:
        await engine.dispose()


def test_meters_only_published_items_within_the_current_period() -> None:
    ids = asyncio.run(_fixture())

    async def run() -> int:
        engine = create_async_engine(settings.database_url)
        try:
            async with AsyncSession(engine) as session:
                row = await meter_workspace_for_period(
                    session, str(ids["workspace_id"]), ids["period_start"], ids["period_end"]  # type: ignore[arg-type]
                )
                count = row.publishedItemCount
                await session.commit()
                return count
        finally:
            await engine.dispose()

    count = asyncio.run(run())
    assert count == 2  # the third item was published last year

    asyncio.run(_cleanup(ids))


def test_metering_is_idempotent_per_period_not_duplicated() -> None:
    ids = asyncio.run(_fixture())

    async def run_twice() -> int:
        engine = create_async_engine(settings.database_url)
        try:
            async with AsyncSession(engine) as session:
                await meter_workspace_for_period(
                    session, str(ids["workspace_id"]), ids["period_start"], ids["period_end"]  # type: ignore[arg-type]
                )
                await session.commit()
            async with AsyncSession(engine) as session:
                await meter_workspace_for_period(
                    session, str(ids["workspace_id"]), ids["period_start"], ids["period_end"]  # type: ignore[arg-type]
                )
                await session.commit()
            async with AsyncSession(engine) as session:
                rows = (
                    await session.execute(
                        select(UsagePeriod).where(UsagePeriod.workspaceId == ids["workspace_id"])
                    )
                ).scalars().all()
                return len(rows)
        finally:
            await engine.dispose()

    row_count = asyncio.run(run_twice())
    assert row_count == 1  # upserted, not duplicated

    asyncio.run(_cleanup(ids))
