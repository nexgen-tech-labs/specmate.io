"""Snapshot export + approval report endpoints (Issues 8.4/8.5).

Snapshots: POST assembles the project's full trace map and stores it as an
immutable Snapshot row (DB trigger rejects UPDATE) — the stored JSON is the
artifact. GET .../pdf renders from the stored JSON, never live tables, so an
exported snapshot stays accurate even after items are edited or re-published.

Approval report: a live (non-snapshot) query — approved items with approver,
timestamp, and source citation, optionally date-range-scoped, as JSON or PDF.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db_session
from app.models import Project, Snapshot
from app.services.audit import record_audit_event
from app.services.reports.pdf import render_approval_report_pdf, render_snapshot_pdf
from app.services.reports.trace_map import approval_report_rows, build_trace_map

router = APIRouter()


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _parse_date(value: str | None, *, end_of_day: bool = False) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid date: {value!r}") from exc
    if end_of_day and parsed.hour == 0 and parsed.minute == 0 and parsed.second == 0:
        parsed = parsed.replace(hour=23, minute=59, second=59)
    return parsed


async def _get_project(session: AsyncSession, project_id: str) -> Project:
    project = await session.get(Project, project_id)
    if project is None or project.deletedAt is not None:
        raise HTTPException(status_code=404, detail="Project not found.")
    return project


class CreateSnapshotBody(BaseModel):
    actor_user_id: str | None = None


class SnapshotSummary(BaseModel):
    id: str
    kind: str
    created_at: str
    item_count: int
    source_count: int


@router.post("/projects/{project_id}/snapshots")
async def create_snapshot(
    project_id: str,
    body: CreateSnapshotBody,
    session: Annotated[AsyncSession, Depends(get_db_session)],
) -> SnapshotSummary:
    project = await _get_project(session, project_id)
    trace_map = await build_trace_map(session, project)
    counts = trace_map["counts"]
    assert isinstance(counts, dict)

    snapshot = Snapshot(
        workspaceId=project.workspaceId,
        projectId=project.id,
        createdByUserId=body.actor_user_id,
        kind="TRACE_MAP",
        data=trace_map,
        createdAt=_now(),
    )
    session.add(snapshot)
    await session.flush()
    record_audit_event(
        session,
        workspace_id=project.workspaceId,
        project_id=project.id,
        action="snapshot.created",
        entity_type="Snapshot",
        entity_id=snapshot.id,
        actor_user_id=body.actor_user_id,
        after={"kind": "TRACE_MAP", "item_count": counts["items"]},
    )
    await session.commit()
    return SnapshotSummary(
        id=snapshot.id,
        kind="TRACE_MAP",
        created_at=snapshot.createdAt.isoformat(),
        item_count=int(str(counts["items"])),
        source_count=int(str(counts["sources"])),
    )


@router.get("/projects/{project_id}/snapshots")
async def list_snapshots(
    project_id: str,
    session: Annotated[AsyncSession, Depends(get_db_session)],
) -> list[SnapshotSummary]:
    await _get_project(session, project_id)
    snapshots = list(
        (
            await session.execute(
                select(Snapshot)
                .where(Snapshot.projectId == project_id)
                .order_by(Snapshot.createdAt.desc())
            )
        ).scalars()
    )
    summaries = []
    for snap in snapshots:
        counts = snap.data.get("counts")
        counts = counts if isinstance(counts, dict) else {}
        summaries.append(
            SnapshotSummary(
                id=snap.id,
                kind=snap.kind,
                created_at=snap.createdAt.isoformat(),
                item_count=int(str(counts.get("items", 0))),
                source_count=int(str(counts.get("sources", 0))),
            )
        )
    return summaries


async def _get_snapshot(session: AsyncSession, project_id: str, snapshot_id: str) -> Snapshot:
    snapshot = await session.get(Snapshot, snapshot_id)
    if snapshot is None or snapshot.projectId != project_id:
        raise HTTPException(status_code=404, detail="Snapshot not found.")
    return snapshot


@router.get("/projects/{project_id}/snapshots/{snapshot_id}")
async def get_snapshot(
    project_id: str,
    snapshot_id: str,
    session: Annotated[AsyncSession, Depends(get_db_session)],
) -> dict[str, object]:
    snapshot = await _get_snapshot(session, project_id, snapshot_id)
    return snapshot.data


@router.get("/projects/{project_id}/snapshots/{snapshot_id}/pdf")
async def get_snapshot_pdf(
    project_id: str,
    snapshot_id: str,
    session: Annotated[AsyncSession, Depends(get_db_session)],
) -> Response:
    snapshot = await _get_snapshot(session, project_id, snapshot_id)
    pdf = render_snapshot_pdf(snapshot.data)
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="specmate-snapshot-{snapshot.id}.pdf"'
        },
    )


@router.get("/projects/{project_id}/approval-report")
async def approval_report(
    project_id: str,
    session: Annotated[AsyncSession, Depends(get_db_session)],
    date_from: str | None = None,
    date_to: str | None = None,
) -> dict[str, object]:
    project = await _get_project(session, project_id)
    trace_map = await build_trace_map(session, project)
    rows = approval_report_rows(
        trace_map,
        date_from=_parse_date(date_from),
        date_to=_parse_date(date_to, end_of_day=True),
    )
    return {
        "project": trace_map["project"],
        "workspace": trace_map["workspace"],
        "generated_at": trace_map["generated_at"],
        "date_from": date_from,
        "date_to": date_to,
        "rows": rows,
    }


@router.get("/projects/{project_id}/approval-report/pdf")
async def approval_report_pdf(
    project_id: str,
    session: Annotated[AsyncSession, Depends(get_db_session)],
    date_from: str | None = None,
    date_to: str | None = None,
) -> Response:
    project = await _get_project(session, project_id)
    trace_map = await build_trace_map(session, project)
    rows = approval_report_rows(
        trace_map,
        date_from=_parse_date(date_from),
        date_to=_parse_date(date_to, end_of_day=True),
    )
    workspace = trace_map["workspace"]
    assert isinstance(workspace, dict)
    date_range = f"{date_from or '…'} → {date_to or '…'}" if (date_from or date_to) else None
    pdf = render_approval_report_pdf(
        rows,
        project_name=project.name,
        workspace_name=str(workspace["name"]),
        generated_at=str(trace_map["generated_at"]),
        date_range=date_range,
    )
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="specmate-approval-report-{project_id}.pdf"'
        },
    )
