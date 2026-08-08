"""WizardSession router tests — real Postgres (same sync-test + asyncio.run
pattern as test_github_oauth.py, for the same event-loop reasons documented
there)."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

from fastapi.testclient import TestClient
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.core import db as db_module
from app.core.config import settings
from app.main import app
from app.models import Project, WizardSession, Workspace


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _dispose_app_engine() -> None:
    asyncio.run(db_module.engine.dispose())


async def _create_workspace_and_project_async() -> dict[str, str]:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            workspace = Workspace(name="Wizard Session Test WS", createdAt=_now(), updatedAt=_now())
            session.add(workspace)
            await session.flush()
            project = Project(
                workspaceId=workspace.id, name="Wizard Session Test Project", createdAt=_now(), updatedAt=_now()
            )
            session.add(project)
            await session.flush()
            ids = {"workspace_id": workspace.id, "project_id": project.id}
            await session.commit()
            return ids
    finally:
        await engine.dispose()


def _create_workspace_and_project() -> dict[str, str]:
    return asyncio.run(_create_workspace_and_project_async())


async def _create_session_row_async(
    workspace_id: str, project_id: str, tool_key: str, expires_in_future: bool
) -> str:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            now = _now()
            delta = timedelta(hours=1) if expires_in_future else -timedelta(hours=1)
            ws = WizardSession(
                workspaceId=workspace_id,
                projectId=project_id,
                toolKey=tool_key,
                currentStep="choose_tool",
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
    workspace_id: str, project_id: str, tool_key: str = "github", expires_in_future: bool = True
) -> str:
    return asyncio.run(
        _create_session_row_async(workspace_id, project_id, tool_key, expires_in_future)
    )


async def _cleanup_async(ids: dict[str, str]) -> None:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
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


def test_create_wizard_session_starts_at_choose_tool_with_ttl() -> None:
    ids = _create_workspace_and_project()
    try:
        _dispose_app_engine()
        client = TestClient(app)
        res = client.post(
            f"/workspaces/{ids['workspace_id']}/projects/{ids['project_id']}/wizard-sessions",
            json={"tool_key": "github"},
        )
        assert res.status_code == 200
        body = res.json()
        assert body["tool_key"] == "github"
        assert body["current_step"] == "choose_tool"
        assert body["collected_state"] == {}

        expires_at = datetime.fromisoformat(body["expires_at"])
        now = datetime.now(UTC) if expires_at.tzinfo else datetime.now(UTC).replace(tzinfo=None)
        delta = expires_at - now
        assert timedelta(minutes=55) < delta < timedelta(minutes=65)
    finally:
        _cleanup(ids)


def test_get_wizard_session_returns_session_if_unexpired() -> None:
    ids = _create_workspace_and_project()
    try:
        wizard_session_id = _create_session_row(ids["workspace_id"], ids["project_id"])
        _dispose_app_engine()
        client = TestClient(app)
        res = client.get(f"/wizard-sessions/{wizard_session_id}")
        assert res.status_code == 200
        assert res.json()["id"] == wizard_session_id
    finally:
        _cleanup(ids)


def test_get_wizard_session_returns_404_if_expired() -> None:
    ids = _create_workspace_and_project()
    try:
        wizard_session_id = _create_session_row(
            ids["workspace_id"], ids["project_id"], expires_in_future=False
        )
        _dispose_app_engine()
        client = TestClient(app)
        res = client.get(f"/wizard-sessions/{wizard_session_id}")
        assert res.status_code == 404
    finally:
        _cleanup(ids)


def test_get_wizard_session_returns_404_if_unknown() -> None:
    _dispose_app_engine()
    client = TestClient(app)
    res = client.get("/wizard-sessions/nonexistent-id")
    assert res.status_code == 404


def test_update_wizard_session_updates_step_and_collected_state() -> None:
    ids = _create_workspace_and_project()
    try:
        wizard_session_id = _create_session_row(ids["workspace_id"], ids["project_id"])
        _dispose_app_engine()
        client = TestClient(app)
        res = client.patch(
            f"/wizard-sessions/{wizard_session_id}",
            json={"current_step": "select_scope", "collected_state": {"remote_project": "acme/payments"}},
        )
        assert res.status_code == 200
        body = res.json()
        assert body["current_step"] == "select_scope"
        assert body["collected_state"] == {"remote_project": "acme/payments"}
    finally:
        _cleanup(ids)


def test_update_wizard_session_returns_404_if_expired() -> None:
    ids = _create_workspace_and_project()
    try:
        wizard_session_id = _create_session_row(
            ids["workspace_id"], ids["project_id"], expires_in_future=False
        )
        _dispose_app_engine()
        client = TestClient(app)
        res = client.patch(f"/wizard-sessions/{wizard_session_id}", json={"current_step": "select_scope"})
        assert res.status_code == 404
    finally:
        _cleanup(ids)


def test_resume_wizard_session_returns_most_recent_unexpired_session() -> None:
    ids = _create_workspace_and_project()
    try:
        _create_session_row(ids["workspace_id"], ids["project_id"], tool_key="github")
        newest_id = _create_session_row(ids["workspace_id"], ids["project_id"], tool_key="github")
        _dispose_app_engine()
        client = TestClient(app)
        res = client.get(
            f"/workspaces/{ids['workspace_id']}/projects/{ids['project_id']}/wizard-sessions/resume",
            params={"tool_key": "github"},
        )
        assert res.status_code == 200
        assert res.json()["id"] == newest_id
    finally:
        _cleanup(ids)


def test_resume_wizard_session_returns_404_when_none_active() -> None:
    ids = _create_workspace_and_project()
    try:
        _dispose_app_engine()
        client = TestClient(app)
        res = client.get(
            f"/workspaces/{ids['workspace_id']}/projects/{ids['project_id']}/wizard-sessions/resume",
            params={"tool_key": "github"},
        )
        assert res.status_code == 404
    finally:
        _cleanup(ids)


def test_resume_wizard_session_ignores_expired_sessions() -> None:
    ids = _create_workspace_and_project()
    try:
        _create_session_row(
            ids["workspace_id"], ids["project_id"], tool_key="github", expires_in_future=False
        )
        _dispose_app_engine()
        client = TestClient(app)
        res = client.get(
            f"/workspaces/{ids['workspace_id']}/projects/{ids['project_id']}/wizard-sessions/resume",
            params={"tool_key": "github"},
        )
        assert res.status_code == 404
    finally:
        _cleanup(ids)


def test_resume_wizard_session_ignores_different_tool_key() -> None:
    ids = _create_workspace_and_project()
    try:
        _create_session_row(ids["workspace_id"], ids["project_id"], tool_key="jira")
        _dispose_app_engine()
        client = TestClient(app)
        res = client.get(
            f"/workspaces/{ids['workspace_id']}/projects/{ids['project_id']}/wizard-sessions/resume",
            params={"tool_key": "github"},
        )
        assert res.status_code == 404
    finally:
        _cleanup(ids)
