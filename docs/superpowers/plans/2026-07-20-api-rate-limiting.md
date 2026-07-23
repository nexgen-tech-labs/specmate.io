# API rate limiting (Issue #88 / 12.1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Protect SpecMate's FastAPI backend from abuse/runaway usage with per-workspace, tier-based rate limits (60 req/min Starter, 600 req/min Enterprise), returning proper 429s with `Retry-After` and exposing `X-RateLimit-*` headers on every response.

**Architecture:** A single FastAPI middleware (`apps/api/app/core/rate_limit.py`) added to `main.py`, backed by a new Postgres table `ApiRateLimitCounter` (atomic `INSERT ... ON CONFLICT DO UPDATE`). Workspace identity is resolved from the request's path params (`workspace_id` directly, or `project_id` via a DB lookup). No new auth/API-key system — see `docs/superpowers/specs/2026-07-20-api-rate-limiting-design.md` for the scoping rationale.

**Tech Stack:** FastAPI (Starlette `BaseHTTPMiddleware`), SQLAlchemy async, Postgres, Prisma (schema source of truth — `apps/api/app/models.py` mirrors it by hand per this repo's convention).

---

## Task 1: Prisma schema + migration for `ApiRateLimitCounter`

Prisma owns migrations in this repo (`apps/api/app/models.py`'s docstring: "Prisma owns migrations for this schema... update this file to match by hand"). Even though `apps/web` never queries this table, the migration must still originate from Prisma so the production migration pipeline (`prisma migrate deploy` in `deploy.yml`) creates it.

**Files:**

- Modify: `apps/web/prisma/schema.prisma`
- Create: `apps/web/prisma/migrations/<timestamp>_add_api_rate_limit_counter/migration.sql`

- [ ] **Step 1: Add the model to `schema.prisma`**

Find the `UsagePeriod` model in `apps/web/prisma/schema.prisma` (search for `model UsagePeriod`) and add a new model directly after it:

```prisma
model ApiRateLimitCounter {
  workspaceId  String
  windowStart  DateTime
  requestCount Int      @default(0)

  workspace Workspace @relation(fields: [workspaceId], references: [id])

  @@id([workspaceId, windowStart])
}
```

Then find the `Workspace` model and add the inverse relation field next to its other back-relations (e.g. near `usagePeriods UsagePeriod[]` if present — search for `UsagePeriod\[\]` in the `Workspace` model block):

```prisma
  apiRateLimitCounters ApiRateLimitCounter[]
```

- [ ] **Step 2: Generate the migration SQL by hand**

Run to see the exact timestamp format used by this repo's existing migrations:

```bash
ls apps/web/prisma/migrations | tail -3
```

Create a new directory `apps/web/prisma/migrations/<YYYYMMDDHHMMSS>_add_api_rate_limit_counter/` using the current UTC timestamp in that same format, containing `migration.sql`:

```sql
-- API rate limiting (Issue #88): per-workspace, per-minute-window request counters.
CREATE TABLE "ApiRateLimitCounter" (
    "workspaceId" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "requestCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ApiRateLimitCounter_pkey" PRIMARY KEY ("workspaceId", "windowStart")
);

ALTER TABLE "ApiRateLimitCounter" ADD CONSTRAINT "ApiRateLimitCounter_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
```

- [ ] **Step 3: Apply the migration to local dev Postgres**

```bash
cd apps/web
npx prisma migrate resolve --applied <YYYYMMDDHHMMSS>_add_api_rate_limit_counter --schema prisma/schema.prisma
npx prisma db execute --file prisma/migrations/<YYYYMMDDHHMMSS>_add_api_rate_limit_counter/migration.sql --schema prisma/schema.prisma
npx prisma generate --schema prisma/schema.prisma
```

Expected: all three commands exit 0. If `migrate resolve` fails because the migration isn't yet tracked, run `npx prisma migrate dev --schema prisma/schema.prisma --name add_api_rate_limit_counter --create-only` first to let Prisma register it, then diff the generated SQL against what you wrote above (they should match) before applying.

- [ ] **Step 4: Verify the table exists**

```bash
cd apps/web && npx prisma db execute --stdin --schema prisma/schema.prisma <<< "SELECT column_name FROM information_schema.columns WHERE table_name = 'ApiRateLimitCounter';"
```

Expected: three rows — `workspaceId`, `windowStart`, `requestCount`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/prisma/schema.prisma apps/web/prisma/migrations/
git commit -m "Add ApiRateLimitCounter table for API rate limiting (Issue #88)"
```

---

## Task 2: Mirror the model in SQLAlchemy (`apps/api`)

**Files:**

- Modify: `apps/api/app/models.py`

- [ ] **Step 1: Add the `ApiRateLimitCounter` SQLAlchemy model**

Open `apps/api/app/models.py`, find the `UsagePeriod` class (search `class UsagePeriod`), and add a new class directly after it (after its closing blank line, before `class AtlassianConnectInstall`):

```python
class ApiRateLimitCounter(Base):
    """Per-workspace, per-minute-window request counter (Issue 12.1). One row per
    (workspaceId, windowStart); requestCount is incremented atomically via
    INSERT ... ON CONFLICT DO UPDATE in rate_limit.py — never read-then-write."""

    __tablename__ = "ApiRateLimitCounter"

    workspaceId: Mapped[str] = mapped_column(ForeignKey("Workspace.id"), primary_key=True)
    windowStart: Mapped[datetime] = mapped_column(DateTime, primary_key=True)
    requestCount: Mapped[int] = mapped_column(Integer, default=0)
```

- [ ] **Step 2: Typecheck and lint**

```bash
cd apps/api
uv run mypy app/models.py
uv run ruff check app/models.py
```

Expected: both clean ("Success: no issues found" / "All checks passed!").

- [ ] **Step 3: Commit**

```bash
git add apps/api/app/models.py
git commit -m "Mirror ApiRateLimitCounter in SQLAlchemy models"
```

---

## Task 3: Rate limit config (tier limits)

**Files:**

- Create: `apps/api/app/core/rate_limit_config.py`
- Test: `apps/api/tests/core/test_rate_limit_config.py`

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/core/__init__.py` (empty file, matches the existing `tests/services/__init__.py` pattern) if `apps/api/tests/core/` doesn't already exist:

```bash
mkdir -p apps/api/tests/core
touch apps/api/tests/core/__init__.py
```

Create `apps/api/tests/core/test_rate_limit_config.py`:

```python
"""Tier -> requests-per-minute mapping (Issue 12.1)."""

from __future__ import annotations

from app.core.rate_limit_config import requests_per_minute_for_tier
from app.models import PricingTier


def test_starter_tier_limit() -> None:
    assert requests_per_minute_for_tier(PricingTier.STARTER) == 60


def test_enterprise_tier_limit() -> None:
    assert requests_per_minute_for_tier(PricingTier.ENTERPRISE) == 600
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/api && uv run pytest tests/core/test_rate_limit_config.py -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'app.core.rate_limit_config'`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/app/core/rate_limit_config.py`:

```python
"""Tier -> requests-per-minute limits for API rate limiting (Issue 12.1)."""

from __future__ import annotations

from app.models import PricingTier

_LIMITS: dict[PricingTier, int] = {
    PricingTier.STARTER: 60,
    PricingTier.ENTERPRISE: 600,
}


def requests_per_minute_for_tier(tier: PricingTier) -> int:
    return _LIMITS[tier]
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/api && uv run pytest tests/core/test_rate_limit_config.py -v
```

Expected: 2 passed.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
cd apps/api
uv run mypy app/core/rate_limit_config.py
uv run ruff check app/core/rate_limit_config.py tests/core/
git add app/core/rate_limit_config.py tests/core/
git commit -m "Add tier -> rate limit config for API rate limiting"
```

---

## Task 4: Atomic counter increment function

**Files:**

- Create: `apps/api/app/core/rate_limit.py`
- Test: `apps/api/tests/core/test_rate_limit.py`

This is the core atomic-increment logic, tested directly against a real session before it's wired into middleware (middleware is harder to unit test in isolation — Task 5 covers the full HTTP-level behavior).

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/core/test_rate_limit.py`:

```python
"""Atomic per-workspace rate-limit counter (Issue 12.1) — increment_and_get must be
race-safe (INSERT ... ON CONFLICT DO UPDATE, never read-then-write) and return the
post-increment count so the caller can compare against the tier limit."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.core.config import settings
from app.core.rate_limit import increment_and_get
from app.models import ApiRateLimitCounter, Workspace


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _window_start() -> datetime:
    now = _now()
    return now.replace(second=0, microsecond=0)


async def _fixture() -> str:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            ws = Workspace(name="Rate Limit Test WS", createdAt=_now(), updatedAt=_now())
            session.add(ws)
            await session.commit()
            return ws.id
    finally:
        await engine.dispose()


async def _cleanup(workspace_id: str) -> None:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            await session.execute(
                delete(ApiRateLimitCounter).where(
                    ApiRateLimitCounter.workspaceId == workspace_id
                )
            )
            await session.execute(delete(Workspace).where(Workspace.id == workspace_id))
            await session.commit()
    finally:
        await engine.dispose()


def test_increment_and_get_returns_sequential_counts() -> None:
    workspace_id = asyncio.run(_fixture())
    engine = create_async_engine(settings.database_url)
    try:
        async def _run() -> list[int]:
            window = _window_start()
            async with AsyncSession(engine) as session:
                first = await increment_and_get(session, workspace_id, window)
                await session.commit()
            async with AsyncSession(engine) as session:
                second = await increment_and_get(session, workspace_id, window)
                await session.commit()
            return [first, second]

        counts = asyncio.run(_run())
    finally:
        asyncio.run(engine.dispose())
        asyncio.run(_cleanup(workspace_id))

    assert counts == [1, 2]


def test_increment_and_get_is_race_safe_under_concurrency() -> None:
    workspace_id = asyncio.run(_fixture())
    engine = create_async_engine(settings.database_url)
    try:
        async def _one_increment() -> int:
            window = _window_start()
            async with AsyncSession(engine) as session:
                count = await increment_and_get(session, workspace_id, window)
                await session.commit()
                return count

        async def _run() -> list[int]:
            return await asyncio.gather(*[_one_increment() for _ in range(10)])

        counts = asyncio.run(_run())
    finally:
        asyncio.run(engine.dispose())
        asyncio.run(_cleanup(workspace_id))

    assert sorted(counts) == list(range(1, 11))
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/api && uv run pytest tests/core/test_rate_limit.py -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'app.core.rate_limit'`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/app/core/rate_limit.py`:

```python
"""Per-workspace API rate limiting (Issue 12.1): atomic Postgres counter increment
plus the FastAPI middleware that enforces tier limits on every request."""

from __future__ import annotations

import time
from datetime import UTC, datetime, timedelta

from fastapi import FastAPI, Request, Response
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint

from app.core.db import async_session_factory
from app.core.rate_limit_config import requests_per_minute_for_tier
from app.models import PricingTier, Project, Workspace


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
    """Reads workspace identity from the route's own path params — workspace_id
    directly, or project_id resolved via one lookup. Routes with neither (health
    checks, etc.) are not rate-limited at all."""
    path_params = request.path_params
    if "workspace_id" in path_params:
        return str(path_params["workspace_id"])
    if "project_id" in path_params:
        project = await session.get(Project, str(path_params["project_id"]))
        return project.workspaceId if project is not None else None
    return None


class RateLimitMiddleware(BaseHTTPMiddleware):
    """Enforces per-workspace, per-minute request limits (Issue 12.1). Skips
    requests whose route has no workspace_id/project_id path param — those aren't
    rate-limited (e.g. health checks)."""

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
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/api && uv run pytest tests/core/test_rate_limit.py -v
```

Expected: 2 passed.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
cd apps/api
uv run mypy app/core/rate_limit.py
uv run ruff check app/core/rate_limit.py tests/core/
git add app/core/rate_limit.py tests/core/test_rate_limit.py
git commit -m "Add atomic per-workspace rate-limit counter (Issue #88)"
```

---

## Task 5: Wire the middleware into `main.py` + full HTTP-level tests

**Files:**

- Modify: `apps/api/app/main.py`
- Test: `apps/api/tests/routers/test_rate_limit_middleware.py`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/tests/routers/test_rate_limit_middleware.py`. This exercises the middleware end-to-end via a real route (`GET /projects/{project_id}/publish-mapping/jira`, which 404s past the rate-limit check when no mapping exists — we only care that the limiter runs before the route, not what the route itself does):

```python
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
            await session.commit()
            return {"workspace_id": ws.id, "project_id": project.id}
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
    client = TestClient(app)
    try:
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/api && uv run pytest tests/routers/test_rate_limit_middleware.py -v
```

Expected: FAIL — `X-RateLimit-Limit` KeyError (middleware not installed yet).

- [ ] **Step 3: Wire the middleware into `main.py`**

Modify `apps/api/app/main.py`:

```python
from fastapi import FastAPI

from app.core.rate_limit import install_rate_limit_middleware
from app.routers import (
    ai_demo,
    billing,
    connectors,
    drift,
    flag_removed,
    generation,
    health,
    publish,
    publish_ado,
    publish_github,
    reports,
    sources,
)

app = FastAPI(title="SpecMate API")

install_rate_limit_middleware(app)

app.include_router(health.router)
app.include_router(ai_demo.router)
app.include_router(sources.router)
app.include_router(connectors.router)
app.include_router(generation.router)
app.include_router(publish.router)
app.include_router(publish_ado.router)
app.include_router(publish_github.router)
app.include_router(flag_removed.router)
app.include_router(drift.router)
app.include_router(reports.router)
app.include_router(billing.router)
```

Note: `install_rate_limit_middleware(app)` must run before `include_router` calls purely for readability/ordering consistency — Starlette middleware registration order doesn't actually depend on route registration order, but keeping it first makes the file read top-to-bottom as "cross-cutting concerns, then routes."

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/api && uv run pytest tests/routers/test_rate_limit_middleware.py -v
```

Expected: 4 passed.

If `test_route_with_no_workspace_or_project_param_is_not_rate_limited` fails because `/health` doesn't exist at that exact path, check the actual route:

```bash
grep -n "@router.get" apps/api/app/routers/health.py
```

and adjust the test's URL to match.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
cd apps/api
uv run mypy app
uv run ruff check .
git add app/main.py tests/routers/test_rate_limit_middleware.py
git commit -m "Wire rate limit middleware into the FastAPI app (Issue #88)"
```

---

## Task 6: Full regression pass + close the issue

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

```bash
cd apps/api && uv run pytest -q
```

Expected: all tests pass, including every pre-existing router test (proof the middleware doesn't break any existing route — in particular, confirm no existing test asserts an exact response header set that a new `X-RateLimit-*` header would break; if one does, that test needs updating to allow extra headers, not the middleware to be weakened).

- [ ] **Step 2: Full mypy + ruff sweep**

```bash
cd apps/api
uv run mypy app
uv run ruff check .
```

Expected: both clean.

- [ ] **Step 3: Manual smoke test against the local dev server**

```bash
cd apps/api && uvicorn app.main:app --reload &
sleep 2
curl -i http://localhost:8000/health
```

Expected: `200`, and since `/health` has no workspace/project path param, no `X-RateLimit-*` headers (confirms the skip-path works against a live server, not just `TestClient`). Kill the server after (`kill %1` or find the PID via `lsof -i :8000`).

- [ ] **Step 4: Update `architecture.md`**

Add a new subsection after the "Maintain & Sync (Epic 9...)" section (search for `## 6. Deployment & Infrastructure` and insert directly before it, following the pattern of the Issue 11.1/11.2/11.3 subsections already there):

```markdown
### API rate limiting (Issue 12.1, `apps/api/app/core/rate_limit.py` + `rate_limit_config.py`)

Per-workspace, tier-based rate limiting on SpecMate's FastAPI backend — scoped to the API surface that exists today (no partner-API-key system invented; see `docs/superpowers/specs/2026-07-20-api-rate-limiting-design.md` for why). A `RateLimitMiddleware` (Starlette `BaseHTTPMiddleware`, installed via `install_rate_limit_middleware()` in `main.py`) resolves workspace identity from the route's own path params — `workspace_id` directly, or `project_id` via one DB lookup — and skips requests where neither is present (health checks, etc.). Counters live in a new Postgres table, `ApiRateLimitCounter` (`workspaceId`, `windowStart` truncated to the minute, `requestCount`), incremented atomically via a single `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` — no read-then-write race. Limits are keyed off `Workspace.pricingTier`: 60 req/min for `STARTER`, 600 req/min for `ENTERPRISE` (`rate_limit_config.py`). Every response carries `X-RateLimit-Limit`/`X-RateLimit-Remaining`/`X-RateLimit-Reset`; exceeding the limit short-circuits before the route handler runs, returning `429` with a `Retry-After` header and a `{"error": "rate_limited", ...}` body. Old counter rows aren't cleaned up automatically — same documented gap as the metering-job and drift-check schedulers elsewhere in this doc.
```

- [ ] **Step 5: Commit the architecture.md update**

```bash
git add architecture.md
git commit -m "Document API rate limiting in architecture.md"
```

- [ ] **Step 6: Close Issue #88**

```bash
gh issue close 88 --comment "$(cat <<'EOF'
Implemented as a FastAPI middleware (`apps/api/app/core/rate_limit.py`), the first middleware in this app — installed via `install_rate_limit_middleware()` in `main.py`.

**Scope decision** (documented in `docs/superpowers/specs/2026-07-20-api-rate-limiting-design.md`): the issue's "public/partner API" language doesn't map to anything that exists in this codebase yet — there's no API-key auth or partner API surface, only `apps/web` calling `apps/api` server-side. Rather than invent a speculative partner-API-key system, this rate-limits the existing FastAPI surface itself, keyed by workspace.

**How it works**: workspace identity is resolved from the route's own path params (`workspace_id` directly, or `project_id` via one DB lookup) — routes with neither (health checks) aren't rate-limited. Counters live in a new Postgres table `ApiRateLimitCounter` (`workspaceId`, `windowStart` truncated to the minute, `requestCount`), incremented atomically via `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` — no read-then-write race, verified under concurrent increments in `tests/core/test_rate_limit.py`. No Redis — Postgres-only, consistent with this repo's existing "no message broker" approach.

**Tiers**: 60 req/min for `STARTER`, 600 req/min for `ENTERPRISE`, keyed off `Workspace.pricingTier`.

**Response contract**: every response carries `X-RateLimit-Limit`/`X-RateLimit-Remaining`/`X-RateLimit-Reset`; exceeding the limit returns `429` with `Retry-After` and a `{"error": "rate_limited", ...}` body, short-circuited before the route handler runs.

All three acceptance criteria verified in `tests/routers/test_rate_limit_middleware.py`: 429 with retry guidance on limit exceeded, correct tier differentiation (Starter vs Enterprise), and rate-limit headers present on every response (not just blocked ones). Full suite green, `mypy`/`ruff` clean.
EOF
)"
```

---

## Self-review notes (for the plan author, already applied above)

- **Spec coverage**: 429 w/ Retry-After (Task 4/5), tier differentiation (Task 3), headers on every response (Task 4/5), Postgres-only counter (Task 1/2/4), workspace resolution via path params (Task 4) — all covered.
- **Type consistency**: `increment_and_get(session, workspace_id, window_start)` signature is identical between its Task 4 test and its Task 4/5 implementation and its Task 5 middleware call site.
- **No placeholders**: every step has runnable code or an exact command with expected output.
