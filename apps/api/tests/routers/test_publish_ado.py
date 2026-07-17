"""Epic 6 (ADO) publish tests — real Postgres, fake ADO gateway via dependency
override (mirrors test_publish.py's Jira pattern)."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

from fastapi.testclient import TestClient
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.core import db as db_module
from app.core.config import settings
from app.main import app
from app.models import DraftItem, Project, PublishedItem, PublishMapping, TraceLink, Workspace
from app.routers.publish_ado import AdoPublishGateway, get_ado_gateway
from app.services.connectors.ado_auth import PatConnection
from app.services.connectors.ado_publish import AdoPublishCandidate, AdoPublishOutcome
from tests.audit_cleanup import purge_audit_events

_FAKE_META: dict[str, object] = {
    "project_name": "hitesh-specmate",
    "work_item_types": [
        {"name": "Epic", "required_fields": [{"id": "Microsoft.VSTS.Common.Priority", "name": "Priority"}]},
        {"name": "Issue", "required_fields": []},
        {"name": "Task", "required_fields": []},
    ],
    "area_paths": ["hitesh-specmate"],
    "iteration_paths": ["hitesh-specmate", "hitesh-specmate\\Sprint 1"],
}


class _FakeAdo:
    def __init__(self) -> None:
        self.counter = 0
        self.created: list[dict[str, object]] = []
        self.updated: list[dict[str, object]] = []

    def gateway(self) -> AdoPublishGateway:
        async def fake_meta(_conn: object, _name: str) -> dict[str, object]:
            return _FAKE_META

        async def fake_projects(_conn: object) -> list[dict[str, str]]:
            return [{"id": "1", "name": "hitesh-specmate"}]

        async def fake_create(
            _conn: object,
            _project: str,
            work_item_type: str,
            candidate: AdoPublishCandidate,
            parent_url: str | None,
            _area: str | None,
            _iteration: str | None,
            _defaults: dict[str, object],
        ) -> AdoPublishOutcome:
            self.counter += 1
            wid = 100 + self.counter
            self.created.append({"id": wid, "type": work_item_type, "parent_url": parent_url})
            return AdoPublishOutcome(
                item_id=candidate.item_id, ok=True, key=f"AB#{wid}", url=f"https://x/_workitems/edit/{wid}"
            )

        async def fake_update(
            _conn: object,
            work_item_id: int,
            candidate: AdoPublishCandidate,
            _defaults: dict[str, object],
        ) -> AdoPublishOutcome:
            self.updated.append({"id": work_item_id, "title": candidate.content.title})
            return AdoPublishOutcome(
                item_id=candidate.item_id,
                ok=True,
                key=f"AB#{work_item_id}",
                url=f"https://x/_workitems/edit/{work_item_id}",
            )

        async def fake_health(_conn: object) -> dict[str, object]:
            return {"ok": True}

        return AdoPublishGateway(
            connection=lambda: PatConnection("t", "https://x"),
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
            ws = Workspace(name="ADO Test WS", approvalStages=approval_stages, createdAt=_now(), updatedAt=_now())
            session.add(ws)
            await session.flush()
            project = Project(workspaceId=ws.id, name="ADO Test Project", createdAt=_now(), updatedAt=_now())
            session.add(project)
            await session.flush()

            epic = DraftItem(
                projectId=project.id, type="EPIC", title="Payments epic", description="d",
                status="APPROVED", createdAt=_now(), updatedAt=_now(),
            )
            session.add(epic)
            await session.flush()
            story = DraftItem(
                projectId=project.id, type="STORY", title="Saved card story", description="d",
                status="APPROVED", parentId=epic.id, createdAt=_now(), updatedAt=_now(),
            )
            pending = DraftItem(
                projectId=project.id, type="TASK", title="Unapproved task", description="d",
                status="PENDING", createdAt=_now(), updatedAt=_now(),
            )
            session.add_all([story, pending])
            await session.flush()

            ids = {
                "workspace_id": ws.id, "project_id": project.id,
                "epic_id": epic.id, "story_id": story.id, "pending_id": pending.id,
            }
            await session.commit()
            return ids
    finally:
        await engine.dispose()


async def _cleanup(ids: dict[str, str]) -> None:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            item_ids = [
                i.id for i in (
                    await session.execute(select(DraftItem).where(DraftItem.projectId == ids["project_id"]))
                ).scalars()
            ]
            if item_ids:
                await session.execute(delete(TraceLink).where(TraceLink.draftItemId.in_(item_ids)))
                await session.execute(delete(PublishedItem).where(PublishedItem.draftItemId.in_(item_ids)))
                await session.execute(delete(DraftItem).where(DraftItem.id.in_(item_ids)))
            await session.execute(delete(PublishMapping).where(PublishMapping.projectId == ids["project_id"]))
            await session.execute(delete(Project).where(Project.id == ids["project_id"]))
            await purge_audit_events(session, ids["workspace_id"])
            await session.execute(delete(Workspace).where(Workspace.id == ids["workspace_id"]))
            await session.commit()
    finally:
        await engine.dispose()


def _setup_mapping(client: TestClient, project_id: str) -> None:
    response = client.post(
        f"/projects/{project_id}/publish-mapping/ado",
        json={"remote_project": "hitesh-specmate", "field_defaults": {"Microsoft.VSTS.Common.Priority": 2}},
    )
    assert response.status_code == 200, response.text


def test_mapping_upsert_suggests_defaults_from_discovery() -> None:
    ids = asyncio.run(_fixture())
    fake = _FakeAdo()
    app.dependency_overrides[get_ado_gateway] = fake.gateway
    client = TestClient(app)
    try:
        response = client.post(
            f"/projects/{ids['project_id']}/publish-mapping/ado", json={"remote_project": "hitesh-specmate"}
        )
    finally:
        app.dependency_overrides.pop(get_ado_gateway, None)
        _dispose()

    assert response.status_code == 200
    type_map = response.json()["type_map"]
    assert type_map["EPIC"] == "Epic"
    assert type_map["STORY"] == "Issue"
    assert type_map["TASK"] == "Task"

    asyncio.run(_cleanup(ids))


def test_publish_fails_fast_on_required_field_without_default() -> None:
    ids = asyncio.run(_fixture())
    fake = _FakeAdo()
    app.dependency_overrides[get_ado_gateway] = fake.gateway
    client = TestClient(app)
    try:
        # No field_defaults for Epic's required Priority field this time.
        client.post(f"/projects/{ids['project_id']}/publish-mapping/ado", json={"remote_project": "hitesh-specmate"})
        _dispose()
        response = client.post(
            f"/projects/{ids['project_id']}/publish/ado", json={"item_ids": [ids["epic_id"]]}
        )
    finally:
        app.dependency_overrides.pop(get_ado_gateway, None)
        _dispose()

    result = response.json()["results"][0]
    assert result["ok"] is False
    assert "Priority" in result["error"]
    assert fake.created == []

    asyncio.run(_cleanup(ids))


def test_publish_orders_hierarchy_and_links_native_parent_child() -> None:
    ids = asyncio.run(_fixture())
    fake = _FakeAdo()
    app.dependency_overrides[get_ado_gateway] = fake.gateway
    client = TestClient(app)
    try:
        _setup_mapping(client, ids["project_id"])
        _dispose()
        response = client.post(
            f"/projects/{ids['project_id']}/publish/ado",
            json={"item_ids": [ids["story_id"], ids["epic_id"]]},  # child listed first on purpose
        )
    finally:
        app.dependency_overrides.pop(get_ado_gateway, None)
        _dispose()

    assert response.status_code == 200
    body = response.json()
    assert body["succeeded"] == 2 and body["failed"] == 0
    assert fake.created[0]["type"] == "Epic" and fake.created[0]["parent_url"] is None
    assert fake.created[1]["type"] == "Issue"
    assert fake.created[1]["parent_url"] is not None
    assert str(fake.created[0]["id"]) in fake.created[1]["parent_url"]

    asyncio.run(_cleanup(ids))


def test_republish_is_blocked_not_duplicated() -> None:
    ids = asyncio.run(_fixture())
    fake = _FakeAdo()
    app.dependency_overrides[get_ado_gateway] = fake.gateway
    client = TestClient(app)
    try:
        _setup_mapping(client, ids["project_id"])
        _dispose()
        client.post(f"/projects/{ids['project_id']}/publish/ado", json={"item_ids": [ids["epic_id"]]})
        _dispose()
        second = client.post(f"/projects/{ids['project_id']}/publish/ado", json={"item_ids": [ids["epic_id"]]})
    finally:
        app.dependency_overrides.pop(get_ado_gateway, None)
        _dispose()

    result = second.json()["results"][0]
    assert result["ok"] is False and result["blocked"] is True
    assert len(fake.created) == 1

    asyncio.run(_cleanup(ids))


def test_orphaned_child_and_unapproved_item_are_refused() -> None:
    ids = asyncio.run(_fixture())
    fake = _FakeAdo()
    app.dependency_overrides[get_ado_gateway] = fake.gateway
    client = TestClient(app)
    try:
        _setup_mapping(client, ids["project_id"])
        _dispose()
        response = client.post(
            f"/projects/{ids['project_id']}/publish/ado",
            json={"item_ids": [ids["story_id"], ids["pending_id"]]},
        )
    finally:
        app.dependency_overrides.pop(get_ado_gateway, None)
        _dispose()

    by_id = {r["item_id"]: r for r in response.json()["results"]}
    assert by_id[ids["pending_id"]]["error"] == "Only approved items can be published."
    assert by_id[ids["story_id"]]["blocked"] is True
    assert fake.created == []

    asyncio.run(_cleanup(ids))


def test_two_stage_workspace_requires_signoff() -> None:
    ids = asyncio.run(_fixture(approval_stages=2))
    fake = _FakeAdo()
    app.dependency_overrides[get_ado_gateway] = fake.gateway
    client = TestClient(app)
    try:
        _setup_mapping(client, ids["project_id"])
        _dispose()
        response = client.post(f"/projects/{ids['project_id']}/publish/ado", json={"item_ids": [ids["epic_id"]]})
    finally:
        app.dependency_overrides.pop(get_ado_gateway, None)
        _dispose()

    result = response.json()["results"][0]
    assert result["ok"] is False and "sign-off" in result["error"]
    assert fake.created == []

    asyncio.run(_cleanup(ids))


def test_publishing_a_targeted_regen_revision_updates_not_duplicates() -> None:
    """Issue 9.4: a revisionOfId'd DraftItem whose superseded item is already
    published updates that ADO work item in place, not a new one."""
    ids = asyncio.run(_fixture())
    fake = _FakeAdo()
    app.dependency_overrides[get_ado_gateway] = fake.gateway
    client = TestClient(app)
    try:
        _setup_mapping(client, ids["project_id"])
        _dispose()
        first = client.post(f"/projects/{ids['project_id']}/publish/ado", json={"item_ids": [ids["epic_id"]]})
        _dispose()
        assert first.json()["succeeded"] == 1
        original_key = fake.created[0]["id"]

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
        response = client.post(f"/projects/{ids['project_id']}/publish/ado", json={"item_ids": [revised_id]})
    finally:
        app.dependency_overrides.pop(get_ado_gateway, None)
        _dispose()

    assert response.status_code == 200
    result = response.json()["results"][0]
    assert result["ok"] is True
    assert result["key"] == f"AB#{original_key}"
    assert fake.created == [fake.created[0]]  # no second work item
    assert len(fake.updated) == 1 and fake.updated[0]["id"] == original_key

    async def check_single_published_row() -> int:
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
                return len(rows)
        finally:
            await engine.dispose()

    assert asyncio.run(check_single_published_row()) == 1

    asyncio.run(_cleanup(ids))
