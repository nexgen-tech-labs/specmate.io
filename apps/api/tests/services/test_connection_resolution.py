"""Per-workspace GitHub connection resolution (Issue #101 Task 6) — real Postgres,
same sync-test + asyncio.run pattern as test_github_oauth.py, for the same
event-loop reasons documented there."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from unittest.mock import patch

from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.core.config import settings
from app.models import Connection, GitHubAppInstall, Workspace
from app.services.connectors.github_app_auth import InstallationTokenConnection
from app.services.connectors.github_auth import OAuthTokenConnection, TokenConnection, resolve_github_connection
from app.services.crypto import encrypt_credentials

_TEST_DEK_B64 = "MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA="


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


async def _create_workspace_async() -> str:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            workspace = Workspace(name="Resolution Test WS", createdAt=_now(), updatedAt=_now())
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


async def _add_connection_async(workspace_id: str, auth_method: str, token: str | None) -> None:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            now = _now()
            with patch.object(settings, "connector_dek_b64", _TEST_DEK_B64):
                encrypted = encrypt_credentials(token) if token else None
            session.add(
                Connection(
                    workspaceId=workspace_id,
                    toolKey="github",
                    authMethod=auth_method,
                    encryptedCredentials=encrypted,
                    createdAt=now,
                    updatedAt=now,
                )
            )
            await session.commit()
    finally:
        await engine.dispose()


def _add_connection(workspace_id: str, auth_method: str, token: str | None = None) -> None:
    asyncio.run(_add_connection_async(workspace_id, auth_method, token))


async def _resolve_async(workspace_id: str) -> object:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            return await resolve_github_connection(session, workspace_id)
    finally:
        await engine.dispose()


def _resolve(workspace_id: str) -> object:
    return asyncio.run(_resolve_async(workspace_id))


def test_resolve_with_no_connection_row_falls_back_to_env_configured() -> None:
    workspace_id = _create_workspace()
    try:
        with patch.object(settings, "github_token", "env-configured-token"):
            connection = _resolve(workspace_id)
        assert isinstance(connection, TokenConnection)
        assert connection.token == "env-configured-token"
    finally:
        _cleanup(workspace_id)


def test_resolve_with_explicit_env_configured_row_falls_back_to_env_configured() -> None:
    workspace_id = _create_workspace()
    try:
        _add_connection(workspace_id, auth_method="ENV_CONFIGURED")
        with patch.object(settings, "github_token", "env-configured-token"):
            connection = _resolve(workspace_id)
        assert isinstance(connection, TokenConnection)
        assert connection.token == "env-configured-token"
    finally:
        _cleanup(workspace_id)


def test_resolve_with_oauth_connection_row_returns_decrypted_oauth_token() -> None:
    workspace_id = _create_workspace()
    try:
        _add_connection(workspace_id, auth_method="OAUTH", token="gho_realWorkspaceToken")
        with patch.object(settings, "connector_dek_b64", _TEST_DEK_B64):
            connection = _resolve(workspace_id)
        assert isinstance(connection, OAuthTokenConnection)
        assert connection.token == "gho_realWorkspaceToken"
    finally:
        _cleanup(workspace_id)


async def _add_github_app_install_async(workspace_id: str, installation_id: int) -> None:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            now = _now()
            session.add(
                GitHubAppInstall(
                    installationId=installation_id,
                    accountLogin="acme-corp",
                    accountType="Organization",
                    repositorySelection="all",
                    workspaceId=workspace_id,
                    claimedAt=now,
                    installedAt=now,
                    createdAt=now,
                    updatedAt=now,
                )
            )
            await session.commit()
    finally:
        await engine.dispose()


def _add_github_app_install(workspace_id: str, installation_id: int) -> None:
    asyncio.run(_add_github_app_install_async(workspace_id, installation_id))


def test_resolve_prefers_claimed_github_app_install_over_oauth_and_env() -> None:
    """Issue 10.3: a workspace that installed SpecMate from the GitHub
    Marketplace and claimed the install must resolve to that installation
    token, even when a (now-stale) OAuth Connection row also exists —
    App-install auth takes priority, mirroring Jira Connect's priority over
    its own OAuth/env-configured paths."""
    from unittest.mock import AsyncMock, patch as mock_patch

    workspace_id = _create_workspace()
    try:
        _add_connection(workspace_id, auth_method="OAUTH", token="gho_staleWorkspaceToken")
        _add_github_app_install(workspace_id, installation_id=42424242)

        mint_mock = AsyncMock(return_value=("ghs_installationToken", 9999999999.0))
        with (
            patch.object(settings, "connector_dek_b64", _TEST_DEK_B64),
            mock_patch(
                "app.services.connectors.github_app_auth.mint_installation_token", mint_mock
            ),
        ):
            connection = _resolve(workspace_id)
        assert isinstance(connection, InstallationTokenConnection)
        assert connection.installation_id == 42424242
        assert connection.token == "ghs_installationToken"
    finally:
        asyncio.run(_cleanup_github_app_install_async(workspace_id))
        _cleanup(workspace_id)


async def _cleanup_github_app_install_async(workspace_id: str) -> None:
    from sqlalchemy import delete

    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            await session.execute(
                delete(GitHubAppInstall).where(GitHubAppInstall.workspaceId == workspace_id)
            )
            await session.commit()
    finally:
        await engine.dispose()


def test_resolve_falls_through_to_oauth_when_no_claimed_install_exists() -> None:
    workspace_id = _create_workspace()
    try:
        _add_connection(workspace_id, auth_method="OAUTH", token="gho_realWorkspaceToken")
        with patch.object(settings, "connector_dek_b64", _TEST_DEK_B64):
            connection = _resolve(workspace_id)
        assert isinstance(connection, OAuthTokenConnection)
    finally:
        _cleanup(workspace_id)


def test_resolve_ignores_uninstalled_github_app_install() -> None:
    workspace_id = _create_workspace()
    try:
        _add_github_app_install(workspace_id, installation_id=55555555)

        async def _mark_uninstalled() -> None:
            engine = create_async_engine(settings.database_url)
            try:
                async with AsyncSession(engine) as session:
                    from sqlalchemy import select

                    row = (
                        await session.execute(
                            select(GitHubAppInstall).where(
                                GitHubAppInstall.workspaceId == workspace_id
                            )
                        )
                    ).scalar_one()
                    row.uninstalledAt = _now()
                    await session.commit()
            finally:
                await engine.dispose()

        asyncio.run(_mark_uninstalled())

        with patch.object(settings, "github_token", "env-configured-token"):
            connection = _resolve(workspace_id)
        assert isinstance(connection, TokenConnection)
    finally:
        asyncio.run(_cleanup_github_app_install_async(workspace_id))
        _cleanup(workspace_id)
