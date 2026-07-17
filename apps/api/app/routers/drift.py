"""Drift detection (Issue 9.5): on-demand sync check comparing SpecMate's stored
PublishedItem.lastKnownState against the live remote issue. No scheduler exists yet
(see architecture.md's roadmap notes) — this is triggered manually per-project from
the review/audit UI rather than a cron job, which still satisfies the acceptance
criteria ("detected on the next sync check") without inventing scheduler infra."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db_session
from app.models import DraftItem, DriftFlag, DriftResolution, Project, PublishedItem, PublishTarget
from app.services.connectors.ado_auth import get_ado_connection
from app.services.connectors.ado_publish import fetch_work_item
from app.services.connectors.github_auth import get_github_connection
from app.services.connectors.github_publish import fetch_issue as github_fetch_issue
from app.services.connectors.jira_auth import get_jira_connection
from app.services.connectors.jira_publish import fetch_issue as jira_fetch_issue
from app.services.connectors.types import ConnectorError

router = APIRouter()


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _diff_state(
    last_known: dict[str, object] | None, remote_title: str, remote_description: str
) -> dict[str, object] | None:
    """Compares only title/description — the fields SpecMate actually writes and can
    meaningfully compare across tools. Status/workflow state varies too much per-tool
    configuration to diff generically; a future per-tool status map could add it."""
    if last_known is None:
        return None
    changes: dict[str, object] = {}
    known_title = str(last_known.get("title", ""))
    known_description = str(last_known.get("description", ""))
    if known_title.strip() != remote_title.strip():
        changes["title"] = {"before": known_title, "after": remote_title}
    if known_description.strip() != remote_description.strip():
        changes["description"] = {"before": known_description, "after": remote_description}
    return changes or None


class DriftCheckResult(BaseModel):
    published_item_id: str
    draft_item_id: str
    tool: str
    external_key: str
    drifted: bool
    diff: dict[str, object] | None = None
    error: str | None = None


class DriftCheckResponse(BaseModel):
    results: list[DriftCheckResult]
    drifted_count: int


@router.post("/projects/{project_id}/drift-check")
async def check_drift(
    project_id: str,
    session: Annotated[AsyncSession, Depends(get_db_session)],
) -> DriftCheckResponse:
    if await session.get(Project, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found.")

    published_result = await session.execute(
        select(PublishedItem)
        .join(DraftItem, DraftItem.id == PublishedItem.draftItemId)
        .where(DraftItem.projectId == project_id, PublishedItem.deletedAt.is_(None))
    )
    published_items = list(published_result.scalars())

    results: list[DriftCheckResult] = []
    now = _now()

    for published in published_items:
        try:
            if published.targetTool == PublishTarget.JIRA:
                remote = await jira_fetch_issue(get_jira_connection(), published.externalKey)
                remote_title, remote_description = remote.title, remote.description
            elif published.targetTool == PublishTarget.ADO:
                work_item_id = int(published.externalKey.removeprefix("AB#"))
                remote_ado = await fetch_work_item(get_ado_connection(), work_item_id)
                remote_title, remote_description = remote_ado.title, remote_ado.description
            elif published.targetTool == PublishTarget.GITHUB:
                issue_number = int(published.externalKey.removeprefix("#"))
                mapping_repo = None
                # GitHub's connector needs the repo, not stored on PublishedItem —
                # derive it from the issue URL (created by SpecMate, always this shape).
                if published.externalUrl:
                    parts = published.externalUrl.split("/")
                    if "issues" in parts:
                        idx = parts.index("issues")
                        mapping_repo = "/".join(parts[idx - 2 : idx])
                if not mapping_repo:
                    results.append(
                        DriftCheckResult(
                            published_item_id=published.id,
                            draft_item_id=published.draftItemId,
                            tool=published.targetTool.value,
                            external_key=published.externalKey,
                            drifted=False,
                            error="Could not determine repo from stored URL.",
                        )
                    )
                    continue
                remote_gh = await github_fetch_issue(get_github_connection(), mapping_repo, issue_number)
                remote_title, remote_description = remote_gh.title, remote_gh.description
            else:
                continue
        except ConnectorError as exc:
            results.append(
                DriftCheckResult(
                    published_item_id=published.id,
                    draft_item_id=published.draftItemId,
                    tool=published.targetTool.value,
                    external_key=published.externalKey,
                    drifted=False,
                    error=str(exc),
                )
            )
            continue

        diff = _diff_state(published.lastKnownState, remote_title, remote_description)
        if diff:
            # A DraftItem can only accumulate one *open* (unresolved) drift flag at a
            # time — re-checking an already-flagged, still-drifted item doesn't spam
            # new rows.
            existing_open = (
                await session.execute(
                    select(DriftFlag).where(
                        DriftFlag.publishedItemId == published.id,
                        DriftFlag.resolution.is_(None),
                    )
                )
            ).scalar_one_or_none()
            if existing_open is None:
                session.add(
                    DriftFlag(publishedItemId=published.id, diff=diff, detectedAt=now)
                )
            else:
                existing_open.diff = diff
                existing_open.detectedAt = now
        results.append(
            DriftCheckResult(
                published_item_id=published.id,
                draft_item_id=published.draftItemId,
                tool=published.targetTool.value,
                external_key=published.externalKey,
                drifted=diff is not None,
                diff=diff,
            )
        )

    await session.commit()
    return DriftCheckResponse(
        results=results, drifted_count=sum(1 for r in results if r.drifted)
    )


class ResolveDriftBody(BaseModel):
    resolution: DriftResolution
    resolved_by_user_id: str | None = None


class ResolveDriftResponse(BaseModel):
    ok: bool
    resolution: str


@router.post("/drift-flags/{drift_flag_id}/resolve")
async def resolve_drift(
    drift_flag_id: str,
    body: ResolveDriftBody,
    session: Annotated[AsyncSession, Depends(get_db_session)],
) -> ResolveDriftResponse:
    """Issue 9.5's reviewer action path: accept the external change (SpecMate adopts
    it as the new lastKnownState, no republish) or reassert SpecMate's version
    (leaves lastKnownState as-is — the next update-publish will overwrite the drift,
    which is the reviewer's explicit, informed choice, not a silent default)."""
    flag = await session.get(DriftFlag, drift_flag_id)
    if flag is None:
        raise HTTPException(status_code=404, detail="Drift flag not found.")
    if flag.resolution is not None:
        raise HTTPException(status_code=409, detail="This drift flag was already resolved.")

    now = _now()
    if body.resolution == DriftResolution.ACCEPT_EXTERNAL:
        published = await session.get(PublishedItem, flag.publishedItemId)
        assert published is not None
        diff = flag.diff
        new_state = dict(published.lastKnownState or {})
        for field_name, change in diff.items():
            if isinstance(change, dict) and "after" in change:
                new_state[field_name] = change["after"]
        published.lastKnownState = new_state
        published.lastSyncedAt = now

    flag.resolution = body.resolution
    flag.resolvedAt = now
    flag.resolvedByUserId = body.resolved_by_user_id
    await session.commit()
    return ResolveDriftResponse(ok=True, resolution=body.resolution.value)
