"""Per-workspace Jira connection resolution (fast-follow to Issue #101) —
mirrors test_connection_resolution.py's GitHub-side test shape exactly."""
from __future__ import annotations

import asyncio
import json
import time
from datetime import UTC, datetime, timedelta
from unittest.mock import patch

from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.core.config import settings
from app.models import Connection, Workspace
from app.services.connectors.jira_auth import (
    CloudTokenConnection,
    JiraOAuthConnection,
    resolve_jira_connection,
)
from app.services.connectors.types import ConnectorError
from app.services.crypto import encrypt_credentials

_TEST_DEK_B64 = "MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA="


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


async def _create_workspace_async() -> str:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            workspace = Workspace(name="Jira Resolution Test WS", createdAt=_now(), updatedAt=_now())
            session.add(workspace)
            await session.flush()
            workspace_id = workspace.id
            await session.commit()
            return workspace_id
    finally:
        await engine.dispose()


def _create_workspace() -> str:
    return asyncio.run(_create_workspace_async())


async def _cleanup_async(workspace_id: str) -> None:
    from sqlalchemy import delete

    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            await session.execute(delete(Connection).where(Connection.workspaceId == workspace_id))
            await session.execute(delete(Workspace).where(Workspace.id == workspace_id))
            await session.commit()
    finally:
        await engine.dispose()


def _cleanup(workspace_id: str) -> None:
    asyncio.run(_cleanup_async(workspace_id))


async def _add_connection_async(
    workspace_id: str, auth_method: str, tokens: dict[str, object] | None, cloud_id: str | None
) -> None:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            now = _now()
            with patch.object(settings, "connector_dek_b64", _TEST_DEK_B64):
                encrypted = encrypt_credentials(json.dumps(tokens)) if tokens else None
            session.add(
                Connection(
                    workspaceId=workspace_id,
                    toolKey="jira",
                    authMethod=auth_method,
                    encryptedCredentials=encrypted,
                    scope={"cloud_id": cloud_id} if cloud_id else None,
                    createdAt=now,
                    updatedAt=now,
                )
            )
            await session.commit()
    finally:
        await engine.dispose()


def _add_connection(
    workspace_id: str, auth_method: str, tokens: dict[str, object] | None = None, cloud_id: str | None = None
) -> None:
    asyncio.run(_add_connection_async(workspace_id, auth_method, tokens, cloud_id))


async def _resolve_async(workspace_id: str) -> object:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            return await resolve_jira_connection(session, workspace_id)
    finally:
        await engine.dispose()


def _resolve(workspace_id: str) -> object:
    return asyncio.run(_resolve_async(workspace_id))


def test_resolve_with_no_connection_row_falls_back_to_env_configured() -> None:
    workspace_id = _create_workspace()
    try:
        with (
            patch.object(settings, "jira_base_url", "https://example.atlassian.net"),
            patch.object(settings, "atlassian_email", "bot@example.com"),
            patch.object(settings, "atlassian_api_token", "env-token"),
        ):
            connection = _resolve(workspace_id)
        assert isinstance(connection, CloudTokenConnection)
        assert connection.url == "https://example.atlassian.net"
    finally:
        _cleanup(workspace_id)


def test_resolve_with_oauth_connection_returns_unexpired_token_without_refreshing() -> None:
    workspace_id = _create_workspace()
    try:
        future_expiry = time.time() + timedelta(hours=1).total_seconds()
        _add_connection(
            workspace_id,
            auth_method="OAUTH",
            tokens={"access_token": "fresh-token", "refresh_token": "refresh-1", "expires_at": future_expiry},
            cloud_id="cloud-id-abc",
        )
        with patch.object(settings, "connector_dek_b64", _TEST_DEK_B64):
            connection = _resolve(workspace_id)
        assert isinstance(connection, JiraOAuthConnection)
        assert connection.access_token == "fresh-token"
        assert connection.cloud_id == "cloud-id-abc"
    finally:
        _cleanup(workspace_id)


def test_resolve_with_expired_oauth_connection_refreshes_and_persists_rotated_tokens() -> None:
    from unittest.mock import AsyncMock

    workspace_id = _create_workspace()
    try:
        past_expiry = time.time() - timedelta(minutes=5).total_seconds()
        _add_connection(
            workspace_id,
            auth_method="OAUTH",
            tokens={"access_token": "stale-token", "refresh_token": "refresh-1", "expires_at": past_expiry},
            cloud_id="cloud-id-abc",
        )
        from app.services.connectors.jira_auth import JiraOAuthTokens

        fresh_tokens = JiraOAuthTokens(access_token="rotated-token", refresh_token="refresh-2", expires_in=3600)
        with (
            patch.object(settings, "connector_dek_b64", _TEST_DEK_B64),
            patch(
                "app.services.connectors.jira_auth.refresh_jira_access_token",
                new=AsyncMock(return_value=fresh_tokens),
            ),
        ):
            connection = _resolve(workspace_id)
        assert isinstance(connection, JiraOAuthConnection)
        assert connection.access_token == "rotated-token"

        # Persisted: a second resolve (without mocking refresh) must NOT need
        # to refresh again, proving the rotated tokens were actually written back.
        async def _get_connection_async() -> Connection:
            engine = create_async_engine(settings.database_url)
            try:
                async with AsyncSession(engine) as session:
                    from sqlalchemy import select

                    return (
                        await session.execute(
                            select(Connection).where(Connection.workspaceId == workspace_id, Connection.toolKey == "jira")
                        )
                    ).scalar_one()
            finally:
                await engine.dispose()

        row = asyncio.run(_get_connection_async())
        with patch.object(settings, "connector_dek_b64", _TEST_DEK_B64):
            from app.services.crypto import decrypt_credentials

            persisted = json.loads(decrypt_credentials(row.encryptedCredentials))
        assert persisted["access_token"] == "rotated-token"
        assert persisted["refresh_token"] == "refresh-2"
    finally:
        _cleanup(workspace_id)


def test_resolve_recovers_when_a_concurrent_refresh_already_rotated_the_token() -> None:
    """Atlassian rotates the refresh token on every use — if a concurrent
    request already refreshed and persisted a new token by the time this
    call's own refresh attempt fails (using the now-stale refresh token), the
    resolver must re-read the row and use the concurrently-refreshed result
    instead of propagating a spurious error."""
    from unittest.mock import AsyncMock

    workspace_id = _create_workspace()
    try:
        past_expiry = time.time() - timedelta(minutes=5).total_seconds()
        _add_connection(
            workspace_id,
            auth_method="OAUTH",
            tokens={"access_token": "stale-token", "refresh_token": "refresh-1", "expires_at": past_expiry},
            cloud_id="cloud-id-abc",
        )

        async def _simulate_concurrent_refresh_then_fail(refresh_token: str) -> object:
            # Simulates: another request refreshed and persisted first, using
            # the same refresh_token this call is about to try — so by the
            # time THIS call's refresh attempt reaches Atlassian, the token
            # has already been rotated out from under it. Updates the
            # existing row in place (a real concurrent resolve_jira_connection
            # call would UPDATE, not INSERT a second row for the same
            # workspace/toolKey — that's the @@unique constraint's job).
            engine = create_async_engine(settings.database_url)
            try:
                async with AsyncSession(engine) as inner_session:
                    from sqlalchemy import select as _select

                    row = (
                        await inner_session.execute(
                            _select(Connection).where(
                                Connection.workspaceId == workspace_id, Connection.toolKey == "jira"
                            )
                        )
                    ).scalar_one()
                    row.encryptedCredentials = encrypt_credentials(
                        json.dumps(
                            {
                                "access_token": "concurrently-rotated-token",
                                "refresh_token": "refresh-2",
                                "expires_at": time.time() + 3600,
                            }
                        )
                    )
                    await inner_session.commit()
            finally:
                await engine.dispose()
            raise ConnectorError("refresh_token is invalid — already used")

        with (
            patch.object(settings, "connector_dek_b64", _TEST_DEK_B64),
            patch(
                "app.services.connectors.jira_auth.refresh_jira_access_token",
                new=AsyncMock(side_effect=_simulate_concurrent_refresh_then_fail),
            ),
        ):
            connection = _resolve(workspace_id)

        assert isinstance(connection, JiraOAuthConnection)
        assert connection.access_token == "concurrently-rotated-token"
    finally:
        _cleanup(workspace_id)


def test_resolve_propagates_a_genuine_refresh_failure_not_caused_by_a_race() -> None:
    """If refresh_jira_access_token fails and the row genuinely was NOT
    refreshed by anyone else (e.g. the user actually revoked access), the
    error must propagate — not be silently swallowed."""
    from unittest.mock import AsyncMock

    workspace_id = _create_workspace()
    try:
        past_expiry = time.time() - timedelta(minutes=5).total_seconds()
        _add_connection(
            workspace_id,
            auth_method="OAUTH",
            tokens={"access_token": "stale-token", "refresh_token": "refresh-1", "expires_at": past_expiry},
            cloud_id="cloud-id-abc",
        )

        with (
            patch.object(settings, "connector_dek_b64", _TEST_DEK_B64),
            patch(
                "app.services.connectors.jira_auth.refresh_jira_access_token",
                new=AsyncMock(side_effect=ConnectorError("access has been revoked")),
            ),
        ):
            try:
                _resolve(workspace_id)
                raise AssertionError("expected ConnectorError to propagate")
            except ConnectorError as exc:
                assert "revoked" in str(exc)
    finally:
        _cleanup(workspace_id)
