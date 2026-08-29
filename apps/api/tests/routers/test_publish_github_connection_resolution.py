"""publish_github.py's _resolve_connection org-level fallback (Onboarding
Flow redesign regression guard) — mirrors publish.py's identical Jira fix,
tested at the unit level rather than through the full publish fixture
machinery since the fix is a straight mirror of the already fully
exercised Jira version (see test_publish.py's
test_publish_falls_back_to_org_level_connection_when_no_workspace_connection_exists)."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from unittest.mock import patch

from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.core.config import settings
from app.models import Connection, Organization, Workspace
from app.services.connectors.github_auth import OAuthTokenConnection
from app.services.crypto import encrypt_credentials

_TEST_DEK_B64 = "MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA="


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


async def _setup_async() -> tuple[str, str]:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            now = _now()
            org = Organization(name="GitHub Resolution Test Org", createdAt=now, updatedAt=now)
            session.add(org)
            await session.flush()
            org_id = org.id

            workspace = Workspace(
                name="GitHub Resolution Test WS",
                organizationId=org_id,
                createdAt=now,
                updatedAt=now,
            )
            session.add(workspace)
            await session.flush()
            workspace_id = workspace.id

            with patch.object(settings, "connector_dek_b64", _TEST_DEK_B64):
                encrypted = encrypt_credentials("org-github-token")
            session.add(
                Connection(
                    organizationId=org_id,
                    toolKey="github",
                    authMethod="OAUTH",
                    encryptedCredentials=encrypted,
                    scope={},
                    createdAt=now,
                    updatedAt=now,
                )
            )
            await session.commit()
            return workspace_id, org_id
    finally:
        await engine.dispose()


async def _cleanup_async(workspace_id: str, organization_id: str) -> None:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            await session.execute(
                delete(Connection).where(Connection.organizationId == organization_id)
            )
            await session.execute(delete(Workspace).where(Workspace.id == workspace_id))
            await session.execute(delete(Organization).where(Organization.id == organization_id))
            await session.commit()
    finally:
        await engine.dispose()


def test_resolve_connection_falls_back_to_org_level_when_no_workspace_connection() -> None:
    """A workspace with no workspace-scoped GitHub Connection, but whose
    organization authorized GitHub via the org-level Connect flow, must
    resolve to that org-level OAuth connection — not fall through to the
    (likely unconfigured) single-tenant env fallback."""
    workspace_id, organization_id = asyncio.run(_setup_async())
    try:
        from app.routers.publish_github import _resolve_connection

        async def run() -> object:
            engine = create_async_engine(settings.database_url)
            try:
                async with AsyncSession(engine) as session:
                    with patch.object(settings, "connector_dek_b64", _TEST_DEK_B64):
                        return await _resolve_connection(session, workspace_id)
            finally:
                await engine.dispose()

        connection = asyncio.run(run())
        assert isinstance(connection, OAuthTokenConnection)
        assert connection.token == "org-github-token"
    finally:
        asyncio.run(_cleanup_async(workspace_id, organization_id))
