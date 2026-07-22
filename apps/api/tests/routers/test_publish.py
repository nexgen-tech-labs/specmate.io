"""Epic 5 publish tests — real Postgres, fake Jira gateway via dependency override
(sync tests + asyncio.run per the event-loop notes in test_sources.py)."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime

from fastapi.testclient import TestClient
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.core import db as db_module
from app.core.config import settings
from app.main import app
from app.models import (
    AuditEvent,
    DraftItem,
    Project,
    PublishedItem,
    PublishMapping,
    TraceLink,
    Workspace,
)
from app.routers.publish import PublishGateway, get_publish_gateway
from app.services.connectors.jira_auth import CloudTokenConnection
from app.services.connectors.jira_publish import PublishCandidate, PublishOutcome
from tests.audit_cleanup import purge_audit_events

_FAKE_META: dict[str, object] = {
    "project_key": "KAN",
    "issue_types": [
        {
            "id": "1",
            "name": "Epic",
            "subtask": False,
            "fields": [
                {"id": "summary", "name": "Summary", "required": True, "has_default": False}
            ],
        },
        {
            "id": "2",
            "name": "Task",
            "subtask": False,
            "fields": [
                {"id": "summary", "name": "Summary", "required": True, "has_default": False},
                {
                    "id": "customfield_9",
                    "name": "Component group",
                    "required": True,
                    "has_default": False,
                },
            ],
        },
        {
            "id": "3",
            "name": "Story",
            "subtask": False,
            "fields": [
                {"id": "summary", "name": "Summary", "required": True, "has_default": False}
            ],
        },
    ],
}


class _FakeJira:
    """Records created issues, mints sequential keys, remembers parent links."""

    def __init__(self) -> None:
        self.counter = 0
        self.created: list[dict[str, object]] = []
        self.updated: list[dict[str, object]] = []

    def gateway(self) -> PublishGateway:
        async def fake_meta(_conn: object, _key: str) -> dict[str, object]:
            return _FAKE_META

        async def fake_projects(_conn: object) -> list[dict[str, str]]:
            return [{"key": "KAN", "name": "myspecmate"}]

        async def fake_create(
            _conn: object,
            project_key: str,
            issue_type: str,
            candidate: PublishCandidate,
            parent_key: str | None,
            _defaults: dict[str, object],
            **_kwargs: object,
        ) -> PublishOutcome:
            self.counter += 1
            key = f"{project_key}-{100 + self.counter}"
            self.created.append(
                {
                    "key": key,
                    "type": issue_type,
                    "title": candidate.title,
                    "parent": parent_key,
                }
            )
            return PublishOutcome(
                item_id=candidate.item_id, ok=True, key=key, url=f"https://x/browse/{key}"
            )

        async def fake_update(
            _conn: object,
            issue_key: str,
            candidate: PublishCandidate,
            _defaults: dict[str, object],
            **_kwargs: object,
        ) -> PublishOutcome:
            self.updated.append({"key": issue_key, "title": candidate.title})
            return PublishOutcome(
                item_id=candidate.item_id, ok=True, key=issue_key, url=f"https://x/browse/{issue_key}"
            )

        async def fake_health(_conn: object) -> dict[str, object]:
            return {"ok": True, "account": "fake"}

        return PublishGateway(
            connection=lambda: CloudTokenConnection("e", "t", "https://x"),
            projects=fake_projects,
            meta=fake_meta,
            create=fake_create,
            update=fake_update,
            health=fake_health,
        )


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _dispose() -> None:
    asyncio.run(db_module.engine.dispose())


async def _fixture(approval_stages: int = 1) -> dict[str, str]:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            ws = Workspace(
                name="Publish Test WS",
                approvalStages=approval_stages,
                createdAt=_now(),
                updatedAt=_now(),
            )
            session.add(ws)
            await session.flush()
            project = Project(
                workspaceId=ws.id, name="Publish Project", createdAt=_now(), updatedAt=_now()
            )
            session.add(project)
            await session.flush()

            epic = DraftItem(
                projectId=project.id, type="EPIC", title="Payments epic",
                description="Epic desc", status="APPROVED", createdAt=_now(), updatedAt=_now(),
            )
            session.add(epic)
            await session.flush()
            story = DraftItem(
                projectId=project.id, type="STORY", title="Saved card story",
                description="Story desc", status="APPROVED", parentId=epic.id,
                createdAt=_now(), updatedAt=_now(),
            )
            pending = DraftItem(
                projectId=project.id, type="TASK", title="Unapproved task",
                description="d", status="PENDING", createdAt=_now(), updatedAt=_now(),
            )
            session.add_all([story, pending])
            await session.flush()

            ids = {
                "workspace_id": ws.id,
                "project_id": project.id,
                "epic_id": epic.id,
                "story_id": story.id,
                "pending_id": pending.id,
            }
            await session.commit()
            return ids
    finally:
        await engine.dispose()


async def _cleanup(ids: dict[str, str], extra_item_ids: list[str] | None = None) -> None:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            item_ids = [
                i.id
                for i in (
                    await session.execute(
                        select(DraftItem).where(DraftItem.projectId == ids["project_id"])
                    )
                ).scalars()
            ] + (extra_item_ids or [])
            if item_ids:
                await session.execute(delete(TraceLink).where(TraceLink.draftItemId.in_(item_ids)))
                await session.execute(
                    delete(PublishedItem).where(PublishedItem.draftItemId.in_(item_ids))
                )
                await session.execute(delete(DraftItem).where(DraftItem.id.in_(item_ids)))
            await session.execute(
                delete(PublishMapping).where(PublishMapping.projectId == ids["project_id"])
            )
            await session.execute(delete(Project).where(Project.id == ids["project_id"]))
            await purge_audit_events(session, ids["workspace_id"])
            await session.execute(delete(Workspace).where(Workspace.id == ids["workspace_id"]))
            await session.commit()
    finally:
        await engine.dispose()


def _setup_mapping(client: TestClient, project_id: str) -> None:
    response = client.post(
        f"/projects/{project_id}/publish-mapping/jira", json={"remote_project": "KAN"}
    )
    assert response.status_code == 200, response.text


def test_mapping_upsert_suggests_defaults_from_discovery() -> None:
    ids = asyncio.run(_fixture())
    fake = _FakeJira()
    app.dependency_overrides[get_publish_gateway] = fake.gateway
    client = TestClient(app)
    try:
        response = client.post(
            f"/projects/{ids['project_id']}/publish-mapping/jira", json={"remote_project": "KAN"}
        )
    finally:
        app.dependency_overrides.pop(get_publish_gateway, None)
        _dispose()

    assert response.status_code == 200
    type_map = response.json()["type_map"]
    assert type_map["EPIC"] == "Epic"
    assert type_map["STORY"] == "Story"
    assert type_map["RISK"] == "Task"  # fallback suggestion

    asyncio.run(_cleanup(ids))


def test_publish_orders_hierarchy_links_parents_and_writes_back_keys() -> None:
    ids = asyncio.run(_fixture())
    fake = _FakeJira()
    app.dependency_overrides[get_publish_gateway] = fake.gateway
    client = TestClient(app)
    try:
        _setup_mapping(client, ids["project_id"])
        _dispose()
        # Story listed before epic on purpose — hierarchy ordering must fix it.
        response = client.post(
            f"/projects/{ids['project_id']}/publish/jira",
            json={"item_ids": [ids["story_id"], ids["epic_id"]]},
        )
    finally:
        app.dependency_overrides.pop(get_publish_gateway, None)
        _dispose()

    assert response.status_code == 200
    body = response.json()
    assert body["succeeded"] == 2 and body["failed"] == 0

    # Epic created first; story links to the epic's freshly minted key (Issue 5.6).
    assert fake.created[0]["type"] == "Epic" and fake.created[0]["parent"] is None
    assert fake.created[1]["type"] == "Story"
    assert fake.created[1]["parent"] == fake.created[0]["key"]

    async def check_writeback() -> tuple[int, str]:
        engine = create_async_engine(settings.database_url)
        try:
            async with AsyncSession(engine) as session:
                rows = list(
                    (
                        await session.execute(
                            select(PublishedItem).where(
                                PublishedItem.draftItemId.in_([ids["epic_id"], ids["story_id"]])
                            )
                        )
                    ).scalars()
                )
                return len(rows), rows[0].externalKey
        finally:
            await engine.dispose()

    count, first_key = asyncio.run(check_writeback())
    assert count == 2 and first_key.startswith("KAN-")

    asyncio.run(_cleanup(ids))


def test_republish_is_blocked_not_duplicated() -> None:
    ids = asyncio.run(_fixture())
    fake = _FakeJira()
    app.dependency_overrides[get_publish_gateway] = fake.gateway
    client = TestClient(app)
    try:
        _setup_mapping(client, ids["project_id"])
        _dispose()
        client.post(
            f"/projects/{ids['project_id']}/publish/jira", json={"item_ids": [ids["epic_id"]]}
        )
        _dispose()
        second = client.post(
            f"/projects/{ids['project_id']}/publish/jira", json={"item_ids": [ids["epic_id"]]}
        )
    finally:
        app.dependency_overrides.pop(get_publish_gateway, None)
        _dispose()

    result = second.json()["results"][0]
    assert result["ok"] is False and result["blocked"] is True
    assert "Already published" in result["error"]
    assert len(fake.created) == 1  # no duplicate Jira issue

    asyncio.run(_cleanup(ids))


def test_unapproved_and_orphaned_children_are_refused() -> None:
    ids = asyncio.run(_fixture())
    fake = _FakeJira()
    app.dependency_overrides[get_publish_gateway] = fake.gateway
    client = TestClient(app)
    try:
        _setup_mapping(client, ids["project_id"])
        _dispose()
        # Story without its (unpublished, not-in-batch) parent + a pending item.
        response = client.post(
            f"/projects/{ids['project_id']}/publish/jira",
            json={"item_ids": [ids["story_id"], ids["pending_id"]]},
        )
    finally:
        app.dependency_overrides.pop(get_publish_gateway, None)
        _dispose()

    by_id = {r["item_id"]: r for r in response.json()["results"]}
    assert by_id[ids["pending_id"]]["error"] == "Only approved items can be published."
    story_result = by_id[ids["story_id"]]
    assert story_result["blocked"] is True
    assert "Parent item is not published" in story_result["error"]
    assert fake.created == []  # nothing orphaned in Jira

    asyncio.run(_cleanup(ids))


def test_required_field_without_default_fails_fast_with_clear_message() -> None:
    ids = asyncio.run(_fixture())
    fake = _FakeJira()
    app.dependency_overrides[get_publish_gateway] = fake.gateway
    client = TestClient(app)
    try:
        # RISK maps to Task, whose fake metadata requires customfield_9 with no default.
        _setup_mapping(client, ids["project_id"])
        _dispose()

        async def add_risk() -> str:
            engine = create_async_engine(settings.database_url)
            try:
                async with AsyncSession(engine) as session:
                    risk = DraftItem(
                        projectId=ids["project_id"], type="RISK", title="PCI risk",
                        description="d", status="APPROVED", createdAt=_now(), updatedAt=_now(),
                    )
                    session.add(risk)
                    await session.flush()
                    risk_id = risk.id
                    await session.commit()
                    return risk_id
            finally:
                await engine.dispose()

        risk_id = asyncio.run(add_risk())
        response = client.post(
            f"/projects/{ids['project_id']}/publish/jira", json={"item_ids": [risk_id]}
        )
    finally:
        app.dependency_overrides.pop(get_publish_gateway, None)
        _dispose()

    result = response.json()["results"][0]
    assert result["ok"] is False
    assert "Component group" in result["error"]  # fail-fast, before any API call
    assert fake.created == []

    asyncio.run(_cleanup(ids))


def test_two_stage_workspace_requires_signoff_before_publish() -> None:
    ids = asyncio.run(_fixture(approval_stages=2))
    fake = _FakeJira()
    app.dependency_overrides[get_publish_gateway] = fake.gateway
    client = TestClient(app)
    try:
        _setup_mapping(client, ids["project_id"])
        _dispose()
        response = client.post(
            f"/projects/{ids['project_id']}/publish/jira", json={"item_ids": [ids["epic_id"]]}
        )
    finally:
        app.dependency_overrides.pop(get_publish_gateway, None)
        _dispose()

    result = response.json()["results"][0]
    assert result["ok"] is False and "sign-off" in result["error"]
    assert fake.created == []

    asyncio.run(_cleanup(ids))


def test_rate_limit_incident_during_publish_records_audit_event() -> None:
    """Issue #89 (Task 5): create() invoking its on_rate_limited callback (as the
    transport does on each retry-triggering 429/5xx) results in a connector.rate_
    limited AuditEvent for the workspace, even though the publish itself succeeds."""
    ids = asyncio.run(_fixture())
    fake = _FakeJira()
    gateway = fake.gateway()

    async def rate_limited_create(
        _conn: object,
        project_key: str,
        issue_type: str,
        candidate: PublishCandidate,
        parent_key: str | None,
        _defaults: dict[str, object],
        **kwargs: object,
    ) -> PublishOutcome:
        on_rate_limited = kwargs.get("on_rate_limited")
        assert callable(on_rate_limited)
        callback: Callable[[int, float, int], Awaitable[None]] = on_rate_limited
        await callback(429, 1.5, 1)
        fake.counter += 1
        key = f"{project_key}-{100 + fake.counter}"
        fake.created.append({"key": key, "type": issue_type, "title": candidate.title, "parent": parent_key})
        return PublishOutcome(item_id=candidate.item_id, ok=True, key=key, url=f"https://x/browse/{key}")

    gateway.create = rate_limited_create

    app.dependency_overrides[get_publish_gateway] = lambda: gateway
    client = TestClient(app)
    try:
        _setup_mapping(client, ids["project_id"])
        _dispose()
        response = client.post(
            f"/projects/{ids['project_id']}/publish/jira", json={"item_ids": [ids["epic_id"]]}
        )
    finally:
        app.dependency_overrides.pop(get_publish_gateway, None)
        _dispose()

    assert response.status_code == 200
    body = response.json()
    assert body["succeeded"] == 1 and body["failed"] == 0

    async def check_audit_event() -> AuditEvent | None:
        engine = create_async_engine(settings.database_url)
        try:
            async with AsyncSession(engine) as session:
                return (
                    await session.execute(
                        select(AuditEvent).where(
                            AuditEvent.workspaceId == ids["workspace_id"],
                            AuditEvent.action == "connector.rate_limited",
                        )
                    )
                ).scalar_one_or_none()
        finally:
            await engine.dispose()

    event = asyncio.run(check_audit_event())
    assert event is not None
    assert event.entityType == "jira"
    assert event.metadata_ == {"status_code": 429, "wait_seconds": 1.5, "retry_count": 1}

    asyncio.run(_cleanup(ids))


def test_publishing_a_targeted_regen_revision_updates_not_duplicates() -> None:
    """Issue 9.4: a DraftItem produced by targeted regeneration (revisionOfId set)
    whose superseded item is already published updates that Jira issue in place."""
    ids = asyncio.run(_fixture())
    fake = _FakeJira()
    app.dependency_overrides[get_publish_gateway] = fake.gateway
    client = TestClient(app)
    try:
        _setup_mapping(client, ids["project_id"])
        _dispose()
        first = client.post(
            f"/projects/{ids['project_id']}/publish/jira", json={"item_ids": [ids["epic_id"]]}
        )
        _dispose()
        assert first.json()["succeeded"] == 1
        original_key = fake.created[0]["key"]

        async def make_revision() -> str:
            engine = create_async_engine(settings.database_url)
            try:
                async with AsyncSession(engine) as session:
                    revised = DraftItem(
                        projectId=ids["project_id"], type="EPIC", title="Payments epic (revised)",
                        description="Updated desc", status="APPROVED",
                        revisionOfId=ids["epic_id"], createdAt=_now(), updatedAt=_now(),
                    )
                    session.add(revised)
                    await session.flush()
                    revised_id = revised.id
                    await session.commit()
                    return revised_id
            finally:
                await engine.dispose()

        revised_id = asyncio.run(make_revision())
        response = client.post(
            f"/projects/{ids['project_id']}/publish/jira", json={"item_ids": [revised_id]}
        )
    finally:
        app.dependency_overrides.pop(get_publish_gateway, None)
        _dispose()

    assert response.status_code == 200
    result = response.json()["results"][0]
    assert result["ok"] is True
    assert result["key"] == original_key  # same external key, not a new one

    assert fake.created == [fake.created[0]]  # no second Jira issue created
    assert len(fake.updated) == 1
    assert fake.updated[0]["key"] == original_key
    assert fake.updated[0]["title"] == "Payments epic (revised)"

    async def check_single_published_row() -> tuple[int, str]:
        engine = create_async_engine(settings.database_url)
        try:
            async with AsyncSession(engine) as session:
                rows = list(
                    (
                        await session.execute(
                            select(PublishedItem).where(
                                PublishedItem.draftItemId.in_([ids["epic_id"], revised_id])
                            )
                        )
                    ).scalars()
                )
                return len(rows), rows[0].draftItemId if rows else ""
        finally:
            await engine.dispose()

    count, draft_item_id = asyncio.run(check_single_published_row())
    assert count == 1  # re-pointed, not duplicated
    assert draft_item_id == revised_id

    asyncio.run(_cleanup(ids, extra_item_ids=[revised_id]))
