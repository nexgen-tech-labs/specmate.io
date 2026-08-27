"""Org-level Jira/GitHub connection resolution (Onboarding Flow redesign) —
mirrors test_jira_connection_resolution.py's shape, scoped to Organization
instead of Workspace. Covers the org-vs-workspace dispatch added to
resolve_jira_connection/resolve_github_connection, not the refresh/retry
mechanics themselves (already covered per-tool for the workspace-scoped path)."""
from __future__ import annotations

import asyncio
import json
import time
from datetime import UTC, datetime, timedelta
from unittest.mock import patch

from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.core.config import settings
from app.models import Connection, Organization
from app.services.connectors.github_auth import OAuthTokenConnection, resolve_github_connection
from app.services.connectors.jira_auth import CloudTokenConnection, JiraOAuthConnection, resolve_jira_connection
from app.services.connectors.types import ConnectorError
from app.services.crypto import encrypt_credentials

_TEST_DEK_B64 = "MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA="


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


async def _create_organization_async() -> str:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            org = Organization(name="Org Auth Test Org", createdAt=_now(), updatedAt=_now())
            session.add(org)
            await session.flush()
            org_id = org.id
            await session.commit()
            return org_id
    finally:
        await engine.dispose()


def _create_organization() -> str:
    return asyncio.run(_create_organization_async())


async def _cleanup_async(organization_id: str) -> None:
    from sqlalchemy import delete

    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            await session.execute(
                delete(Connection).where(Connection.organizationId == organization_id)
            )
            await session.execute(delete(Organization).where(Organization.id == organization_id))
            await session.commit()
    finally:
        await engine.dispose()


def _cleanup(organization_id: str) -> None:
    asyncio.run(_cleanup_async(organization_id))


async def _add_org_connection_async(
    organization_id: str,
    tool_key: str,
    encrypted_plaintext: str | None,
    cloud_id: str | None,
) -> None:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            now = _now()
            with patch.object(settings, "connector_dek_b64", _TEST_DEK_B64):
                encrypted = encrypt_credentials(encrypted_plaintext) if encrypted_plaintext else None
            session.add(
                Connection(
                    organizationId=organization_id,
                    toolKey=tool_key,
                    authMethod="OAUTH",
                    encryptedCredentials=encrypted,
                    scope={"cloud_id": cloud_id} if cloud_id else None,
                    createdAt=now,
                    updatedAt=now,
                )
            )
            await session.commit()
    finally:
        await engine.dispose()


def _add_org_jira_connection(organization_id: str, tokens: dict[str, object], cloud_id: str) -> None:
    asyncio.run(_add_org_connection_async(organization_id, "jira", json.dumps(tokens), cloud_id))


def _add_org_github_connection(organization_id: str, token: str) -> None:
    asyncio.run(_add_org_connection_async(organization_id, "github", token, None))


async def _resolve_jira_org_async(organization_id: str) -> object:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            return await resolve_jira_connection(session, organization_id=organization_id)
    finally:
        await engine.dispose()


def _resolve_jira_org(organization_id: str) -> object:
    return asyncio.run(_resolve_jira_org_async(organization_id))


async def _resolve_github_org_async(organization_id: str) -> object:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            return await resolve_github_connection(session, organization_id=organization_id)
    finally:
        await engine.dispose()


def _resolve_github_org(organization_id: str) -> object:
    return asyncio.run(_resolve_github_org_async(organization_id))


def test_resolve_jira_connection_rejects_both_workspace_and_organization() -> None:
    async def _call() -> None:
        engine = create_async_engine(settings.database_url)
        try:
            async with AsyncSession(engine) as session:
                await resolve_jira_connection(session, "ws-1", organization_id="org-1")
        finally:
            await engine.dispose()

    try:
        asyncio.run(_call())
        raise AssertionError("expected ValueError")
    except ValueError as exc:
        assert "exactly one" in str(exc)


def test_resolve_jira_connection_rejects_neither_workspace_nor_organization() -> None:
    async def _call() -> None:
        engine = create_async_engine(settings.database_url)
        try:
            async with AsyncSession(engine) as session:
                await resolve_jira_connection(session)
        finally:
            await engine.dispose()

    try:
        asyncio.run(_call())
        raise AssertionError("expected ValueError")
    except ValueError as exc:
        assert "exactly one" in str(exc)


def test_resolve_jira_connection_at_org_scope_returns_oauth_connection() -> None:
    organization_id = _create_organization()
    try:
        future_expiry = time.time() + timedelta(hours=1).total_seconds()
        _add_org_jira_connection(
            organization_id,
            tokens={"access_token": "org-token", "refresh_token": "refresh-1", "expires_at": future_expiry},
            cloud_id="org-cloud-id",
        )
        with patch.object(settings, "connector_dek_b64", _TEST_DEK_B64):
            connection = _resolve_jira_org(organization_id)
        assert isinstance(connection, JiraOAuthConnection)
        assert connection.access_token == "org-token"
        assert connection.cloud_id == "org-cloud-id"
    finally:
        _cleanup(organization_id)


def test_resolve_jira_connection_at_org_scope_with_no_row_raises_no_env_fallback() -> None:
    # Unlike the workspace-scoped path, an org-level lookup with no Connection
    # row must NOT silently fall back to single-tenant env config — env config
    # has no notion of "organization", so falling back would attribute the
    # wrong org's requests to whatever happens to be configured process-wide.
    organization_id = _create_organization()
    try:
        with (
            patch.object(settings, "jira_base_url", "https://example.atlassian.net"),
            patch.object(settings, "atlassian_email", "bot@example.com"),
            patch.object(settings, "atlassian_api_token", "env-token"),
        ):
            try:
                _resolve_jira_org(organization_id)
                raise AssertionError("expected ConnectorError")
            except ConnectorError as exc:
                assert "authorize Jira at the org level" in str(exc)
    finally:
        _cleanup(organization_id)


def test_resolve_github_connection_at_org_scope_returns_oauth_connection() -> None:
    organization_id = _create_organization()
    try:
        _add_org_github_connection(organization_id, token="org-github-token")
        with patch.object(settings, "connector_dek_b64", _TEST_DEK_B64):
            connection = _resolve_github_org(organization_id)
        assert isinstance(connection, OAuthTokenConnection)
        assert connection.token == "org-github-token"
    finally:
        _cleanup(organization_id)


def test_resolve_github_connection_at_org_scope_with_no_row_raises_no_env_fallback() -> None:
    organization_id = _create_organization()
    try:
        with patch.object(settings, "github_token", "env-github-token"):
            try:
                _resolve_github_org(organization_id)
                raise AssertionError("expected ConnectorError")
            except ConnectorError as exc:
                assert "authorize GitHub at the org level" in str(exc)
    finally:
        _cleanup(organization_id)


def test_resolve_jira_connection_at_workspace_scope_still_works_unchanged() -> None:
    # Regression guard: the signature extension must not disturb the existing
    # positional-workspace_id call shape every current caller uses.
    async def _call() -> object:
        engine = create_async_engine(settings.database_url)
        try:
            async with AsyncSession(engine) as session:
                with (
                    patch.object(settings, "jira_base_url", "https://example.atlassian.net"),
                    patch.object(settings, "atlassian_email", "bot@example.com"),
                    patch.object(settings, "atlassian_api_token", "env-token"),
                ):
                    return await resolve_jira_connection(session, "nonexistent-workspace-id")
        finally:
            await engine.dispose()

    connection = asyncio.run(_call())
    assert isinstance(connection, CloudTokenConnection)
