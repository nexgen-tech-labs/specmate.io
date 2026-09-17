"""Job status polling — the frontend's only way to observe a background
job's progress after the enqueueing endpoint (generate/generate-downstream/
regenerate/targeted-regenerate/parse/reparse) returns 202. See
app/services/jobs.py for the execution side."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db_session
from app.models import Job

router = APIRouter()


class JobResponse(BaseModel):
    id: str
    type: str
    status: str
    result_ref: str | None
    error: str | None
    created_at: str
    started_at: str | None
    finished_at: str | None


def _to_response(job: Job) -> JobResponse:
    return JobResponse(
        id=job.id,
        type=job.type.value,
        status=job.status.value,
        result_ref=job.resultRef,
        error=job.error,
        created_at=job.createdAt.isoformat(),
        started_at=job.startedAt.isoformat() if job.startedAt else None,
        finished_at=job.finishedAt.isoformat() if job.finishedAt else None,
    )


@router.get("/jobs/{job_id}")
async def get_job(
    job_id: str,
    session: Annotated[AsyncSession, Depends(get_db_session)],
) -> JobResponse:
    job = await session.get(Job, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found.")
    return _to_response(job)
