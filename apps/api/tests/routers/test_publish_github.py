"""Epic 7 (GitHub) publish tests — real Postgres, fake GitHub gateway via
dependency override (mirrors test_publish.py/test_publish_ado.py)."""

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
from app.models import AuditEvent, DraftItem, Project, PublishedItem, PublishMapping, TraceLink, Workspace
from app.routers.publish_github import GitHubPublishGateway, get_github_gateway
from app.services.connectors.github_auth import TokenConnection
from app.services.connectors.github_publish import GitHubPublishCandidate, GitHubPublishOutcome
from tests.audit_cleanup import purge_audit_events

_FAKE_META: dict[str, object] = {
    "repo": "acme/payments",
    "labels": ["bug", "enhancement"],
    "milestones": [{"number": 1, "title": "v1"}],
    "file_paths": ["apps/web/src/lib/payments.ts", "apps/api/app/routers/payments.py"],
}


class _FakeGitHub:
    def __init__(self, fail_first: bool = False) -> None:
        self.counter = 0
        self.created: list[dict[str, object]] = []
        self.updated_bodies: list[tuple[int, str]] = []
        self.updated: list[dict[str, object]] = []
        self.fail_first = fail_first
        self._failed_once = False

    def gateway(self) -> GitHubPublishGateway:
        async def fake_meta(_conn: object, _repo: str) -> dict[str, object]:
            return _FAKE_META

        async def fake_repos(_conn: object) -> list[dict[str, str]]:
            return [{"full_name": "acme/payments", "id": "1"}]

        async def fake_create(
            _conn: object,
            _repo: str,
            candidate: GitHubPublishCandidate,
            labels: list[str],
            _milestone: int | None,
            **_kwargs: object,
        ) -> GitHubPublishOutcome:
            if self.fail_first and not self._failed_once:
                self._failed_once = True
                return GitHubPublishOutcome(item_id=candidate.item_id, ok=False, error="GitHub rejected: bad label")
            self.counter += 1
            number = 100 + self.counter
            self.created.append({"number": number, "title": candidate.content.title, "labels": labels})
            return GitHubPublishOutcome(
                item_id=candidate.item_id, ok=True, key=f"#{number}", number=number,
                url=f"https://github.com/acme/payments/issues/{number}",
            )

        async def fake_update(
            _conn: object,
            _repo: str,
            issue_number: int,
            candidate: GitHubPublishCandidate,
            **_kwargs: object,
        ) -> GitHubPublishOutcome:
            self.updated.append({"number": issue_number, "title": candidate.content.title})
            return GitHubPublishOutcome(
                item_id=candidate.item_id,
                ok=True,
                key=f"#{issue_number}",
                number=issue_number,
                url=f"https://github.com/acme/payments/issues/{issue_number}",
            )

        async def fake_update_body(_conn: object, _repo: str, number: int, body: str) -> None:
            self.updated_bodies.append((number, body))

        async def fake_health(_conn: object) -> dict[str, object]:
            return {"ok": True, "account": "acme-bot"}

        return GitHubPublishGateway(
            connection=lambda: TokenConnection("t"),
            repos=fake_repos,
            meta=fake_meta,
            create=fake_create,
            update=fake_update,
            update_body=fake_update_body,
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
            ws = Workspace(name="GH Test WS", approvalStages=approval_stages, createdAt=_now(), updatedAt=_now())
            session.add(ws)
            await session.flush()
            project = Project(workspaceId=ws.id, name="GH Test Project", createdAt=_now(), updatedAt=_now())
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


def _setup_mapping(client: TestClient, project_id: str, format_mode: str = "HUMAN") -> None:
    response = client.post(
        f"/projects/{project_id}/publish-mapping/github",
        json={"remote_project": "acme/payments", "format_mode": format_mode},
    )
    assert response.status_code == 200, response.text


def test_mapping_upsert_returns_discovery_and_suggests_agent_mode() -> None:
    ids = asyncio.run(_fixture())
    fake = _FakeGitHub()
    app.dependency_overrides[get_github_gateway] = fake.gateway
    client = TestClient(app)
    try:
        response = client.post(
            f"/projects/{ids['project_id']}/publish-mapping/github", json={"remote_project": "acme/payments"}
        )
    finally:
        app.dependency_overrides.pop(get_github_gateway, None)
        _dispose()

    assert response.status_code == 200
    body = response.json()
    assert body["metadata"]["labels"] == ["bug", "enhancement"]
    assert body["suggested_format_mode"] == "CODING_AGENT"  # suggested, not forced (7.3 AC)
    assert body["format_mode"] == "HUMAN"  # default stays Human until admin picks agent mode

    asyncio.run(_cleanup(ids))


def test_publish_hierarchy_and_task_list_backfill() -> None:
    ids = asyncio.run(_fixture())
    fake = _FakeGitHub()
    app.dependency_overrides[get_github_gateway] = fake.gateway
    client = TestClient(app)
    try:
        _setup_mapping(client, ids["project_id"])
        _dispose()
        response = client.post(
            f"/projects/{ids['project_id']}/publish/github",
            json={"item_ids": [ids["epic_id"], ids["story_id"]]},
        )
    finally:
        app.dependency_overrides.pop(get_github_gateway, None)
        _dispose()

    assert response.status_code == 200
    body = response.json()
    assert body["succeeded"] == 2 and body["failed"] == 0
    # Task-list backfill: the epic's body gets PATCHed once its child publishes.
    assert len(fake.updated_bodies) == 1
    number, new_body = fake.updated_bodies[0]
    assert number == fake.created[0]["number"]
    assert "## Child items" in new_body
    assert "Saved card story" in new_body

    asyncio.run(_cleanup(ids))


def test_coding_agent_mode_includes_suggested_file_references() -> None:
    ids = asyncio.run(_fixture())
    fake = _FakeGitHub()
    app.dependency_overrides[get_github_gateway] = fake.gateway
    client = TestClient(app)
    try:
        _setup_mapping(client, ids["project_id"], format_mode="CODING_AGENT")
        _dispose()

        async def rename_epic() -> None:
            engine = create_async_engine(settings.database_url)
            try:
                async with AsyncSession(engine) as session:
                    item = await session.get(DraftItem, ids["epic_id"])
                    assert item is not None
                    item.title = "payments module epic"
                    await session.commit()
            finally:
                await engine.dispose()

        asyncio.run(rename_epic())
        response = client.post(f"/projects/{ids['project_id']}/publish/github", json={"item_ids": [ids["epic_id"]]})
    finally:
        app.dependency_overrides.pop(get_github_gateway, None)
        _dispose()

    assert response.status_code == 200
    assert response.json()["succeeded"] == 1
    assert fake.created[0]["title"] == "payments module epic"

    asyncio.run(_cleanup(ids))


def test_republish_is_blocked_not_duplicated() -> None:
    ids = asyncio.run(_fixture())
    fake = _FakeGitHub()
    app.dependency_overrides[get_github_gateway] = fake.gateway
    client = TestClient(app)
    try:
        _setup_mapping(client, ids["project_id"])
        _dispose()
        client.post(f"/projects/{ids['project_id']}/publish/github", json={"item_ids": [ids["epic_id"]]})
        _dispose()
        second = client.post(f"/projects/{ids['project_id']}/publish/github", json={"item_ids": [ids["epic_id"]]})
    finally:
        app.dependency_overrides.pop(get_github_gateway, None)
        _dispose()

    result = second.json()["results"][0]
    assert result["ok"] is False and result["blocked"] is True
    assert len(fake.created) == 1

    asyncio.run(_cleanup(ids))


def test_orphaned_child_and_unapproved_item_are_refused() -> None:
    ids = asyncio.run(_fixture())
    fake = _FakeGitHub()
    app.dependency_overrides[get_github_gateway] = fake.gateway
    client = TestClient(app)
    try:
        _setup_mapping(client, ids["project_id"])
        _dispose()
        response = client.post(
            f"/projects/{ids['project_id']}/publish/github",
            json={"item_ids": [ids["story_id"], ids["pending_id"]]},
        )
    finally:
        app.dependency_overrides.pop(get_github_gateway, None)
        _dispose()

    by_id = {r["item_id"]: r for r in response.json()["results"]}
    assert by_id[ids["pending_id"]]["error"] == "Only approved items can be published."
    assert by_id[ids["story_id"]]["blocked"] is True
    assert fake.created == []

    asyncio.run(_cleanup(ids))


def test_permanent_failure_does_not_roll_back_batch_and_is_individually_retriable() -> None:
    ids = asyncio.run(_fixture())
    fake = _FakeGitHub(fail_first=True)
    app.dependency_overrides[get_github_gateway] = fake.gateway
    client = TestClient(app)
    try:
        _setup_mapping(client, ids["project_id"])
        _dispose()
        response = client.post(f"/projects/{ids['project_id']}/publish/github", json={"item_ids": [ids["epic_id"]]})
    finally:
        app.dependency_overrides.pop(get_github_gateway, None)
        _dispose()

    result = response.json()["results"][0]
    assert result["ok"] is False
    assert "bad label" in result["error"]

    async def fetch_flags() -> dict[str, object] | None:
        engine = create_async_engine(settings.database_url)
        try:
            async with AsyncSession(engine) as session:
                item = await session.get(DraftItem, ids["epic_id"])
                assert item is not None
                return item.flags
        finally:
            await engine.dispose()

    flags = asyncio.run(fetch_flags())
    assert flags is not None and "bad label" in str(flags.get("publishError"))

    # Retry (same item, fresh gateway with fail_first cleared) succeeds without duplicating.
    fake2 = _FakeGitHub()
    app.dependency_overrides[get_github_gateway] = fake2.gateway
    client2 = TestClient(app)
    try:
        retry = client2.post(f"/projects/{ids['project_id']}/publish/github", json={"item_ids": [ids["epic_id"]]})
    finally:
        app.dependency_overrides.pop(get_github_gateway, None)
        _dispose()
    assert retry.json()["results"][0]["ok"] is True

    asyncio.run(_cleanup(ids))


def test_publishing_a_targeted_regen_revision_updates_not_duplicates() -> None:
    """Issue 9.4: a revisionOfId'd DraftItem whose superseded item is already
    published updates that GitHub issue in place, not a new one."""
    ids = asyncio.run(_fixture())
    fake = _FakeGitHub()
    app.dependency_overrides[get_github_gateway] = fake.gateway
    client = TestClient(app)
    try:
        _setup_mapping(client, ids["project_id"])
        _dispose()
        first = client.post(f"/projects/{ids['project_id']}/publish/github", json={"item_ids": [ids["epic_id"]]})
        _dispose()
        assert first.json()["succeeded"] == 1
        original_number = fake.created[0]["number"]

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
        response = client.post(f"/projects/{ids['project_id']}/publish/github", json={"item_ids": [revised_id]})
    finally:
        app.dependency_overrides.pop(get_github_gateway, None)
        _dispose()

    assert response.status_code == 200
    result = response.json()["results"][0]
    assert result["ok"] is True
    assert result["key"] == f"#{original_number}"
    assert fake.created == [fake.created[0]]  # no second issue
    assert len(fake.updated) == 1 and fake.updated[0]["number"] == original_number

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


def test_rate_limit_incident_during_publish_records_audit_event() -> None:
    """Issue #89 (Task 5): create() invoking its on_rate_limited callback (as the
    transport does on each retry-triggering 429/5xx) results in a connector.rate_
    limited AuditEvent for the workspace, even though the publish itself succeeds."""
    ids = asyncio.run(_fixture())
    fake = _FakeGitHub()
    gateway = fake.gateway()

    async def rate_limited_create(
        _conn: object,
        _repo: str,
        candidate: GitHubPublishCandidate,
        labels: list[str],
        _milestone: int | None,
        **kwargs: object,
    ) -> GitHubPublishOutcome:
        on_rate_limited = kwargs.get("on_rate_limited")
        assert callable(on_rate_limited)
        callback: Callable[[int, float, int], Awaitable[None]] = on_rate_limited
        await callback(429, 1.5, 1)
        fake.counter += 1
        number = 100 + fake.counter
        fake.created.append({"number": number, "title": candidate.content.title, "labels": labels})
        return GitHubPublishOutcome(
            item_id=candidate.item_id, ok=True, key=f"#{number}", number=number,
            url=f"https://github.com/acme/payments/issues/{number}",
        )

    gateway.create = rate_limited_create

    app.dependency_overrides[get_github_gateway] = lambda: gateway
    client = TestClient(app)
    try:
        _setup_mapping(client, ids["project_id"])
        _dispose()
        response = client.post(
            f"/projects/{ids['project_id']}/publish/github", json={"item_ids": [ids["epic_id"]]}
        )
    finally:
        app.dependency_overrides.pop(get_github_gateway, None)
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
    assert event.entityType == "github"
    assert event.metadata_ == {"status_code": 429, "wait_seconds": 1.5, "retry_count": 1}

    asyncio.run(_cleanup(ids))

    asyncio.run(_cleanup(ids))
