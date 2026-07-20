# API rate limiting (Issue #88 / 12.1) — design

## Scope decision

Issue #88 asks for rate limiting on SpecMate's "public/partner API endpoints." No API-key auth or partner API surface exists in the codebase today — the only consumer of `apps/api` is `apps/web`, calling it server-side. Rather than invent a speculative partner-API-key system (a much larger, untracked feature), this rate-limits the existing FastAPI surface itself, keyed by workspace. This satisfies the issue's actual intent (protect the API from abuse/runaway usage) without building infrastructure for a partner API that doesn't exist yet.

## Architecture

A FastAPI middleware — the first `app.add_middleware(...)` call in `apps/api/app/main.py`, which currently has none — runs on every request before route handling.

**Workspace resolution**: the middleware reads `workspace_id` directly from the route's path params if present, or `project_id` (resolved to `workspaceId` via a DB lookup) if only that's present. Routes with neither (health checks, etc.) are skipped entirely.

**Counter storage**: new `ApiRateLimitCounter` table (Postgres — no Redis in this stack, consistent with the existing "no message broker" philosophy):

```
ApiRateLimitCounter
  workspaceId    string
  windowStart    datetime   -- truncated to the minute
  requestCount   int
  PRIMARY KEY (workspaceId, windowStart)
```

Each request does one atomic query:

```sql
INSERT INTO "ApiRateLimitCounter" ("workspaceId", "windowStart", "requestCount")
VALUES (:workspace_id, :window_start, 1)
ON CONFLICT ("workspaceId", "windowStart")
DO UPDATE SET "requestCount" = "ApiRateLimitCounter"."requestCount" + 1
RETURNING "requestCount"
```

Race-safe under concurrent requests, no separate read-then-write. Old windows aren't cleaned up synchronously — documented as a manual/future cleanup task, consistent with Epic 9's "no scheduler yet" pattern.

**Tier limits**: keyed off `Workspace.pricingTier`:

- `PricingTier.STARTER` → 60 requests/minute
- `PricingTier.ENTERPRISE` → 600 requests/minute

**Response contract**:

- Every response (allowed or blocked) carries `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (unix timestamp of window end).
- Over limit → `429` with `Retry-After` header (seconds until window reset) and JSON body `{"error": "rate_limited", "detail": "..."}` — short-circuited before the route handler runs.

## Data model

New migration adding `ApiRateLimitCounter` to `apps/api/app/models.py` (SQLAlchemy) — this table is API-only, no `apps/web` Prisma equivalent needed since Prisma never queries it.

## Testing

- Atomic increment behavior of the counter (concurrent increments land correctly).
- A request under the limit passes through with correct headers and reaches the route handler.
- A request over the limit returns 429 with `Retry-After` and does NOT reach the route handler.
- Headers present on both allowed and blocked responses.
- Uses the real test Postgres DB, consistent with how the rest of this repo tests DB-touching code.

## Out of scope

- No API-key/partner-auth system.
- No distributed cache (Redis) — Postgres-backed counters only.
- No automatic cleanup job for old counter rows (manual/future work, same as the existing metering-job and drift-check scheduler gaps).
