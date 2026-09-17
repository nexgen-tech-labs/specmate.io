"""GET /jobs/{job_id} — real Postgres, TestClient, same patterns as the rest
of this test suite."""
from __future__ import annotations

import asyncio
from datetime import UTC, datetime

from fastapi.testclient import TestClient
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.core import db as db_module
from app.core.config import settings
from app.main import app
from app.models import Job, JobStatus, JobType, Project, Workspace


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _dispose_app_engine() -> None:
    asyncio.run(db_module.engine.dispose())


async def _fixture_async() -> dict[str, str]:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            ws = Workspace(name="Jobs Router Test WS", createdAt=_now(), updatedAt=_now())
            session.add(ws)
            await session.flush()
            project = Project(
                workspaceId=ws.id, name="Jobs Router Test Project", createdAt=_now(), updatedAt=_now()
            )
            session.add(project)
            await session.flush()
            job = Job(
                type=JobType.GENERATE_EPICS,
                status=JobStatus.DONE,
                workspaceId=ws.id,
                projectId=project.id,
                resultRef="generation-run-abc",
                createdAt=_now(),
                updatedAt=_now(),
                startedAt=_now(),
                finishedAt=_now(),
            )
            session.add(job)
            await session.flush()
            ids = {"workspace_id": ws.id, "project_id": project.id, "job_id": job.id}
            await session.commit()
            return ids
    finally:
        await engine.dispose()


def _fixture() -> dict[str, str]:
    return asyncio.run(_fixture_async())


async def _cleanup_async(ids: dict[str, str]) -> None:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            await session.execute(delete(Job).where(Job.projectId == ids["project_id"]))
            await session.execute(delete(Project).where(Project.id == ids["project_id"]))
            await session.execute(delete(Workspace).where(Workspace.id == ids["workspace_id"]))
            await session.commit()
    finally:
        await engine.dispose()


def _cleanup(ids: dict[str, str]) -> None:
    asyncio.run(_cleanup_async(ids))


def test_get_job_returns_the_job_status_and_result_ref() -> None:
    ids = _fixture()
    try:
        _dispose_app_engine()
        client = TestClient(app)
        res = client.get(f"/jobs/{ids['job_id']}")
        assert res.status_code == 200
        body = res.json()
        assert body["id"] == ids["job_id"]
        assert body["type"] == "GENERATE_EPICS"
        assert body["status"] == "DONE"
        assert body["result_ref"] == "generation-run-abc"
        assert body["error"] is None
        assert body["started_at"] is not None
        assert body["finished_at"] is not None
    finally:
        _cleanup(ids)


def test_get_job_returns_404_for_unknown_job() -> None:
    _dispose_app_engine()
    client = TestClient(app)
    res = client.get("/jobs/nonexistent-job-id")
    assert res.status_code == 404
