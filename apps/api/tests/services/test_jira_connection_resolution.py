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
