# Rate-limit connector sync endpoints — design

Issue #104 (follow-up to #88, API rate limiting).

## Context

Issue #88 shipped `RateLimitMiddleware`, a path-based `BaseHTTPMiddleware` that resolves workspace identity from the URL (`/projects/{id}/...`, `/sources/{id}/...`, `/draft-items/{id}/...`) and enforces a per-workspace, per-minute request budget via an atomic Postgres counter (`ApiRateLimitCounter`, `increment_and_get()` in `app/core/rate_limit.py`).

Three connector-sync endpoints were explicitly left unrated because `project_id` lives in the JSON request body, not the URL path, and `BaseHTTPMiddleware` resolves before routing — it can't cheaply read the body without buffering and re-injecting the stream:

- `POST /connectors/{tool}/reference-items/sync`
- `POST /connectors/confluence/pages/{page_id}/sync`
- `POST /connectors/slack/channels/{channel_id}/sync`

These matter more than other unrated routes because they fan out to _external_ Jira/ADO/GitHub/Confluence/Slack APIs — a buggy or malicious client hammering sync could exhaust a customer's own third-party API quota or trigger partner-side throttling, a partner-relationship risk on top of the usual capacity risk.

## Decisions

1. **Reuse the existing per-workspace tier limits** (STARTER: 60/min, ENTERPRISE: 600/min) rather than a separate, stricter sync-specific limit. Sync calls count against the same `ApiRateLimitCounter` budget as everything else — simplest, no new config surface, and can be split into a stricter dedicated limit later if 60/min proves too loose for these specifically.
2. **In-handler enforcement**, not middleware. Each sync handler already parses the request body and confirms the project exists before doing any real work — the workspace id is one more DB lookup away (`Project.workspaceId`), reusing the exact `increment_and_get`/`requests_per_minute_for_tier` primitives the middleware already calls.
3. **429 responses carry the same headers** the middleware's 429 does (`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, `Retry-After`) — consistent behavior for any caller, and cheap since the values are already computed as part of enforcement.

## Design

### `enforce_rate_limit()` — `app/core/rate_limit.py` (new function, existing file)

```python
async def enforce_rate_limit(session: AsyncSession, workspace_id: str) -> None:
    """In-handler rate limit enforcement (Issue #104) for endpoints the
    path-based RateLimitMiddleware can't cover (workspace id isn't in the URL).
    Shares the same ApiRateLimitCounter/tier-limit primitives as the middleware,
    so these calls count against the same per-workspace per-minute budget —
    not a separate pool. Raises HTTPException(429) with the same
    X-RateLimit-*/Retry-After headers the middleware sets, on top of an
    already-committed increment (the attempt counts whether or not it's
    allowed through, matching the middleware's own behavior)."""
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
    headers = {
        "X-RateLimit-Limit": str(limit),
        "X-RateLimit-Remaining": str(remaining),
        "X-RateLimit-Reset": str(reset_epoch),
    }
    if count > limit:
        retry_after = max(1, int(window_reset.replace(tzinfo=UTC).timestamp() - time.time()))
        headers["Retry-After"] = str(retry_after)
        raise HTTPException(
            status_code=429,
            detail="Rate limit exceeded for this workspace.",
            headers=headers,
        )
```

Placed in the existing `rate_limit.py` (not a new file) since it's the natural home next to `increment_and_get`/`RateLimitMiddleware` and avoids a circular-import risk between a new module and this one.

### Call sites — `app/routers/connectors.py`

Each of the 3 sync handlers already does `if await session.get(Project, body.project_id) is None: raise HTTPException(404, ...)` as its first real step. Immediately after that check succeeds (so a 404 for a bogus project doesn't also burn rate-limit budget), resolve `project.workspaceId` and call `enforce_rate_limit(session, project.workspaceId)`. Minimal, mechanical change — 3 call sites, each ~3 lines, no restructuring of the surrounding handler logic.

### Not built

- No new `ApiRateLimitCounter`-adjacent table or separate counter key — sync calls share the exact same per-workspace-per-minute row the middleware increments.
- No change to `RateLimitMiddleware` itself or its known-gaps list beyond removing these 3 routes from it (documented, not code — the middleware's docstring already lists them as gaps; update it to note they're now covered in-handler instead).
- The "also unrated, lower priority" routes the issue flags (`/drift-flags/{id}/resolve`, connector health/discovery checks, `/ai/demo-extract`, `/billing/meter-usage`) are explicitly out of scope for this issue — not touched.

## Tests

- New unit/router tests for each of the 3 sync endpoints: first N requests within the tier limit succeed normally; the (N+1)th within the same minute window returns 429 with `Retry-After`/`X-RateLimit-*` headers set correctly; a 404 (bad `project_id`) does NOT increment the counter.
- Confirm existing sync-endpoint tests (`test_connectors.py`'s reference-item/content-sync tests) still pass unchanged — they run well under any tier's per-minute limit, so no rate-limit-driven regression expected, but this is the safety check that matters.
- `uv run pytest -q && uv run mypy app && uv run ruff check .` — full regression, zero new failures.
