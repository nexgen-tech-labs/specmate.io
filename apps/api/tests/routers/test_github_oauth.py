"""Router-level GitHub OAuth tests — real Postgres, mocked token exchange
(same sync-test + asyncio.run pattern as test_connectors.py, for the same
event-loop reasons documented there)."""

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


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _dispose_app_engine() -> None:
    asyncio.run(db_module.engine.dispose())


async def _create_wizard_session_async(expires_in_future: bool) -> dict[str, str]:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            workspace = Workspace(name="OAuth Test WS", createdAt=_now(), updatedAt=_now())
            session.add(workspace)
            await session.flush()
            project = Project(
                workspaceId=workspace.id, name="OAuth Test Project", createdAt=_now(), updatedAt=_now()
            )
            session.add(project)
            await session.flush()
            delta = timedelta(hours=1) if expires_in_future else -timedelta(hours=1)
            wizard_session = WizardSession(
                workspaceId=workspace.id,
                projectId=project.id,
                toolKey="github",
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
                        Connection.workspaceId == workspace_id, Connection.toolKey == "github"
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
                        Connection.workspaceId == workspace_id, Connection.toolKey == "github"
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


class _FakeTokenResponse:
    status_code = 200

    def json(self) -> dict[str, str]:
        return {"access_token": "gho_realSecretTokenValue", "token_type": "bearer", "scope": "repo"}

    def raise_for_status(self) -> None:
        pass


def test_start_oauth_redirects_to_github_with_expected_params() -> None:
    with patch.object(settings, "github_oauth_app_client_id", "test-client-id"):
        client = TestClient(app, follow_redirects=False)
        res = client.get("/connectors/github/oauth/start", params={"wizard_session_id": "abc123"})
        assert res.status_code in (302, 307)
        location = res.headers["location"]
        assert location.startswith("https://github.com/login/oauth/authorize?")
        assert "client_id=test-client-id" in location
        assert "state=abc123" in location
        assert "scope=repo" in location


def test_start_oauth_returns_503_when_not_configured() -> None:
    with patch.object(settings, "github_oauth_app_client_id", ""):
        client = TestClient(app, follow_redirects=False)
        res = client.get("/connectors/github/oauth/start", params={"wizard_session_id": "abc123"})
        assert res.status_code == 503


def test_callback_with_valid_session_creates_encrypted_connection_and_advances_step() -> None:
    ids = _create_wizard_session()
    try:
        _dispose_app_engine()
        client = TestClient(app)
        with (
            patch.object(settings, "github_oauth_app_client_id", "test-client-id"),
            patch.object(settings, "github_oauth_app_client_secret", "test-secret"),
            patch.object(settings, "connector_dek_b64", "MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA="),
            patch("httpx.AsyncClient.post", new=AsyncMock(return_value=_FakeTokenResponse())),
        ):
            res = client.get(
                "/connectors/github/oauth/callback",
                params={"code": "fake-code", "state": ids["wizard_session_id"]},
            )
        assert res.status_code == 200
        assert res.json()["status"] == "connected"

        _dispose_app_engine()
        conn = _get_connection(ids["workspace_id"])
        assert conn is not None
        assert conn.authMethod == "OAUTH"
        assert conn.encryptedCredentials is not None
        # The raw token must never appear in the stored bytes.
        assert b"gho_realSecretTokenValue" not in conn.encryptedCredentials

        ws = _get_wizard_session(ids["wizard_session_id"])
        assert ws is not None
        assert ws.currentStep == "select_scope"
    finally:
        _cleanup(ids)


def test_callback_with_unknown_state_returns_404() -> None:
    client = TestClient(app)
    with (
        patch.object(settings, "github_oauth_app_client_id", "test-client-id"),
        patch.object(settings, "github_oauth_app_client_secret", "test-secret"),
    ):
        res = client.get(
            "/connectors/github/oauth/callback",
            params={"code": "fake-code", "state": "nonexistent-session-id"},
        )
    assert res.status_code == 404


def test_callback_with_expired_session_returns_404() -> None:
    ids = _create_wizard_session(expires_in_future=False)
    try:
        _dispose_app_engine()
        client = TestClient(app)
        with (
            patch.object(settings, "github_oauth_app_client_id", "test-client-id"),
            patch.object(settings, "github_oauth_app_client_secret", "test-secret"),
        ):
            res = client.get(
                "/connectors/github/oauth/callback",
                params={"code": "fake-code", "state": ids["wizard_session_id"]},
            )
        assert res.status_code == 404

        _dispose_app_engine()
        assert _get_connection(ids["workspace_id"]) is None
    finally:
        _cleanup(ids)


def test_callback_called_concurrently_results_in_exactly_one_connection() -> None:
    ids = _create_wizard_session()
    try:
        with (
            patch.object(settings, "github_oauth_app_client_id", "test-client-id"),
            patch.object(settings, "github_oauth_app_client_secret", "test-secret"),
            patch.object(settings, "connector_dek_b64", "MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA="),
            patch("httpx.AsyncClient.post", new=AsyncMock(return_value=_FakeTokenResponse())),
        ):

            async def _fire_both() -> tuple[int, int]:
                async def _call(code: str) -> int:
                    async with httpx.AsyncClient(
                        transport=httpx.ASGITransport(app=app), base_url="http://test"
                    ) as ac:
                        res = await ac.get(
                            "/connectors/github/oauth/callback",
                            params={"code": code, "state": ids["wizard_session_id"]},
                        )
                        return res.status_code

                return await asyncio.gather(_call("fake-code-1"), _call("fake-code-2"))

            _dispose_app_engine()
            status_codes = asyncio.run(_fire_both())

        assert status_codes[0] == 200
        assert status_codes[1] == 200

        _dispose_app_engine()
        assert _count_connections(ids["workspace_id"]) == 1
    finally:
        _cleanup(ids)


def test_callback_called_twice_updates_existing_connection_not_duplicate() -> None:
    ids = _create_wizard_session()
    try:
        with (
            patch.object(settings, "github_oauth_app_client_id", "test-client-id"),
            patch.object(settings, "github_oauth_app_client_secret", "test-secret"),
            patch.object(settings, "connector_dek_b64", "MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA="),
            patch("httpx.AsyncClient.post", new=AsyncMock(return_value=_FakeTokenResponse())),
        ):
            _dispose_app_engine()
            res1 = TestClient(app).get(
                "/connectors/github/oauth/callback",
                params={"code": "fake-code-1", "state": ids["wizard_session_id"]},
            )
            assert res1.status_code == 200

            _dispose_app_engine()
            res2 = TestClient(app).get(
                "/connectors/github/oauth/callback",
                params={"code": "fake-code-2", "state": ids["wizard_session_id"]},
            )
            assert res2.status_code == 200

        _dispose_app_engine()
        assert _count_connections(ids["workspace_id"]) == 1
    finally:
        _cleanup(ids)
