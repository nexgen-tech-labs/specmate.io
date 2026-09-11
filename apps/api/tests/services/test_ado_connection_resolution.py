"""Per-workspace ADO connection resolution (Issue 10.4) — mirrors
test_jira_connection_resolution.py's test shape exactly."""
from __future__ import annotations

import asyncio
import json
import time
from datetime import UTC, datetime, timedelta
from unittest.mock import patch

from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.core.config import settings
from app.models import Connection, Workspace
from app.services.connectors.ado_auth import (
    DelegatedOAuthConnection,
    PatConnection,
    resolve_ado_connection,
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
            workspace = Workspace(name="ADO Resolution Test WS", createdAt=_now(), updatedAt=_now())
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
    workspace_id: str, auth_method: str, tokens: dict[str, object] | None, org_url: str | None
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
                    toolKey="ado",
                    authMethod=auth_method,
                    encryptedCredentials=encrypted,
                    scope={"org_url": org_url} if org_url else None,
                    createdAt=now,
                    updatedAt=now,
                )
            )
            await session.commit()
    finally:
        await engine.dispose()


def _add_connection(
    workspace_id: str, auth_method: str, tokens: dict[str, object] | None = None, org_url: str | None = None
) -> None:
    asyncio.run(_add_connection_async(workspace_id, auth_method, tokens, org_url))


async def _resolve_async(workspace_id: str) -> object:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            return await resolve_ado_connection(session, workspace_id)
    finally:
        await engine.dispose()


def _resolve(workspace_id: str) -> object:
    return asyncio.run(_resolve_async(workspace_id))


def test_resolve_with_no_connection_row_falls_back_to_env_configured() -> None:
    workspace_id = _create_workspace()
    try:
        with (
            patch.object(settings, "ado_org_url", "https://dev.azure.com/example"),
            patch.object(settings, "ado_pat", "env-pat"),
            patch.object(settings, "azure_ad_client_id", ""),
            patch.object(settings, "azure_ad_client_secret", ""),
            patch.object(settings, "azure_ad_tenant_id", ""),
        ):
            connection = _resolve(workspace_id)
        assert isinstance(connection, PatConnection)
        assert connection.url == "https://dev.azure.com/example"
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
            org_url="https://dev.azure.com/example",
        )
        with patch.object(settings, "connector_dek_b64", _TEST_DEK_B64):
            connection = _resolve(workspace_id)
        assert isinstance(connection, DelegatedOAuthConnection)
        assert connection.access_token == "fresh-token"
        assert connection.url == "https://dev.azure.com/example"
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
            org_url="https://dev.azure.com/example",
        )
        from app.services.connectors.ado_auth import AdoOAuthTokens

        fresh_tokens = AdoOAuthTokens(access_token="rotated-token", refresh_token="refresh-2", expires_in=3600)
        with (
            patch.object(settings, "connector_dek_b64", _TEST_DEK_B64),
            patch(
                "app.services.connectors.ado_auth.refresh_ado_access_token",
                new=AsyncMock(return_value=fresh_tokens),
            ),
        ):
            connection = _resolve(workspace_id)
        assert isinstance(connection, DelegatedOAuthConnection)
        assert connection.access_token == "rotated-token"

        async def _get_connection_async() -> Connection:
            engine = create_async_engine(settings.database_url)
            try:
                async with AsyncSession(engine) as session:
                    from sqlalchemy import select

                    return (
                        await session.execute(
                            select(Connection).where(
                                Connection.workspaceId == workspace_id, Connection.toolKey == "ado"
                            )
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
    from unittest.mock import AsyncMock

    workspace_id = _create_workspace()
    try:
        past_expiry = time.time() - timedelta(minutes=5).total_seconds()
        _add_connection(
            workspace_id,
            auth_method="OAUTH",
            tokens={"access_token": "stale-token", "refresh_token": "refresh-1", "expires_at": past_expiry},
            org_url="https://dev.azure.com/example",
        )

        async def _simulate_concurrent_refresh_then_fail(refresh_token: str) -> object:
            engine = create_async_engine(settings.database_url)
            try:
                async with AsyncSession(engine) as inner_session:
                    from sqlalchemy import select as _select

                    row = (
                        await inner_session.execute(
                            _select(Connection).where(
                                Connection.workspaceId == workspace_id, Connection.toolKey == "ado"
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
                "app.services.connectors.ado_auth.refresh_ado_access_token",
                new=AsyncMock(side_effect=_simulate_concurrent_refresh_then_fail),
            ),
        ):
            connection = _resolve(workspace_id)

        assert isinstance(connection, DelegatedOAuthConnection)
        assert connection.access_token == "concurrently-rotated-token"
    finally:
        _cleanup(workspace_id)


def test_resolve_propagates_a_genuine_refresh_failure_not_caused_by_a_race() -> None:
    from unittest.mock import AsyncMock

    workspace_id = _create_workspace()
    try:
        past_expiry = time.time() - timedelta(minutes=5).total_seconds()
        _add_connection(
            workspace_id,
            auth_method="OAUTH",
            tokens={"access_token": "stale-token", "refresh_token": "refresh-1", "expires_at": past_expiry},
            org_url="https://dev.azure.com/example",
        )

        with (
            patch.object(settings, "connector_dek_b64", _TEST_DEK_B64),
            patch(
                "app.services.connectors.ado_auth.refresh_ado_access_token",
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
