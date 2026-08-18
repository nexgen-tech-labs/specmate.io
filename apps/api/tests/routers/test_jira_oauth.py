"""Router-level Jira OAuth tests (fast-follow to Issue #101) — real Postgres,
mocked token exchange/site-discovery, mirroring test_github_oauth.py's
sync-test + asyncio.run pattern exactly (same event-loop reasons documented
there). Jira-specific additions: encryptedCredentials is a JSON blob (not a
bare token string), Connection.scope carries cloud_id/cloud_url, and an
auto-select-first-site test locks in the confirmed multi-site design
decision."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, patch

import httpx
from fastapi.testclient import TestClient
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.core import db as db_module
from app.core.config import settings
from app.main import app
from app.models import Connection, Project, WizardSession, Workspace
from app.services.connectors.jira_auth import JiraOAuthTokens, JiraSite

_TEST_DEK_B64 = "MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA="


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _dispose_app_engine() -> None:
    asyncio.run(db_module.engine.dispose())


async def _create_wizard_session_async(expires_in_future: bool) -> dict[str, str]:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            workspace = Workspace(name="Jira OAuth Test WS", createdAt=_now(), updatedAt=_now())
            session.add(workspace)
            await session.flush()
            project = Project(
                workspaceId=workspace.id, name="Jira OAuth Test Project", createdAt=_now(), updatedAt=_now()
            )
            session.add(project)
            await session.flush()
            delta = timedelta(hours=1) if expires_in_future else -timedelta(hours=1)
            wizard_session = WizardSession(
                workspaceId=workspace.id,
                projectId=project.id,
                toolKey="jira",
                currentStep="authenticate",
                collectedState={},
                createdAt=_now(),
                expiresAt=_now() + delta,
            )
            session.add(wizard_session)
            await session.flush()
            ids = {
                "workspace_id": workspace.id,
                "project_id": project.id,
                "wizard_session_id": wizard_session.id,
            }
            await session.commit()
            return ids
    finally:
        await engine.dispose()


def _create_wizard_session(expires_in_future: bool = True) -> dict[str, str]:
    return asyncio.run(_create_wizard_session_async(expires_in_future))


async def _cleanup_async(ids: dict[str, str]) -> None:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            await session.execute(delete(Connection).where(Connection.workspaceId == ids["workspace_id"]))
            await session.execute(
                delete(WizardSession).where(WizardSession.workspaceId == ids["workspace_id"])
            )
            await session.execute(delete(Project).where(Project.id == ids["project_id"]))
            await session.execute(delete(Workspace).where(Workspace.id == ids["workspace_id"]))
            await session.commit()
    finally:
        await engine.dispose()


def _cleanup(ids: dict[str, str]) -> None:
    asyncio.run(_cleanup_async(ids))


async def _get_connection_async(workspace_id: str) -> Connection | None:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            return (
                await session.execute(
                    select(Connection).where(
                        Connection.workspaceId == workspace_id, Connection.toolKey == "jira"
                    )
                )
            ).scalar_one_or_none()
    finally:
        await engine.dispose()


def _get_connection(workspace_id: str) -> Connection | None:
    return asyncio.run(_get_connection_async(workspace_id))


async def _count_connections_async(workspace_id: str) -> int:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            rows = (
                await session.execute(
                    select(Connection).where(
                        Connection.workspaceId == workspace_id, Connection.toolKey == "jira"
                    )
                )
            ).scalars().all()
            return len(rows)
    finally:
        await engine.dispose()


def _count_connections(workspace_id: str) -> int:
    return asyncio.run(_count_connections_async(workspace_id))


async def _get_wizard_session_async(wizard_session_id: str) -> WizardSession | None:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            return await session.get(WizardSession, wizard_session_id)
    finally:
        await engine.dispose()


def _get_wizard_session(wizard_session_id: str) -> WizardSession | None:
    return asyncio.run(_get_wizard_session_async(wizard_session_id))


_FAKE_TOKENS = JiraOAuthTokens(
    access_token="jira_realSecretAccessToken",
    refresh_token="jira_realSecretRefreshToken",
    expires_in=3600,
)
_ONE_SITE = [JiraSite(cloud_id="cloud-id-abc", url="https://acme.atlassian.net", name="Acme")]
_TWO_SITES = [
    JiraSite(cloud_id="cloud-id-first", url="https://first.atlassian.net", name="First"),
    JiraSite(cloud_id="cloud-id-second", url="https://second.atlassian.net", name="Second"),
]


def test_start_oauth_redirects_to_atlassian_with_expected_params() -> None:
    with patch.object(settings, "jira_oauth_app_client_id", "test-client-id"):
        client = TestClient(app, follow_redirects=False)
        res = client.get("/connectors/jira/oauth/start", params={"wizard_session_id": "abc123"})
        assert res.status_code in (302, 307)
        location = res.headers["location"]
        assert location.startswith("https://auth.atlassian.com/authorize?")
        assert "audience=api.atlassian.com" in location
        assert "client_id=test-client-id" in location
        assert "state=abc123" in location
        assert "scope=read%3Ajira-work+write%3Ajira-work+offline_access" in location


def test_start_oauth_returns_503_when_not_configured() -> None:
    with patch.object(settings, "jira_oauth_app_client_id", ""):
        client = TestClient(app, follow_redirects=False)
        res = client.get("/connectors/jira/oauth/start", params={"wizard_session_id": "abc123"})
        assert res.status_code == 503


def test_callback_with_valid_session_creates_encrypted_connection_and_advances_step() -> None:
    ids = _create_wizard_session()
    try:
        _dispose_app_engine()
        client = TestClient(app, follow_redirects=False)
        with (
            patch.object(settings, "jira_oauth_app_client_id", "test-client-id"),
            patch.object(settings, "jira_oauth_app_client_secret", "test-secret"),
            patch.object(settings, "connector_dek_b64", _TEST_DEK_B64),
            patch(
                "app.routers.jira_oauth.exchange_oauth_code_for_tokens",
                new=AsyncMock(return_value=_FAKE_TOKENS),
            ),
            patch(
                "app.routers.jira_oauth.discover_accessible_jira_sites",
                new=AsyncMock(return_value=_ONE_SITE),
            ),
        ):
            res = client.get(
                "/connectors/jira/oauth/callback",
                params={"code": "fake-code", "state": ids["wizard_session_id"]},
            )
        assert res.status_code in (302, 307)
        location = res.headers["location"]
        assert location.startswith(settings.web_base_url)
        assert f"/workspaces/{ids['workspace_id']}/projects/{ids['project_id']}/connect/jira" in location
        assert "oauth=success" in location

        _dispose_app_engine()
        conn = _get_connection(ids["workspace_id"])
        assert conn is not None
        assert conn.authMethod == "OAUTH"
        assert conn.scope == {"cloud_id": "cloud-id-abc", "cloud_url": "https://acme.atlassian.net"}
        assert conn.encryptedCredentials is not None
        # The raw token strings must never appear in the stored bytes.
        assert b"jira_realSecretAccessToken" not in conn.encryptedCredentials
        assert b"jira_realSecretRefreshToken" not in conn.encryptedCredentials

        ws = _get_wizard_session(ids["wizard_session_id"])
        assert ws is not None
        assert ws.currentStep == "select_scope"
    finally:
        _cleanup(ids)


def test_callback_auto_selects_first_site_when_multiple_are_accessible() -> None:
    ids = _create_wizard_session()
    try:
        _dispose_app_engine()
        client = TestClient(app, follow_redirects=False)
        with (
            patch.object(settings, "jira_oauth_app_client_id", "test-client-id"),
            patch.object(settings, "jira_oauth_app_client_secret", "test-secret"),
            patch.object(settings, "connector_dek_b64", _TEST_DEK_B64),
            patch(
                "app.routers.jira_oauth.exchange_oauth_code_for_tokens",
                new=AsyncMock(return_value=_FAKE_TOKENS),
            ),
            patch(
                "app.routers.jira_oauth.discover_accessible_jira_sites",
                new=AsyncMock(return_value=_TWO_SITES),
            ),
        ):
            res = client.get(
                "/connectors/jira/oauth/callback",
                params={"code": "fake-code", "state": ids["wizard_session_id"]},
            )
        assert res.status_code in (302, 307)

        _dispose_app_engine()
        conn = _get_connection(ids["workspace_id"])
        assert conn is not None
        assert conn.scope is not None
        assert conn.scope["cloud_id"] == _TWO_SITES[0].cloud_id
    finally:
        _cleanup(ids)


def test_callback_with_unknown_state_returns_404() -> None:
    client = TestClient(app)
    with (
        patch.object(settings, "jira_oauth_app_client_id", "test-client-id"),
        patch.object(settings, "jira_oauth_app_client_secret", "test-secret"),
    ):
        res = client.get(
            "/connectors/jira/oauth/callback",
            params={"code": "fake-code", "state": "nonexistent-session-id"},
        )
    assert res.status_code == 404


def test_callback_with_expired_session_returns_404() -> None:
    ids = _create_wizard_session(expires_in_future=False)
    try:
        _dispose_app_engine()
        client = TestClient(app)
        with (
            patch.object(settings, "jira_oauth_app_client_id", "test-client-id"),
            patch.object(settings, "jira_oauth_app_client_secret", "test-secret"),
        ):
            res = client.get(
                "/connectors/jira/oauth/callback",
                params={"code": "fake-code", "state": ids["wizard_session_id"]},
            )
        assert res.status_code == 404

        _dispose_app_engine()
        assert _get_connection(ids["workspace_id"]) is None
    finally:
        _cleanup(ids)


def test_callback_called_twice_updates_existing_connection_not_duplicate() -> None:
    ids = _create_wizard_session()
    try:
        with (
            patch.object(settings, "jira_oauth_app_client_id", "test-client-id"),
            patch.object(settings, "jira_oauth_app_client_secret", "test-secret"),
            patch.object(settings, "connector_dek_b64", _TEST_DEK_B64),
            patch(
                "app.routers.jira_oauth.exchange_oauth_code_for_tokens",
                new=AsyncMock(return_value=_FAKE_TOKENS),
            ),
            patch(
                "app.routers.jira_oauth.discover_accessible_jira_sites",
                new=AsyncMock(return_value=_ONE_SITE),
            ),
        ):
            _dispose_app_engine()
            res1 = TestClient(app, follow_redirects=False).get(
                "/connectors/jira/oauth/callback",
                params={"code": "fake-code-1", "state": ids["wizard_session_id"]},
            )
            assert res1.status_code in (302, 307)

            _dispose_app_engine()
            res2 = TestClient(app, follow_redirects=False).get(
                "/connectors/jira/oauth/callback",
                params={"code": "fake-code-2", "state": ids["wizard_session_id"]},
            )
            assert res2.status_code in (302, 307)

        _dispose_app_engine()
        assert _count_connections(ids["workspace_id"]) == 1
    finally:
        _cleanup(ids)


def test_callback_called_concurrently_results_in_exactly_one_connection() -> None:
    ids = _create_wizard_session()
    try:
        with (
            patch.object(settings, "jira_oauth_app_client_id", "test-client-id"),
            patch.object(settings, "jira_oauth_app_client_secret", "test-secret"),
            patch.object(settings, "connector_dek_b64", _TEST_DEK_B64),
            patch(
                "app.routers.jira_oauth.exchange_oauth_code_for_tokens",
                new=AsyncMock(return_value=_FAKE_TOKENS),
            ),
            patch(
                "app.routers.jira_oauth.discover_accessible_jira_sites",
                new=AsyncMock(return_value=_ONE_SITE),
            ),
        ):

            async def _fire_both() -> tuple[int, int]:
                async def _call(code: str) -> int:
                    async with httpx.AsyncClient(
                        transport=httpx.ASGITransport(app=app), base_url="http://test"
                    ) as ac:
                        res = await ac.get(
                            "/connectors/jira/oauth/callback",
                            params={"code": code, "state": ids["wizard_session_id"]},
                        )
                        return res.status_code

                return await asyncio.gather(_call("fake-code-1"), _call("fake-code-2"))

            _dispose_app_engine()
            status_codes = asyncio.run(_fire_both())

        assert status_codes[0] in (302, 307)
        assert status_codes[1] in (302, 307)

        _dispose_app_engine()
        assert _count_connections(ids["workspace_id"]) == 1
    finally:
        _cleanup(ids)
