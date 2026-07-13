"""Epic 8 tests: snapshot export (8.4), approval report (8.5), audit-event
immutability + coverage (8.1). Real Postgres, no fakes needed — reports read
only from the DB."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

from fastapi.testclient import TestClient
from sqlalchemy import delete, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.core import db as db_module
from app.core.config import settings
from app.main import app
from app.models import (
    AuditEvent,
    DraftItem,
    Project,
    PublishedItem,
    RawRequirement,
    ReviewDecision,
    Snapshot,
    Source,
    TraceLink,
    User,
    Workspace,
)
from tests.audit_cleanup import purge_audit_events


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _dispose() -> None:
    asyncio.run(db_module.engine.dispose())


async def _fixture() -> dict[str, str]:
    """Workspace with one approved+published item carrying a decision and a citation."""
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            now = _now()
            ws = Workspace(name="Reports WS", createdAt=now, updatedAt=now)
            session.add(ws)
            await session.flush()
            approver = User(
                email=f"approver-{ws.id}@test.local",
                name="Ava Approver",
                passwordHash="x",
                createdAt=now,
                updatedAt=now,
            )
            project = Project(workspaceId=ws.id, name="Reports Project", createdAt=now, updatedAt=now)
            session.add_all([approver, project])
            await session.flush()

            source = Source(
                projectId=project.id, name="requirements.docx", kind="DOCX",
                status="PARSED", createdAt=now, updatedAt=now,
            )
            session.add(source)
            await session.flush()
            fragment = RawRequirement(
                sourceId=source.id, text="The system shall support saved cards.",
                sectionPath="2.1 Payments", order=1, createdAt=now, updatedAt=now,
            )
            session.add(fragment)
            await session.flush()

            item = DraftItem(
                projectId=project.id, type="STORY", title="Saved card checkout",
                description="d", status="APPROVED", createdAt=now, updatedAt=now,
            )
            pending = DraftItem(
                projectId=project.id, type="TASK", title="Unapproved task",
                description="d", status="PENDING", createdAt=now, updatedAt=now,
            )
            session.add_all([item, pending])
            await session.flush()

            decision = ReviewDecision(
                draftItemId=item.id, decision="APPROVED",
                actorUserId=approver.id, createdAt=now,
            )
            published = PublishedItem(
                draftItemId=item.id, targetTool="JIRA", externalKey="PAY-141",
                externalUrl="https://example.atlassian.net/browse/PAY-141", createdAt=now,
            )
            session.add_all([decision, published])
            await session.flush()
            session.add(
                TraceLink(
                    sourceId=source.id, rawRequirementId=fragment.id,
                    draftItemId=item.id, publishedItemId=published.id,
                    createdAt=now, updatedAt=now,
                )
            )
            ids = {
                "workspace_id": ws.id, "project_id": project.id,
                "item_id": item.id, "source_id": source.id, "user_id": approver.id,
            }
            await session.commit()
            return ids
    finally:
        await engine.dispose()


async def _cleanup(ids: dict[str, str]) -> None:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            await session.execute(delete(Snapshot).where(Snapshot.projectId == ids["project_id"]))
            await session.execute(
                delete(TraceLink).where(TraceLink.sourceId == ids["source_id"])
            )
            await session.execute(
                delete(PublishedItem).where(PublishedItem.draftItemId == ids["item_id"])
            )
            await session.execute(
                delete(ReviewDecision).where(ReviewDecision.draftItemId == ids["item_id"])
            )
            await session.execute(
                delete(DraftItem).where(DraftItem.projectId == ids["project_id"])
            )
            await session.execute(
                delete(RawRequirement).where(RawRequirement.sourceId == ids["source_id"])
            )
            await session.execute(delete(Source).where(Source.id == ids["source_id"]))
            await session.execute(delete(Project).where(Project.id == ids["project_id"]))
            # Purge before the User delete: actorUserId is ON DELETE SET NULL, and that
            # implicit UPDATE would be rejected by the immutability trigger.
            await purge_audit_events(session, ids["workspace_id"])
            await session.execute(delete(User).where(User.id == ids["user_id"]))
            await session.execute(delete(Workspace).where(Workspace.id == ids["workspace_id"]))
            await session.commit()
    finally:
        await engine.dispose()


def test_snapshot_captures_full_trace_map_and_survives_later_edits() -> None:
    ids = asyncio.run(_fixture())
    client = TestClient(app)
    try:
        created = client.post(f"/projects/{ids['project_id']}/snapshots", json={})
        assert created.status_code == 200, created.text
        snapshot_id = created.json()["id"]
        assert created.json()["item_count"] == 2

        # Mutate live data AFTER the snapshot — the artifact must not change (8.4 AC).
        async def rename_item() -> None:
            engine = create_async_engine(settings.database_url)
            try:
                async with AsyncSession(engine) as session:
                    item = await session.get(DraftItem, ids["item_id"])
                    assert item is not None
                    item.title = "RENAMED after snapshot"
                    await session.commit()
            finally:
                await engine.dispose()

        _dispose()
        asyncio.run(rename_item())

        fetched = client.get(f"/projects/{ids['project_id']}/snapshots/{snapshot_id}")
        assert fetched.status_code == 200
        data = fetched.json()
        titles = {i["title"] for i in data["items"]}
        assert "Saved card checkout" in titles  # pre-edit title preserved
        assert "RENAMED after snapshot" not in titles

        story = next(i for i in data["items"] if i["title"] == "Saved card checkout")
        assert story["published"][0]["key"] == "PAY-141"
        assert story["decisions"][0]["actor_name"] == "Ava Approver"
        assert story["citations"][0]["section_path"] == "2.1 Payments"
    finally:
        _dispose()
    asyncio.run(_cleanup(ids))


def test_snapshot_pdf_renders_from_stored_artifact() -> None:
    ids = asyncio.run(_fixture())
    client = TestClient(app)
    try:
        snapshot_id = client.post(f"/projects/{ids['project_id']}/snapshots", json={}).json()["id"]
        _dispose()
        response = client.get(f"/projects/{ids['project_id']}/snapshots/{snapshot_id}/pdf")
        assert response.status_code == 200
        assert response.headers["content-type"] == "application/pdf"
        assert response.content.startswith(b"%PDF")
    finally:
        _dispose()
    asyncio.run(_cleanup(ids))


def test_snapshot_rows_reject_update_at_db_level() -> None:
    ids = asyncio.run(_fixture())
    client = TestClient(app)
    try:
        snapshot_id = client.post(f"/projects/{ids['project_id']}/snapshots", json={}).json()["id"]
    finally:
        _dispose()

    async def try_update() -> None:
        engine = create_async_engine(settings.database_url)
        try:
            async with AsyncSession(engine) as session:
                await session.execute(
                    text('UPDATE "Snapshot" SET kind = \'TAMPERED\' WHERE id = :id'),
                    {"id": snapshot_id},
                )
                await session.commit()
        finally:
            await engine.dispose()

    try:
        asyncio.run(try_update())
        raise AssertionError("Snapshot UPDATE should have been rejected by trigger")
    except DBAPIError as exc:
        assert "immutable" in str(exc)

    asyncio.run(_cleanup(ids))


def test_audit_events_reject_update_and_delete_at_db_level() -> None:
    ids = asyncio.run(_fixture())
    client = TestClient(app)
    try:
        client.post(f"/projects/{ids['project_id']}/snapshots", json={})  # writes an audit event
    finally:
        _dispose()

    async def try_mutate(sql: str) -> None:
        engine = create_async_engine(settings.database_url)
        try:
            async with AsyncSession(engine) as session:
                await session.execute(text(sql), {"ws": ids["workspace_id"]})
                await session.commit()
        finally:
            await engine.dispose()

    for sql in (
        'UPDATE "AuditEvent" SET action = \'tampered\' WHERE "workspaceId" = :ws',
        'DELETE FROM "AuditEvent" WHERE "workspaceId" = :ws',
    ):
        try:
            asyncio.run(try_mutate(sql))
            raise AssertionError("AuditEvent mutation should have been rejected by trigger")
        except DBAPIError as exc:
            assert "append-only" in str(exc)

    asyncio.run(_cleanup(ids))


def test_snapshot_creation_writes_audit_event() -> None:
    ids = asyncio.run(_fixture())
    client = TestClient(app)
    try:
        client.post(
            f"/projects/{ids['project_id']}/snapshots", json={"actor_user_id": ids["user_id"]}
        )
    finally:
        _dispose()

    async def fetch_events() -> list[AuditEvent]:
        engine = create_async_engine(settings.database_url)
        try:
            async with AsyncSession(engine) as session:
                from sqlalchemy import select

                rows = await session.execute(
                    select(AuditEvent).where(
                        AuditEvent.workspaceId == ids["workspace_id"],
                        AuditEvent.action == "snapshot.created",
                    )
                )
                return list(rows.scalars())
        finally:
            await engine.dispose()

    events = asyncio.run(fetch_events())
    assert len(events) == 1
    assert events[0].actorUserId == ids["user_id"]
    assert events[0].projectId == ids["project_id"]

    asyncio.run(_cleanup(ids))


def test_approval_report_lists_only_approved_items_with_approver_and_citation() -> None:
    ids = asyncio.run(_fixture())
    client = TestClient(app)
    try:
        response = client.get(f"/projects/{ids['project_id']}/approval-report")
    finally:
        _dispose()

    assert response.status_code == 200
    rows = response.json()["rows"]
    assert len(rows) == 1  # the PENDING task is excluded
    row = rows[0]
    assert row["title"] == "Saved card checkout"
    assert row["approver"] == "Ava Approver"
    assert row["source_citation"] == "requirements.docx (2.1 Payments)"
    assert row["published"] == ["JIRA PAY-141"]

    asyncio.run(_cleanup(ids))


def test_approval_report_date_range_scoping_and_pdf() -> None:
    ids = asyncio.run(_fixture())
    client = TestClient(app)
    try:
        outside = client.get(
            f"/projects/{ids['project_id']}/approval-report",
            params={"date_from": "2020-01-01", "date_to": "2020-12-31"},
        )
        _dispose()
        pdf = client.get(f"/projects/{ids['project_id']}/approval-report/pdf")
    finally:
        _dispose()

    assert outside.json()["rows"] == []  # approval happened now, not in 2020
    assert pdf.status_code == 200
    assert pdf.content.startswith(b"%PDF")

    asyncio.run(_cleanup(ids))
