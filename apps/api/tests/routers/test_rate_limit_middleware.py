"""End-to-end rate limit middleware tests (Issue 12.1) — real Postgres, real
TestClient, hitting an existing project-scoped route to exercise the full
request path (workspace resolution -> counter increment -> headers/429)."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

from fastapi.testclient import TestClient
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.core import db as db_module
from app.core.config import settings
from app.main import app
from app.models import (
    ApiRateLimitCounter,
    DraftItem,
    DraftItemStatus,
    DraftItemType,
    PricingTier,
    Project,
    Source,
    SourceKind,
    SourceStatus,
    Workspace,
)


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _dispose() -> None:
    asyncio.run(db_module.engine.dispose())


async def _fixture(tier: PricingTier = PricingTier.STARTER) -> dict[str, str]:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            ws = Workspace(
                name="Rate Limit MW Test WS", pricingTier=tier, createdAt=_now(), updatedAt=_now()
            )
            session.add(ws)
            await session.flush()
            project = Project(
                workspaceId=ws.id, name="RL Project", createdAt=_now(), updatedAt=_now()
            )
            session.add(project)
            await session.flush()
            ids = {"workspace_id": ws.id, "project_id": project.id}
            await session.commit()
            return ids
    finally:
        await engine.dispose()


async def _cleanup(ids: dict[str, str]) -> None:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            if "source_id" in ids:
                await session.execute(delete(Source).where(Source.id == ids["source_id"]))
            if "draft_item_id" in ids:
                await session.execute(
                    delete(DraftItem).where(DraftItem.id == ids["draft_item_id"])
                )
            await session.execute(
                delete(ApiRateLimitCounter).where(
                    ApiRateLimitCounter.workspaceId == ids["workspace_id"]
                )
            )
            await session.execute(delete(Project).where(Project.id == ids["project_id"]))
            await session.execute(delete(Workspace).where(Workspace.id == ids["workspace_id"]))
            await session.commit()
    finally:
        await engine.dispose()


async def _fixture_with_source(tier: PricingTier = PricingTier.STARTER) -> dict[str, str]:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            ws = Workspace(
                name="Rate Limit MW Source Test WS",
                pricingTier=tier,
                createdAt=_now(),
                updatedAt=_now(),
            )
            session.add(ws)
            await session.flush()
            project = Project(
                workspaceId=ws.id, name="RL Source Project", createdAt=_now(), updatedAt=_now()
            )
            session.add(project)
            await session.flush()
            source = Source(
                projectId=project.id,
                name="RL Source",
                kind=SourceKind.TXT,
                status=SourceStatus.PARSED,
                createdAt=_now(),
                updatedAt=_now(),
            )
            session.add(source)
            await session.flush()
            ids = {"workspace_id": ws.id, "project_id": project.id, "source_id": source.id}
            await session.commit()
            return ids
    finally:
        await engine.dispose()


async def _fixture_with_draft_item(tier: PricingTier = PricingTier.STARTER) -> dict[str, str]:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            ws = Workspace(
                name="Rate Limit MW DraftItem Test WS",
                pricingTier=tier,
                createdAt=_now(),
                updatedAt=_now(),
            )
            session.add(ws)
            await session.flush()
            project = Project(
                workspaceId=ws.id, name="RL DraftItem Project", createdAt=_now(), updatedAt=_now()
            )
            session.add(project)
            await session.flush()
            item = DraftItem(
                projectId=project.id,
                type=DraftItemType.STORY,
                title="RL Draft Item",
                description="Fixture item for rate limit middleware test.",
                status=DraftItemStatus.APPROVED,
                createdAt=_now(),
                updatedAt=_now(),
            )
            session.add(item)
            await session.flush()
            ids = {"workspace_id": ws.id, "project_id": project.id, "draft_item_id": item.id}
            await session.commit()
            return ids
    finally:
        await engine.dispose()


def test_request_under_limit_passes_through_with_headers() -> None:
    ids = asyncio.run(_fixture())
    client = TestClient(app)
    try:
        response = client.get(f"/projects/{ids['project_id']}/publish-mapping/jira")
    finally:
        _dispose()
        asyncio.run(_cleanup(ids))

    assert response.status_code == 404  # no mapping configured -- expected, route ran
    assert response.headers["X-RateLimit-Limit"] == "60"
    assert response.headers["X-RateLimit-Remaining"] == "59"
    assert "X-RateLimit-Reset" in response.headers


def test_enterprise_tier_gets_higher_limit() -> None:
    ids = asyncio.run(_fixture(tier=PricingTier.ENTERPRISE))
    client = TestClient(app)
    try:
        response = client.get(f"/projects/{ids['project_id']}/publish-mapping/jira")
    finally:
        _dispose()
        asyncio.run(_cleanup(ids))

    assert response.headers["X-RateLimit-Limit"] == "600"
    assert response.headers["X-RateLimit-Remaining"] == "599"


def test_exceeding_limit_returns_429_with_retry_after() -> None:
    ids = asyncio.run(_fixture())
    try:
        # Use TestClient as a context manager so all 60+ requests share a single
        # blocking-portal event loop. Without `with`, TestClient opens a fresh
        # portal (and thus a fresh event loop) per request; db_module.engine's
        # connection pool then hands out a connection bound to a *different*
        # loop than the one servicing the current request, raising
        # "Future attached to a different loop" from asyncpg once the pool
        # reuses a stale connection.
        with TestClient(app) as client:
            for _ in range(60):
                response = client.get(f"/projects/{ids['project_id']}/publish-mapping/jira")
                assert response.status_code == 404

            blocked = client.get(f"/projects/{ids['project_id']}/publish-mapping/jira")
    finally:
        _dispose()
        asyncio.run(_cleanup(ids))

    assert blocked.status_code == 429
    assert blocked.json()["error"] == "rate_limited"
    assert "Retry-After" in blocked.headers
    assert int(blocked.headers["Retry-After"]) > 0
    assert blocked.headers["X-RateLimit-Remaining"] == "0"


def test_route_with_no_workspace_or_project_param_is_not_rate_limited() -> None:
    client = TestClient(app)
    response = client.get("/health")
    assert response.status_code == 200
    assert "X-RateLimit-Limit" not in response.headers


def test_source_scoped_route_is_rate_limited() -> None:
    """Proves /sources/{source_id}/... resolves to a workspace via the new
    Source.projectId -> Project.workspaceId hop and gets rate limited."""
    ids = asyncio.run(_fixture_with_source())
    client = TestClient(app)
    try:
        response = client.get(f"/sources/{ids['source_id']}/diff")
    finally:
        _dispose()
        asyncio.run(_cleanup(ids))

    assert response.status_code == 404  # no diff persisted -- expected, route ran
    assert response.headers["X-RateLimit-Limit"] == "60"
    assert response.headers["X-RateLimit-Remaining"] == "59"
    assert "X-RateLimit-Reset" in response.headers


def test_draft_item_scoped_route_is_rate_limited() -> None:
    """Proves /draft-items/{item_id}/... resolves to a workspace via the new
    DraftItem.projectId -> Project.workspaceId hop and gets rate limited."""
    ids = asyncio.run(_fixture_with_draft_item())
    client = TestClient(app)
    try:
        response = client.post(
            f"/draft-items/{ids['draft_item_id']}/regenerate",
            json={"context": "please regenerate", "workspace_id": ids["workspace_id"]},
        )
    finally:
        _dispose()
        asyncio.run(_cleanup(ids))

    # Item fixture is APPROVED -- route rejects with 409 before touching the AI
    # adapter, which is exactly what makes this simple to fixture, but still
    # proves the request reached routing logic (i.e. wasn't blocked earlier).
    assert response.status_code == 409
    assert response.headers["X-RateLimit-Limit"] == "60"
    assert response.headers["X-RateLimit-Remaining"] == "59"
    assert "X-RateLimit-Reset" in response.headers
