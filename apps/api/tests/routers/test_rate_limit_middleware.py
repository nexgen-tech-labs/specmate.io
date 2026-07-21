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
from app.models import ApiRateLimitCounter, PricingTier, Project, Workspace


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
