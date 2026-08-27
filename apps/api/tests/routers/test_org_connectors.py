"""OrgWizardSession + scope-discovery router tests — mirrors
test_wizard_sessions.py's shape at organization scope, plus the scope-options
endpoint (org-level analogue of test_connection's discovery call)."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.core import db as db_module
from app.core.config import settings
from app.main import app
from app.models import Connection, Organization, OrgWizardSession


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _dispose_app_engine() -> None:
    asyncio.run(db_module.engine.dispose())


async def _create_organization_async() -> str:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            org = Organization(name="Org Connectors Test Org", createdAt=_now(), updatedAt=_now())
            session.add(org)
            await session.flush()
            org_id = org.id
            await session.commit()
            return org_id
    finally:
        await engine.dispose()


def _create_organization() -> str:
    return asyncio.run(_create_organization_async())


async def _create_session_row_async(
    organization_id: str, tool_key: str, expires_in_future: bool
) -> str:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            now = _now()
            delta = timedelta(hours=1) if expires_in_future else -timedelta(hours=1)
            ws = OrgWizardSession(
                organizationId=organization_id,
                toolKey=tool_key,
                currentStep="authenticate",
                collectedState={},
                createdAt=now,
                expiresAt=now + delta,
            )
            session.add(ws)
            await session.flush()
            wizard_session_id = ws.id
            await session.commit()
            return wizard_session_id
    finally:
        await engine.dispose()


def _create_session_row(
    organization_id: str, tool_key: str = "jira", expires_in_future: bool = True
) -> str:
    return asyncio.run(_create_session_row_async(organization_id, tool_key, expires_in_future))


async def _cleanup_async(organization_id: str) -> None:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            await session.execute(
                delete(OrgWizardSession).where(OrgWizardSession.organizationId == organization_id)
            )
            await session.execute(
                delete(Connection).where(Connection.organizationId == organization_id)
            )
            await session.execute(delete(Organization).where(Organization.id == organization_id))
            await session.commit()
    finally:
        await engine.dispose()


async def _create_connection_async(organization_id: str, tool_key: str) -> str:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            now = _now()
            conn = Connection(
                organizationId=organization_id,
                toolKey=tool_key,
                authMethod="OAUTH",
                createdAt=now,
                updatedAt=now,
            )
            session.add(conn)
            await session.flush()
            conn_id = conn.id
            await session.commit()
            return conn_id
    finally:
        await engine.dispose()


def _create_connection(organization_id: str, tool_key: str) -> str:
    return asyncio.run(_create_connection_async(organization_id, tool_key))


def _cleanup(organization_id: str) -> None:
    asyncio.run(_cleanup_async(organization_id))


def test_create_org_wizard_session_starts_at_authenticate_with_ttl() -> None:
    organization_id = _create_organization()
    try:
        _dispose_app_engine()
        client = TestClient(app)
        res = client.post(
            f"/organizations/{organization_id}/wizard-sessions", json={"tool_key": "jira"}
        )
        assert res.status_code == 200
        body = res.json()
        assert body["tool_key"] == "jira"
        assert body["current_step"] == "authenticate"
        assert body["collected_state"] == {}

        expires_at = datetime.fromisoformat(body["expires_at"])
        now = datetime.now(UTC) if expires_at.tzinfo else datetime.now(UTC).replace(tzinfo=None)
        delta = expires_at - now
        assert timedelta(minutes=55) < delta < timedelta(minutes=65)
    finally:
        _cleanup(organization_id)


def test_update_org_wizard_session_updates_step_and_collected_state() -> None:
    organization_id = _create_organization()
    try:
        wizard_session_id = _create_session_row(organization_id)
        _dispose_app_engine()
        client = TestClient(app)
        res = client.patch(
            f"/org-wizard-sessions/{wizard_session_id}",
            json={"current_step": "confirm", "collected_state": {"cloud_id": "abc"}},
        )
        assert res.status_code == 200
        body = res.json()
        assert body["current_step"] == "confirm"
        assert body["collected_state"] == {"cloud_id": "abc"}
    finally:
        _cleanup(organization_id)


def test_update_org_wizard_session_returns_404_if_expired() -> None:
    organization_id = _create_organization()
    try:
        wizard_session_id = _create_session_row(organization_id, expires_in_future=False)
        _dispose_app_engine()
        client = TestClient(app)
        res = client.patch(
            f"/org-wizard-sessions/{wizard_session_id}", json={"current_step": "confirm"}
        )
        assert res.status_code == 404
    finally:
        _cleanup(organization_id)


def test_resume_org_wizard_session_returns_most_recent_unexpired_session() -> None:
    organization_id = _create_organization()
    try:
        _create_session_row(organization_id, tool_key="jira")
        newest_id = _create_session_row(organization_id, tool_key="jira")
        _dispose_app_engine()
        client = TestClient(app)
        res = client.get(
            f"/organizations/{organization_id}/wizard-sessions/resume",
            params={"tool_key": "jira"},
        )
        assert res.status_code == 200
        assert res.json()["id"] == newest_id
    finally:
        _cleanup(organization_id)


def test_resume_org_wizard_session_returns_404_when_none_active() -> None:
    organization_id = _create_organization()
    try:
        _dispose_app_engine()
        client = TestClient(app)
        res = client.get(
            f"/organizations/{organization_id}/wizard-sessions/resume",
            params={"tool_key": "jira"},
        )
        assert res.status_code == 404
    finally:
        _cleanup(organization_id)


def test_resume_org_wizard_session_ignores_different_tool_key() -> None:
    organization_id = _create_organization()
    try:
        _create_session_row(organization_id, tool_key="github")
        _dispose_app_engine()
        client = TestClient(app)
        res = client.get(
            f"/organizations/{organization_id}/wizard-sessions/resume",
            params={"tool_key": "jira"},
        )
        assert res.status_code == 404
    finally:
        _cleanup(organization_id)


def test_scope_options_returns_404_for_unknown_connector() -> None:
    organization_id = _create_organization()
    try:
        _dispose_app_engine()
        client = TestClient(app)
        res = client.get(f"/organizations/{organization_id}/connectors/monday/scope-options")
        assert res.status_code == 404
    finally:
        _cleanup(organization_id)


def test_scope_options_returns_404_for_ado_no_org_level_support() -> None:
    # ADO has no org-level Connection support yet, matching its workspace-level
    # PAT-only auth gap — confirm this is a clean 404, not a 500.
    organization_id = _create_organization()
    try:
        _dispose_app_engine()
        client = TestClient(app)
        res = client.get(f"/organizations/{organization_id}/connectors/ado/scope-options")
        assert res.status_code == 404
    finally:
        _cleanup(organization_id)


def test_scope_options_returns_422_when_no_org_connection_exists() -> None:
    organization_id = _create_organization()
    try:
        _dispose_app_engine()
        client = TestClient(app)
        res = client.get(f"/organizations/{organization_id}/connectors/jira/scope-options")
        assert res.status_code == 422
    finally:
        _cleanup(organization_id)


def test_scope_options_returns_discovered_projects_when_org_connection_resolves() -> None:
    organization_id = _create_organization()
    try:
        connection_id = _create_connection(organization_id, "jira")

        from app.services.connectors.discovery_types import DiscoveryResult, ScopeOption

        fake_result = DiscoveryResult(
            scope_options=[ScopeOption(id="PAY", label="Payments (PAY)")],
            item_types=None,
            extras={},
        )
        import dataclasses

        from app.services.connectors.registry import CONNECTOR_REGISTRY

        fake_definition = dataclasses.replace(
            CONNECTOR_REGISTRY["jira"], discovery_fn=AsyncMock(return_value=fake_result)
        )
        with (
            patch(
                "app.routers.org_connectors._resolve_org_connection",
                new=AsyncMock(return_value=object()),
            ),
            patch.dict(CONNECTOR_REGISTRY, {"jira": fake_definition}),
        ):
            _dispose_app_engine()
            client = TestClient(app)
            res = client.get(f"/organizations/{organization_id}/connectors/jira/scope-options")
        assert res.status_code == 200
        body = res.json()
        assert body["connection_id"] == connection_id
        assert body["scope_options"] == [{"id": "PAY", "label": "Payments (PAY)"}]
    finally:
        _cleanup(organization_id)
