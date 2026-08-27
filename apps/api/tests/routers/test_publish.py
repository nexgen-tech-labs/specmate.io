"""Epic 5 publish tests — real Postgres, fake Jira gateway via dependency override
(sync tests + asyncio.run per the event-loop notes in test_sources.py)."""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from unittest.mock import patch

from fastapi.testclient import TestClient
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.core import db as db_module
from app.core.config import settings
from app.core.db import get_db_session
from app.main import app
from app.models import (
    AuditEvent,
    Connection,
    DraftItem,
    Project,
    PublishedItem,
    PublishMapping,
    TraceLink,
    UsagePeriod,
    Workspace,
)
from app.routers.publish import PublishGateway, get_publish_gateway
from app.services.connectors.jira_auth import CloudTokenConnection, JiraOAuthConnection
from app.services.connectors.jira_publish import PublishCandidate, PublishOutcome
from app.services.crypto import encrypt_credentials
from tests.audit_cleanup import purge_audit_events

_TEST_DEK_B64 = "MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA="

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

        async def fake_connection(_session: object, _workspace_id: str) -> CloudTokenConnection:
            return CloudTokenConnection("e", "t", "https://x")

        return PublishGateway(
            connection=fake_connection,
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
            # Issue 12.5: publish now inline-meters usage, which upserts a UsagePeriod
            # row for the workspace — must be cleared before the workspace FK delete.
            await session.execute(
                delete(UsagePeriod).where(UsagePeriod.workspaceId == ids["workspace_id"])
            )
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
    # A preceding test file's asyncio.run()-scoped loop can leave the shared
    # app engine's pool holding a connection bound to an already-closed loop
    # (asyncpg cross-loop check -> "Event loop is closed") — dispose first,
    # matching the pattern already established in test_org_connectors.py.
    _dispose()
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


def test_publish_commits_before_calling_gateway_create() -> None:
    """Issue #106: gateway.create's internal retry-with-backoff loop (Issue #89)
    must not run while the router's session has an open transaction — verify
    directly by having the fake create() callback inspect the real session's
    in_transaction() state, via a get_db_session override that captures the
    actual session instance the router is using."""
    ids = asyncio.run(_fixture())
    fake = _FakeJira()
    captured_session: list[AsyncSession] = []
    in_transaction_during_create: list[bool] = []

    async def capturing_get_db_session():
        async with db_module.async_session_factory() as session:
            captured_session.append(session)
            yield session

    original_gateway = fake.gateway

    def gateway_with_probe() -> PublishGateway:
        gw = original_gateway()

        async def probing_create(*args: object, **kwargs: object) -> PublishOutcome:
            assert captured_session, "session should have been captured before create() runs"
            in_transaction_during_create.append(captured_session[-1].in_transaction())
            return await gw.create(*args, **kwargs)  # type: ignore[misc]

        return PublishGateway(
            connection=gw.connection,
            projects=gw.projects,
            meta=gw.meta,
            create=probing_create,
            update=gw.update,
            health=gw.health,
            transport=gw.transport,
        )

    app.dependency_overrides[get_publish_gateway] = gateway_with_probe
    app.dependency_overrides[get_db_session] = capturing_get_db_session
    client = TestClient(app)
    try:
        _setup_mapping(client, ids["project_id"])
        _dispose()
        response = client.post(
            f"/projects/{ids['project_id']}/publish/jira",
            json={"item_ids": [ids["epic_id"]]},
        )
    finally:
        app.dependency_overrides.pop(get_publish_gateway, None)
        app.dependency_overrides.pop(get_db_session, None)
        _dispose()

    assert response.status_code == 200
    assert in_transaction_during_create == [False]

    asyncio.run(_cleanup(ids))


def test_publish_succeeds_even_when_stripe_is_not_configured() -> None:
    """Issue 12.5: publish now inline-reports usage to Stripe after a successful
    publish. Pinned explicitly (Issue #110) rather than relying on
    STRIPE_SECRET_KEY being ambiently absent from the test env — the inline
    report hits BillingNotConfiguredError internally, and this locks in that
    the publish request still succeeds (200, PublishedItem created) despite
    that, regardless of what a local .env might otherwise leak into the test
    process. settings.stripe_secret_key (not the raw env var) is what
    stripe_reporting.py actually reads (Issue #110's Settings migration), so
    it's patched directly rather than via monkeypatch.delenv."""
    ids = asyncio.run(_fixture())
    fake = _FakeJira()
    app.dependency_overrides[get_publish_gateway] = fake.gateway
    client = TestClient(app)
    try:
        _setup_mapping(client, ids["project_id"])
        _dispose()
        with patch.object(settings, "stripe_secret_key", ""):
            response = client.post(
                f"/projects/{ids['project_id']}/publish/jira",
                json={"item_ids": [ids["epic_id"]]},
            )
    finally:
        app.dependency_overrides.pop(get_publish_gateway, None)
        _dispose()

    assert response.status_code == 200
    body = response.json()
    assert body["succeeded"] == 1 and body["failed"] == 0

    async def check_published() -> int:
        engine = create_async_engine(settings.database_url)
        try:
            async with AsyncSession(engine) as session:
                rows = (
                    await session.execute(
                        select(PublishedItem).where(PublishedItem.draftItemId == ids["epic_id"])
                    )
                ).scalars().all()
                return len(rows)
        finally:
            await engine.dispose()

    assert asyncio.run(check_published()) == 1

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


async def _add_oauth_connection(workspace_id: str) -> None:
    """Stores a live (unexpired) Jira OAuth Connection row for a workspace —
    mirrors test_jira_connection_resolution.py's fixture shape."""
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            now = _now()
            tokens = {
                "access_token": "oauth-access-token",
                "refresh_token": "oauth-refresh-token",
                "expires_at": time.time() + 3600,
            }
            with patch.object(settings, "connector_dek_b64", _TEST_DEK_B64):
                encrypted = encrypt_credentials(json.dumps(tokens))
            session.add(
                Connection(
                    workspaceId=workspace_id,
                    toolKey="jira",
                    authMethod="OAUTH",
                    encryptedCredentials=encrypted,
                    scope={"cloud_id": "cloud-id-abc"},
                    createdAt=now,
                    updatedAt=now,
                )
            )
            await session.commit()
    finally:
        await engine.dispose()


async def _cleanup_connection(workspace_id: str) -> None:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            await session.execute(delete(Connection).where(Connection.workspaceId == workspace_id))
            await session.commit()
    finally:
        await engine.dispose()


def test_publish_with_stored_oauth_connection_uses_workspace_oauth_token() -> None:
    """Fast-follow to #101 Task 4: a workspace with a stored Jira OAuth Connection
    row publishes using resolve_jira_connection's OAuth path (not the env-configured
    CloudTokenConnection) — proven by the fake create() callback receiving a
    JiraOAuthConnection instance built from the stored, decrypted tokens."""
    ids = asyncio.run(_fixture())
    asyncio.run(_add_oauth_connection(ids["workspace_id"]))

    fake = _FakeJira()
    seen_connections: list[object] = []
    original_gateway = fake.gateway

    def gateway_with_connection_capture() -> PublishGateway:
        gw = original_gateway()

        async def capturing_create(conn: object, *args: object, **kwargs: object) -> PublishOutcome:
            seen_connections.append(conn)
            return await gw.create(conn, *args, **kwargs)  # type: ignore[misc]

        # Use the real connection resolver (not the fake's) so this test proves
        # resolve_jira_connection's OAuth path actually gets wired through.
        from app.routers.publish import _resolve_connection

        return PublishGateway(
            connection=_resolve_connection,
            projects=gw.projects,
            meta=gw.meta,
            create=capturing_create,
            update=gw.update,
            health=gw.health,
        )

    app.dependency_overrides[get_publish_gateway] = gateway_with_connection_capture
    client = TestClient(app)
    try:
        with patch.object(settings, "connector_dek_b64", _TEST_DEK_B64):
            _setup_mapping(client, ids["project_id"])
            _dispose()
            response = client.post(
                f"/projects/{ids['project_id']}/publish/jira", json={"item_ids": [ids["epic_id"]]}
            )
    finally:
        app.dependency_overrides.pop(get_publish_gateway, None)
        _dispose()

    assert response.status_code == 200
    assert response.json()["succeeded"] == 1
    assert len(seen_connections) == 1
    connection = seen_connections[0]
    assert isinstance(connection, JiraOAuthConnection)
    assert connection.access_token == "oauth-access-token"
    assert connection.cloud_id == "cloud-id-abc"

    asyncio.run(_cleanup_connection(ids["workspace_id"]))
    asyncio.run(_cleanup(ids))


def test_publish_with_no_connection_row_keeps_env_configured_fallback() -> None:
    """Critical regression guard (fast-follow to #101 Task 4): every existing
    production Jira-publishing workspace has no Connection row today. Confirms
    resolve_jira_connection's env-configured fallback (CloudTokenConnection) is
    still what gets used when no OAuth Connection row exists — the pre-existing
    single-tenant publish path must be completely unaffected."""
    ids = asyncio.run(_fixture())
    # Deliberately no Connection row added for this workspace.

    fake = _FakeJira()
    seen_connections: list[object] = []
    original_gateway = fake.gateway

    def gateway_with_connection_capture() -> PublishGateway:
        gw = original_gateway()

        async def capturing_create(conn: object, *args: object, **kwargs: object) -> PublishOutcome:
            seen_connections.append(conn)
            return await gw.create(conn, *args, **kwargs)  # type: ignore[misc]

        from app.routers.publish import _resolve_connection

        return PublishGateway(
            connection=_resolve_connection,
            projects=gw.projects,
            meta=gw.meta,
            create=capturing_create,
            update=gw.update,
            health=gw.health,
        )

    app.dependency_overrides[get_publish_gateway] = gateway_with_connection_capture
    client = TestClient(app)
    try:
        with (
            patch.object(settings, "jira_base_url", "https://example.atlassian.net"),
            patch.object(settings, "atlassian_email", "bot@example.com"),
            patch.object(settings, "atlassian_api_token", "env-token"),
        ):
            _setup_mapping(client, ids["project_id"])
            _dispose()
            response = client.post(
                f"/projects/{ids['project_id']}/publish/jira", json={"item_ids": [ids["epic_id"]]}
            )
    finally:
        app.dependency_overrides.pop(get_publish_gateway, None)
        _dispose()

    assert response.status_code == 200
    assert response.json()["succeeded"] == 1
    assert len(seen_connections) == 1
    connection = seen_connections[0]
    assert isinstance(connection, CloudTokenConnection)
    assert connection.url == "https://example.atlassian.net"

    asyncio.run(_cleanup(ids))
