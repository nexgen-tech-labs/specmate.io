"""Flag-for-reviewer endpoint (Issue 9.4): when a source requirement backing an
already-published item is removed (Issue 9.2's targeted regeneration marks the
DraftItem with flags.sourceRemoved), a reviewer can push a comment onto the external
issue rather than the system silently deleting or closing it. Cross-tool: dispatches
on the item's PublishedItem.targetTool since a DraftItem can be published to any of
Jira/ADO/GitHub, and this one action needs to work regardless of which."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db_session
from app.models import AuditActorType, DraftItem, Project, PublishedItem, PublishMapping, PublishTarget
from app.services.audit import record_audit_event
from app.services.connectors.ado_auth import get_ado_connection
from app.services.connectors.ado_publish import add_comment as ado_add_comment
from app.services.connectors.github_auth import get_github_connection
from app.services.connectors.github_publish import add_comment as github_add_comment
from app.services.connectors.jira_auth import get_jira_connection
from app.services.connectors.jira_publish import add_comment as jira_add_comment
from app.services.connectors.types import ConnectorError

router = APIRouter()


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


_REMOVED_COMMENT = (
    "SpecMate: the source requirement backing this item was removed in a later "
    "document version. This issue was NOT auto-closed — please review and decide "
    "whether to close it, keep it, or update it manually."
)


class FlagRemovedBody(BaseModel):
    workspace_id: str
    actor_user_id: str | None = None


class FlagRemovedResponse(BaseModel):
    ok: bool
    tool: str
    external_key: str


@router.post("/draft-items/{item_id}/flag-removed")
async def flag_removed(
    item_id: str,
    body: FlagRemovedBody,
    session: Annotated[AsyncSession, Depends(get_db_session)],
) -> FlagRemovedResponse:
    item = await session.get(DraftItem, item_id)
    if item is None or item.deletedAt is not None:
        raise HTTPException(status_code=404, detail="Draft item not found.")
    if not (item.flags or {}).get("sourceRemoved"):
        raise HTTPException(
            status_code=409, detail="This item isn't flagged as source-removed."
        )

    published = (
        await session.execute(
            select(PublishedItem).where(
                PublishedItem.draftItemId == item_id, PublishedItem.deletedAt.is_(None)
            )
        )
    ).scalar_one_or_none()
    if published is None:
        raise HTTPException(
            status_code=404, detail="This item was never published — nothing to flag externally."
        )

    mapping = (
        await session.execute(
            select(PublishMapping).where(
                PublishMapping.projectId == item.projectId,
                PublishMapping.tool == published.targetTool,
            )
        )
    ).scalar_one_or_none()
    if mapping is None:
        raise HTTPException(status_code=400, detail="No publish mapping configured for this tool.")

    try:
        if published.targetTool == PublishTarget.JIRA:
            await jira_add_comment(get_jira_connection(), published.externalKey, _REMOVED_COMMENT)
        elif published.targetTool == PublishTarget.ADO:
            work_item_id = int(published.externalKey.removeprefix("AB#"))
            await ado_add_comment(
                get_ado_connection(), mapping.remoteProject, work_item_id, _REMOVED_COMMENT
            )
        elif published.targetTool == PublishTarget.GITHUB:
            issue_number = int(published.externalKey.removeprefix("#"))
            await github_add_comment(
                get_github_connection(), mapping.remoteProject, issue_number, _REMOVED_COMMENT
            )
        else:
            raise HTTPException(status_code=400, detail=f"Unsupported tool: {published.targetTool}")
    except ConnectorError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    project = await session.get(Project, item.projectId)
    assert project is not None
    flags = dict(item.flags or {})
    flags["sourceRemovedFlaggedExternally"] = True
    item.flags = flags
    item.updatedAt = _now()
    record_audit_event(
        session,
        workspace_id=body.workspace_id,
        project_id=item.projectId,
        action="draft_item.flagged_removed_externally",
        entity_type="DraftItem",
        entity_id=item.id,
        actor_user_id=body.actor_user_id,
        actor_type=AuditActorType.USER,
        after={"tool": published.targetTool.value, "key": published.externalKey},
    )
    await session.commit()

    return FlagRemovedResponse(
        ok=True, tool=published.targetTool.value, external_key=published.externalKey
    )
