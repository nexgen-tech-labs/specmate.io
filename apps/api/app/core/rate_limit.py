"""Per-workspace API rate limiting (Issue 12.1): atomic Postgres counter increment
plus the FastAPI middleware that enforces tier limits on every request."""

from __future__ import annotations

import re
import time
from datetime import UTC, datetime, timedelta

from fastapi import FastAPI, Request, Response
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint

from app.core.db import async_session_factory
from app.core.rate_limit_config import requests_per_minute_for_tier
from app.models import DraftItem, PricingTier, Project, Source, Workspace

# Matches this codebase's real route shapes directly against request.url.path.
# There is no /workspaces/{id} route in this app (verified against
# apps/api/app/routers/*.py). Three route shapes are covered today:
#   - /projects/{project_id}/...     -> Project.workspaceId directly
#   - /sources/{source_id}/...       -> Source.projectId -> Project.workspaceId
#   - /draft-items/{item_id}/...     -> DraftItem.projectId -> Project.workspaceId
# Each pattern is its own regex (rather than one alternation) so future route
# shapes can be added without disturbing existing resolution paths.
_PROJECT_ID_PATTERN = re.compile(r"^/projects/([^/]+)")
_SOURCE_ID_PATTERN = re.compile(r"^/sources/([^/]+)")
_ITEM_ID_PATTERN = re.compile(r"^/draft-items/([^/]+)")


async def increment_and_get(
    session: AsyncSession, workspace_id: str, window_start: datetime
) -> int:
    """Atomically increments (or creates) this workspace's counter for the given
    minute window and returns the post-increment count. Single INSERT ... ON
    CONFLICT DO UPDATE — never a separate read then write, so concurrent requests
    for the same workspace/window can't race each other into an undercount."""
    result = await session.execute(
        text(
            """
            INSERT INTO "ApiRateLimitCounter" ("workspaceId", "windowStart", "requestCount")
            VALUES (:workspace_id, :window_start, 1)
            ON CONFLICT ("workspaceId", "windowStart")
            DO UPDATE SET "requestCount" = "ApiRateLimitCounter"."requestCount" + 1
            RETURNING "requestCount"
            """
        ),
        {"workspace_id": workspace_id, "window_start": window_start},
    )
    return int(result.scalar_one())


def _window_start(now: datetime) -> datetime:
    return now.replace(second=0, microsecond=0)


async def _resolve_workspace_id(session: AsyncSession, request: Request) -> str | None:
    """Reads workspace identity straight from the URL path via regex — NOT from
    request.path_params, which is empty at this point in BaseHTTPMiddleware's
    dispatch (Starlette only populates path_params during routing, which happens
    *inside* call_next(), not before it — confirmed empirically for this repo's
    Starlette/FastAPI versions).

    Three route shapes resolve to a workspace today:
      - /projects/{project_id}/...   one DB lookup: Project.workspaceId.
      - /sources/{source_id}/...     two DB lookups: Source.projectId, then
        Project.workspaceId. Covers document-parsing routes such as
        POST /sources/{id}/parse, GET /sources/{id}/diff, and
        POST /sources/{id}/targeted-regenerate.
      - /draft-items/{item_id}/...   two DB lookups: DraftItem.projectId,
        then Project.workspaceId. Covers AI-generation routes such as
        POST /draft-items/{id}/regenerate and
        POST /draft-items/{id}/flag-removed.

    Known gaps — NOT covered, and requests to these routes are NOT rate
    limited at all (see architecture.md for the full rationale):
      - /drift-flags/{drift_flag_id}/resolve — would need a three-hop chain
        (DriftFlag.publishedItemId -> PublishedItem.draftItemId ->
        DraftItem.projectId -> Project.workspaceId), deferred as too deep
        for this pass.
      - /connectors/{tool}/reference-items/sync,
        /connectors/confluence/pages/{page_id}/sync,
        /connectors/slack/channels/{channel_id}/sync — no
        project/workspace-scoped identifier in the URL path.
      - /connectors/jira/health, /connectors/jira/projects,
        /connectors/ado/health, /connectors/ado/projects,
        /connectors/github/publish-health, /connectors/github/repos —
        connection-health/discovery checks with no project/workspace
        identifier in the path.
      - /ai/demo-extract, /billing/meter-usage — no path-based identifier
        at all.
    Any other route matching no known pattern (health checks, etc.) is also
    not rate-limited."""
    path = request.url.path

    project_match = _PROJECT_ID_PATTERN.match(path)
    if project_match:
        project = await session.get(Project, project_match.group(1))
        return project.workspaceId if project is not None else None

    source_match = _SOURCE_ID_PATTERN.match(path)
    if source_match:
        source = await session.get(Source, source_match.group(1))
        if source is None:
            return None
        project = await session.get(Project, source.projectId)
        return project.workspaceId if project is not None else None

    item_match = _ITEM_ID_PATTERN.match(path)
    if item_match:
        item = await session.get(DraftItem, item_match.group(1))
        if item is None:
            return None
        project = await session.get(Project, item.projectId)
        return project.workspaceId if project is not None else None

    return None


class RateLimitMiddleware(BaseHTTPMiddleware):
    """Enforces per-workspace, per-minute request limits (Issue 12.1). Skips
    requests whose URL path doesn't match a known route shape — see
    _resolve_workspace_id for exactly which shapes are covered and which are
    known gaps (e.g. health checks, connector sync/discovery endpoints,
    drift-flag resolution)."""

    async def dispatch(
        self, request: Request, call_next: RequestResponseEndpoint
    ) -> Response:
        async with async_session_factory() as session:
            workspace_id = await _resolve_workspace_id(session, request)
            if workspace_id is None:
                return await call_next(request)

            workspace = await session.get(Workspace, workspace_id)
            tier = workspace.pricingTier if workspace is not None else PricingTier.STARTER
            limit = requests_per_minute_for_tier(tier)

            now = datetime.now(UTC).replace(tzinfo=None)
            window_start = _window_start(now)
            window_reset = window_start + timedelta(minutes=1)

            count = await increment_and_get(session, workspace_id, window_start)
            await session.commit()

        reset_epoch = int(window_reset.replace(tzinfo=UTC).timestamp())
        remaining = max(0, limit - count)

        if count > limit:
            retry_after = max(1, int(window_reset.replace(tzinfo=UTC).timestamp() - time.time()))
            response = Response(
                content='{"error": "rate_limited", "detail": "Rate limit exceeded for this workspace."}',
                status_code=429,
                media_type="application/json",
            )
            response.headers["Retry-After"] = str(retry_after)
        else:
            response = await call_next(request)

        response.headers["X-RateLimit-Limit"] = str(limit)
        response.headers["X-RateLimit-Remaining"] = str(remaining)
        response.headers["X-RateLimit-Reset"] = str(reset_epoch)
        return response


def install_rate_limit_middleware(app: FastAPI) -> None:
    app.add_middleware(RateLimitMiddleware)
