"""Generic background-job execution (services/jobs.py) — real Postgres,
using async_sessionmaker(expire_on_commit=False) to match production's
session-construction (app.core.db.async_session_factory) — a plain
AsyncSession(engine) expires ORM attributes on commit, which fails outside a
greenlet context; production never hits this because get_db_session's
sessionmaker disables that behavior, so the tests use the same setting
rather than reading attributes in an unrepresentative way.

run_job internally uses the module-level app.core.db.engine/
async_session_factory, so every test that calls it runs entirely inside ONE
asyncio.run() — mixing that global engine across separate asyncio.run()
calls binds its connection pool to a dead event loop (the exact
"MissingGreenlet"/"Event loop is closed" flakiness documented elsewhere in
this test suite for db_module.engine)."""
from __future__ import annotations

import asyncio
from datetime import UTC, datetime

from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core import db as db_module
from app.core.config import settings
from app.models import Job, JobStatus, JobType, Project, Workspace
from app.services.jobs import enqueue_job, run_job


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


async def _make_fixture(session: AsyncSession) -> dict[str, str]:
    ws = Workspace(name="Jobs Test WS", createdAt=_now(), updatedAt=_now())
    session.add(ws)
    await session.flush()
    project = Project(workspaceId=ws.id, name="Jobs Test Project", createdAt=_now(), updatedAt=_now())
    session.add(project)
    await session.flush()
    await session.commit()
    return {"workspace_id": ws.id, "project_id": project.id}


async def _cleanup(session: AsyncSession, ids: dict[str, str]) -> None:
    await session.execute(delete(Job).where(Job.projectId == ids["project_id"]))
    await session.execute(delete(Project).where(Project.id == ids["project_id"]))
    await session.execute(delete(Workspace).where(Workspace.id == ids["workspace_id"]))
    await session.commit()


def test_enqueue_job_creates_a_queued_row() -> None:
    async def _scenario() -> None:
        engine = create_async_engine(settings.database_url)
        session_factory = async_sessionmaker(engine, expire_on_commit=False)
        try:
            async with session_factory() as session:
                ids = await _make_fixture(session)
                job = await enqueue_job(
                    session,
                    type=JobType.GENERATE_EPICS,
                    workspace_id=ids["workspace_id"],
                    project_id=ids["project_id"],
                )
                assert job.status == JobStatus.QUEUED
                assert job.resultRef is None
                assert job.startedAt is None
                await _cleanup(session, ids)
        finally:
            await engine.dispose()

    asyncio.run(_scenario())


def test_run_job_transitions_queued_to_running_to_done_with_result_ref() -> None:
    async def _scenario() -> None:
        engine = create_async_engine(settings.database_url)
        session_factory = async_sessionmaker(engine, expire_on_commit=False)
        try:
            async with session_factory() as session:
                ids = await _make_fixture(session)
                job = await enqueue_job(
                    session,
                    type=JobType.GENERATE_EPICS,
                    workspace_id=ids["workspace_id"],
                    project_id=ids["project_id"],
                )
                job_id = job.id

            async def _work(_session: AsyncSession) -> str:
                return "generation-run-123"

            # run_job opens its own session via the global async_session_factory,
            # whose connection pool may still hold a connection bound to a
            # DIFFERENT (now-closed) event loop from an earlier test file in
            # the same pytest run — dispose it first so run_job's session
            # opens a fresh connection on THIS loop.
            await db_module.engine.dispose()
            await run_job(job_id, _work)

            async with session_factory() as session:
                refreshed = await session.get(Job, job_id)
                assert refreshed is not None
                assert refreshed.status == JobStatus.DONE
                assert refreshed.resultRef == "generation-run-123"
                assert refreshed.startedAt is not None
                assert refreshed.finishedAt is not None
                assert refreshed.error is None
                await _cleanup(session, ids)
        finally:
            await engine.dispose()
        await db_module.engine.dispose()

    asyncio.run(_scenario())


def test_run_job_records_failure_without_propagating_the_exception() -> None:
    async def _scenario() -> None:
        engine = create_async_engine(settings.database_url)
        session_factory = async_sessionmaker(engine, expire_on_commit=False)
        try:
            async with session_factory() as session:
                ids = await _make_fixture(session)
                job = await enqueue_job(
                    session,
                    type=JobType.GENERATE_EPICS,
                    workspace_id=ids["workspace_id"],
                    project_id=ids["project_id"],
                )
                job_id = job.id

            async def _failing_work(_session: AsyncSession) -> str | None:
                raise RuntimeError("clustering timed out")

            # Must not raise — a background task has no caller to propagate to.
            await run_job(job_id, _failing_work)

            async with session_factory() as session:
                refreshed = await session.get(Job, job_id)
                assert refreshed is not None
                assert refreshed.status == JobStatus.FAILED
                assert refreshed.error == "clustering timed out"
                assert refreshed.resultRef is None
                assert refreshed.finishedAt is not None
                await _cleanup(session, ids)
        finally:
            await engine.dispose()
        await db_module.engine.dispose()

    asyncio.run(_scenario())


def test_enqueue_job_persists_input_payload() -> None:
    async def _scenario() -> None:
        engine = create_async_engine(settings.database_url)
        session_factory = async_sessionmaker(engine, expire_on_commit=False)
        try:
            async with session_factory() as session:
                ids = await _make_fixture(session)
                job = await enqueue_job(
                    session,
                    type=JobType.REGENERATE_ITEM,
                    workspace_id=ids["workspace_id"],
                    project_id=ids["project_id"],
                    input={"context": "make it shorter"},
                )
                assert job.input == {"context": "make it shorter"}
                await _cleanup(session, ids)
        finally:
            await engine.dispose()

    asyncio.run(_scenario())
