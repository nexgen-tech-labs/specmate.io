"""GitHub Issues publishing endpoints (Epic 7). Mirrors publish.py/publish_ado.py's
shape — discovery, mapping config (incl. format mode), health, and publish."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field as dc_field
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db_session
from app.models import (
    AuditActorType,
    DraftItem,
    DraftItemStatus,
    Project,
    PublishedItem,
    PublishMapping,
    PublishTarget,
    TicketFormatMode,
    TraceLink,
    Workspace,
)
from app.services.audit import make_rate_limit_recorder, record_audit_event
from app.services.billing.metering import report_workspace_current_usage
from app.services.connectors.format_adapter import FormatMode
from app.services.connectors.github_auth import (
    GitHubConnection,
    check_connection_health,
    resolve_github_connection,
)
from app.services.connectors.github_publish import (
    GitHubPublishOutcome,
    build_body,
    build_candidate,
    create_issue,
    discover_repo_meta,
    discover_repos,
    sort_for_hierarchy,
    suggest_file_references,
    update_issue,
    update_issue_body,
)
from app.services.connectors.transport import DirectCloudTransport
from app.services.connectors.types import ConnectorError, ConnectorTransport
from app.services.connectors.update_detection import ExistingPublication, find_existing_publication

router = APIRouter()


# GitHub has no native type hierarchy — every SpecMate type maps to "issue" plus a
# label (github_publish.LABEL_PREFIX); this map is really "should this type publish
# by default", not a remote-type lookup like Jira/ADO.
_DEFAULT_PUBLISHABLE_TYPES = {
    "EPIC", "STORY", "TASK", "SUBTASK", "ACCEPTANCE_CRITERIA", "TEST",
    "RISK", "NFR", "DEPENDENCY", "ASSUMPTION", "QUESTION",
}


async def _resolve_connection(session: AsyncSession, workspace_id: str) -> GitHubConnection:
    """Prefers a workspace-scoped Connection, then the workspace's
    organization-level Connection (Onboarding Flow redesign's org-level
    Connect flow), then the single-tenant env-configured fallback — mirrors
    publish.py's Jira _resolve_connection fix for the identical gap."""
    from app.models import Connection

    has_workspace_connection = (
        await session.execute(
            select(Connection.id).where(
                Connection.workspaceId == workspace_id, Connection.toolKey == "github"
            )
        )
    ).scalar_one_or_none()
    if has_workspace_connection is not None:
        return await resolve_github_connection(session, workspace_id)

    workspace = await session.get(Workspace, workspace_id)
    if workspace and workspace.organizationId:
        has_org_connection = (
            await session.execute(
                select(Connection.id).where(
                    Connection.organizationId == workspace.organizationId,
                    Connection.toolKey == "github",
                )
            )
        ).scalar_one_or_none()
        if has_org_connection is not None:
            return await resolve_github_connection(session, organization_id=workspace.organizationId)

    return await resolve_github_connection(session, workspace_id)


@dataclass
class GitHubPublishGateway:
    connection: Callable[[AsyncSession, str], Awaitable[GitHubConnection]] = _resolve_connection
    repos: Callable[[GitHubConnection], Awaitable[list[dict[str, str]]]] = discover_repos
    meta: Callable[[GitHubConnection, str], Awaitable[dict[str, object]]] = discover_repo_meta
    create: Callable[..., Awaitable[GitHubPublishOutcome]] = create_issue
    update: Callable[..., Awaitable[GitHubPublishOutcome]] = update_issue
    update_body: Callable[..., Awaitable[None]] = update_issue_body
    health: Callable[[GitHubConnection], Awaitable[dict[str, object]]] = dc_field(
        default=check_connection_health
    )
    transport: ConnectorTransport = dc_field(default_factory=DirectCloudTransport)


def get_github_gateway() -> GitHubPublishGateway:
    """FastAPI dependency — overridden in tests to fake the GitHub API."""
    return GitHubPublishGateway()


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


@router.get("/connectors/github/publish-health")
async def github_health(
    session: Annotated[AsyncSession, Depends(get_db_session)],
    gateway: Annotated[GitHubPublishGateway, Depends(get_github_gateway)],
    workspace_id: str | None = None,
) -> dict[str, object]:
    try:
        connection = await gateway.connection(session, workspace_id or "")
    except ConnectorError as exc:
        return {"ok": False, "reason": str(exc)}
    return await gateway.health(connection)


@router.get("/connectors/github/repos")
async def github_repos(
    session: Annotated[AsyncSession, Depends(get_db_session)],
    gateway: Annotated[GitHubPublishGateway, Depends(get_github_gateway)],
    workspace_id: str | None = None,
) -> list[dict[str, str]]:
    try:
        connection = await gateway.connection(session, workspace_id or "")
        return await gateway.repos(connection)
    except ConnectorError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


class GitHubMappingBody(BaseModel):
    remote_project: str  # "owner/repo"
    type_map: dict[str, str] | None = None  # SpecMate type -> extra label (optional, beyond the auto prefix)
    field_defaults: dict[str, object] | None = None
    format_mode: TicketFormatMode = TicketFormatMode.HUMAN
    milestone: int | None = None


@router.post("/projects/{project_id}/publish-mapping/github")
async def upsert_github_mapping(
    project_id: str,
    body: GitHubMappingBody,
    session: Annotated[AsyncSession, Depends(get_db_session)],
    gateway: Annotated[GitHubPublishGateway, Depends(get_github_gateway)],
) -> dict[str, object]:
    project = await session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found.")
    try:
        connection = await gateway.connection(session, project.workspaceId)
        metadata = await gateway.meta(connection, body.remote_project)
    except ConnectorError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    type_map = body.type_map or {t: t for t in _DEFAULT_PUBLISHABLE_TYPES}
    field_defaults = dict(body.field_defaults or {})
    if body.milestone is not None:
        field_defaults["milestone"] = body.milestone

    existing = (
        await session.execute(
            select(PublishMapping).where(
                PublishMapping.projectId == project_id, PublishMapping.tool == PublishTarget.GITHUB
            )
        )
    ).scalar_one_or_none()
    if existing is None:
        existing = PublishMapping(
            projectId=project_id,
            tool=PublishTarget.GITHUB,
            remoteProject=body.remote_project,
            typeMap=dict(type_map),
            fieldDefaults=field_defaults,
            metadata_=metadata,
            formatMode=body.format_mode,
            createdAt=_now(),
            updatedAt=_now(),
        )
        session.add(existing)
    else:
        existing.remoteProject = body.remote_project
        existing.typeMap = dict(type_map)
        existing.fieldDefaults = field_defaults
        existing.metadata_ = metadata
        existing.formatMode = body.format_mode
        existing.updatedAt = _now()
    await session.commit()
    return {
        "remote_project": body.remote_project,
        "type_map": type_map,
        "format_mode": body.format_mode.value,
        "metadata": metadata,
        # Issue 7.3 AC: GitHub UI should suggest (not force) agent mode as the
        # recommended default — signalled here, decision stays with the admin.
        "suggested_format_mode": TicketFormatMode.CODING_AGENT.value,
    }


@router.get("/projects/{project_id}/publish-mapping/github")
async def get_github_mapping(
    project_id: str, session: Annotated[AsyncSession, Depends(get_db_session)]
) -> dict[str, object]:
    mapping = (
        await session.execute(
            select(PublishMapping).where(
                PublishMapping.projectId == project_id, PublishMapping.tool == PublishTarget.GITHUB
            )
        )
    ).scalar_one_or_none()
    if mapping is None:
        raise HTTPException(status_code=404, detail="No GitHub publish mapping configured.")
    return {
        "remote_project": mapping.remoteProject,
        "type_map": mapping.typeMap,
        "field_defaults": mapping.fieldDefaults,
        "format_mode": mapping.formatMode.value,
        "metadata": mapping.metadata_,
    }


class GitHubPublishBody(BaseModel):
    item_ids: list[str]
    # Forwarded by the web proxy from the authenticated session (Issue 8.1).
    actor_user_id: str | None = None


class GitHubPublishItemResult(BaseModel):
    item_id: str
    ok: bool
    key: str | None = None
    url: str | None = None
    error: str | None = None
    blocked: bool = False


class GitHubPublishResponse(BaseModel):
    results: list[GitHubPublishItemResult]
    succeeded: int
    failed: int


@router.post("/projects/{project_id}/publish/github")
async def publish_to_github(
    project_id: str,
    body: GitHubPublishBody,
    session: Annotated[AsyncSession, Depends(get_db_session)],
    gateway: Annotated[GitHubPublishGateway, Depends(get_github_gateway)],
) -> GitHubPublishResponse:
    project = await session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found.")
    workspace = await session.get(Workspace, project.workspaceId)
    assert workspace is not None

    mapping = (
        await session.execute(
            select(PublishMapping).where(
                PublishMapping.projectId == project_id, PublishMapping.tool == PublishTarget.GITHUB
            )
        )
    ).scalar_one_or_none()
    if mapping is None:
        raise HTTPException(
            status_code=400,
            detail="No GitHub publish mapping configured — set one up in project settings first.",
        )
    if mapping.formatMode == TicketFormatMode.BOTH:
        raise HTTPException(
            status_code=400, detail="Ticket format mode 'BOTH' is not yet supported by publishing."
        )
    type_map = dict(mapping.typeMap)
    field_defaults = dict(mapping.fieldDefaults or {})
    milestone = field_defaults.pop("milestone", None)
    mode = FormatMode(mapping.formatMode.value)
    file_paths_raw = (mapping.metadata_ or {}).get("file_paths")
    file_paths = file_paths_raw if isinstance(file_paths_raw, list) else []

    items_result = await session.execute(
        select(DraftItem).where(
            DraftItem.id.in_(body.item_ids),
            DraftItem.projectId == project_id,
            DraftItem.deletedAt.is_(None),
        )
    )
    items = {item.id: item for item in items_result.scalars()}

    published_result = await session.execute(
        select(PublishedItem).where(
            PublishedItem.draftItemId.in_(
                list(items.keys()) + [i.parentId for i in items.values() if i.parentId]
            ),
            PublishedItem.targetTool == PublishTarget.GITHUB,
            PublishedItem.deletedAt.is_(None),
        )
    )
    published: dict[str, tuple[str, str, int]] = {}
    for row in published_result.scalars():
        number = int(row.externalKey.lstrip("#"))
        published[row.draftItemId] = (row.externalKey, row.externalUrl, number)

    results: list[GitHubPublishItemResult] = []
    candidates = []
    child_map: dict[str, list[str]] = {}  # parent_item_id -> [child item_ids being published now]
    # Issue 9.4: candidates whose item is a targeted-regen revision of an already-
    # published item update that item's issue instead of creating a new one.
    update_targets: dict[str, ExistingPublication] = {}

    for item_id in body.item_ids:
        item = items.get(item_id)
        if item is None:
            results.append(GitHubPublishItemResult(item_id=item_id, ok=False, error="Item not found."))
            continue
        if item_id in published:
            key, _url, _num = published[item_id]
            results.append(
                GitHubPublishItemResult(
                    item_id=item_id, ok=False, blocked=True, key=key, error=f"Already published as {key}."
                )
            )
            continue
        if item.status != DraftItemStatus.APPROVED:
            results.append(
                GitHubPublishItemResult(item_id=item_id, ok=False, error="Only approved items can be published.")
            )
            continue
        if workspace.approvalStages >= 2 and item.signedOffByUserId is None:
            results.append(
                GitHubPublishItemResult(item_id=item_id, ok=False, error="Awaiting sign-off (two-stage approval).")
            )
            continue
        if item.type.value not in type_map:
            results.append(
                GitHubPublishItemResult(item_id=item_id, ok=False, error=f"{item.type.value} is not mapped for publish.")
            )
            continue
        existing = await find_existing_publication(session, item, PublishTarget.GITHUB)
        if existing is not None:
            update_targets[item_id] = existing
        refs = suggest_file_references(item, file_paths) if mode == FormatMode.CODING_AGENT else None
        candidates.append(build_candidate(item, mode, item.parentId, refs))
        if item.parentId:
            child_map.setdefault(item.parentId, []).append(item_id)

    connection = None
    if candidates:
        try:
            connection = await gateway.connection(session, workspace.id)
        except ConnectorError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    extra_labels = [
        label for label in type_map.values() if label and label not in _DEFAULT_PUBLISHABLE_TYPES
    ]
    now = _now()
    for candidate in sort_for_hierarchy(candidates):
        item = items[candidate.item_id]
        if candidate.parent_item_id and candidate.parent_item_id not in published:
            results.append(
                GitHubPublishItemResult(
                    item_id=candidate.item_id,
                    ok=False,
                    blocked=True,
                    error="Parent item is not published yet — publish the parent first.",
                )
            )
            continue

        assert connection is not None
        existing = update_targets.get(candidate.item_id)
        # Issue #106: see publish.py's identical comment — close out any open
        # transaction before the retry-heavy network call.
        await session.commit()
        if existing is not None:
            issue_number = int(existing.external_key.removeprefix("#"))
            outcome = await gateway.update(
                connection,
                mapping.remoteProject,
                issue_number,
                candidate,
                transport=gateway.transport,
                on_rate_limited=make_rate_limit_recorder(session, workspace.id, "github"),
            )
        else:
            outcome = await gateway.create(
                connection,
                mapping.remoteProject,
                candidate,
                extra_labels,
                milestone,
                transport=gateway.transport,
                on_rate_limited=make_rate_limit_recorder(session, workspace.id, "github"),
            )

        flags = dict(item.flags or {})
        if outcome.ok and outcome.key and (outcome.number is not None or existing is not None):
            published_row: PublishedItem
            # Issue 9.5: snapshot what SpecMate just wrote for later drift comparison.
            state_snapshot: dict[str, object] = {
                "title": candidate.content.title,
                "description": candidate.content.body_markdown,
            }
            if existing is not None:
                found = await session.get(PublishedItem, existing.published_item_id)
                assert found is not None
                published_row = found
                published_row.draftItemId = candidate.item_id
                published_row.externalUrl = outcome.url or published_row.externalUrl
                action = "draft_item.publish_updated"
            else:
                published_row = PublishedItem(
                    draftItemId=candidate.item_id,
                    targetTool=PublishTarget.GITHUB,
                    externalKey=outcome.key,
                    externalUrl=outcome.url or "",
                    createdAt=now,
                )
                session.add(published_row)
                action = "draft_item.published"
            published_row.lastKnownState = state_snapshot
            published_row.lastSyncedAt = now
            await session.flush()
            trace_rows = await session.execute(
                select(TraceLink).where(TraceLink.draftItemId == candidate.item_id)
            )
            for trace in trace_rows.scalars():
                trace.publishedItemId = published_row.id
                trace.updatedAt = now
            assert outcome.number is not None
            published[candidate.item_id] = (outcome.key, outcome.url or "", outcome.number)
            flags.pop("publishError", None)
            item.flags = flags or None
            results.append(
                GitHubPublishItemResult(item_id=candidate.item_id, ok=True, key=outcome.key, url=outcome.url)
            )

            # Task-list hierarchy (Issue 7.6): once a child publishes, append it to
            # its already-published parent's body as a checked-off-able task line.
            if candidate.parent_item_id and candidate.parent_item_id in published:
                parent_key, parent_url, parent_number = published[candidate.parent_item_id]
                parent_item = items.get(candidate.parent_item_id)
                if parent_item is not None:
                    parent_content = build_candidate(parent_item, mode, None).content
                    child_lines = [
                        (items[cid].title, published[cid][1])
                        for cid in child_map.get(candidate.parent_item_id, [])
                        if cid in published
                    ]
                    new_body = build_body(parent_content, child_lines)
                    try:
                        await gateway.update_body(
                            connection, mapping.remoteProject, parent_number, new_body
                        )
                    except ConnectorError:
                        pass  # best-effort — the issue itself published fine; task list is cosmetic
            record_audit_event(
                session,
                workspace_id=workspace.id,
                project_id=project_id,
                action=action,
                entity_type="DraftItem",
                entity_id=candidate.item_id,
                actor_user_id=body.actor_user_id,
                actor_type=AuditActorType.USER,
                before={"tool": "GITHUB", "key": existing.external_key} if existing else None,
                after={"tool": "GITHUB", "key": outcome.key, "url": outcome.url},
            )
        else:
            flags["publishError"] = outcome.error
            item.flags = flags
            results.append(GitHubPublishItemResult(item_id=candidate.item_id, ok=False, error=outcome.error))
            record_audit_event(
                session,
                workspace_id=workspace.id,
                project_id=project_id,
                action="draft_item.publish_failed",
                entity_type="DraftItem",
                entity_id=candidate.item_id,
                actor_user_id=body.actor_user_id,
                actor_type=AuditActorType.USER,
                after={"tool": "GITHUB", "error": outcome.error},
            )
        item.updatedAt = now
        await session.commit()

    # Issue 12.5: near-real-time usage reporting — best-effort, never blocks the
    # publish response even if Stripe reporting fails or isn't configured.
    await report_workspace_current_usage(session, workspace.id)

    return GitHubPublishResponse(
        results=results,
        succeeded=sum(1 for r in results if r.ok),
        failed=sum(1 for r in results if not r.ok),
    )
