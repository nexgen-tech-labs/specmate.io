"""Generic background-job execution (the Postgres job table architecture.md
has always described, previously undelivered — see Job's model docstring).

Every long-running AI-generation/source-parsing endpoint follows the same
shape: validate synchronously inside the request (so a bad request still
gets an immediate 4xx), enqueue a Job row, hand a background coroutine to
FastAPI's BackgroundTasks, and return 202 with the job id. The frontend
polls GET /jobs/{job_id} until status is DONE or FAILED.

FastAPI's BackgroundTasks runs the coroutine in the SAME process/container
after the response has been sent — no new worker infrastructure, matching
this repo's existing single-apiApp-container deployment (see DEPLOYMENT.md).
The tradeoff (documented, not hidden): a job in progress during a
redeploy/restart is lost — acceptable for a first cut given minReplicas=1
and no current traffic volume; revisit if reliability requirements grow.

Each job's own background coroutine MUST create its own fresh AsyncSession
(via async_session_factory, not the request-scoped session) — the request's
session is closed by the time BackgroundTasks actually runs the callback.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import async_session_factory
from app.models import Job, JobStatus, JobType
from app.services.ai.adapter import AIGenerationError

AI_UNAVAILABLE_DETAIL = "AI generation is temporarily unavailable. Please try again in a few moments."


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


async def enqueue_job(
    session: AsyncSession,
    *,
    type: JobType,
    workspace_id: str,
    project_id: str,
    input: dict[str, object] | None = None,
) -> Job:
    """Creates a QUEUED Job row in the caller's existing (request-scoped)
    session and commits it — callers do this BEFORE scheduling the
    background task, so the job is visible to a poller immediately, even if
    the background task hasn't started running yet."""
    job = Job(
        type=type,
        workspaceId=workspace_id,
        projectId=project_id,
        input=input,
        createdAt=_now(),
        updatedAt=_now(),
    )
    session.add(job)
    await session.flush()
    await session.commit()
    return job


async def run_job(job_id: str, work: Callable[[AsyncSession], Awaitable[str | None]]) -> None:
    """The actual background-task callback: opens a FRESH session (the
    request's session is gone by now), flips the job to RUNNING, runs `work`
    (which must return the resultRef to store, or None), and records
    DONE/FAILED. `work` raising any exception is caught here and turned into
    a FAILED job with the exception message — background tasks have no
    caller to propagate an exception to, so this is the only place the
    failure can be recorded at all.

    AIGenerationError is special-cased to a generic message rather than
    str(exc): the old synchronous routers caught it and substituted
    AI_UNAVAILABLE_DETAIL specifically to avoid leaking raw provider error
    text (which can echo request/response content, including anything
    secret-looking a provider's own error body happened to include) into a
    client-visible field. job.error IS client-visible (returned verbatim by
    GET /jobs/{job_id}), so this same substitution must happen here now that
    generation runs as a background job instead of an inline request."""
    async with async_session_factory() as session:
        job = await session.get(Job, job_id)
        if job is None:
            return  # Shouldn't happen — enqueue_job always commits first.
        job.status = JobStatus.RUNNING
        job.startedAt = _now()
        job.updatedAt = _now()
        await session.commit()

        try:
            result_ref = await work(session)
        except AIGenerationError:
            job.status = JobStatus.FAILED
            job.error = AI_UNAVAILABLE_DETAIL
            job.finishedAt = _now()
            job.updatedAt = _now()
            await session.commit()
            return
        except Exception as exc:  # noqa: BLE001 — last-resort handler, see docstring
            job.status = JobStatus.FAILED
            job.error = str(exc)
            job.finishedAt = _now()
            job.updatedAt = _now()
            await session.commit()
            return

        job.status = JobStatus.DONE
        job.resultRef = result_ref
        job.finishedAt = _now()
        job.updatedAt = _now()
        await session.commit()
