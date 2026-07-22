# Outbound rate limit handling for target tool APIs (Issue #89 / 12.2) — design

## Context

Issue #89 asks to centralize outbound rate-limit handling that's currently duplicated across the three publish connectors (Jira/ADO/GitHub — Issues 5.7/6.7/7.7), and add proactive pacing plus incident visibility. Per the issue's own retrofit note: Epics 5/6/7 are already built and closed, each with independent retry/backoff logic — this is a refactor of shipped code, not net-new design.

## Current state (confirmed by reading the code)

- `ConnectorTransport`/`DirectCloudTransport` (`apps/api/app/services/connectors/transport.py`, Issue 11.1) already exists and is wired into every connector call site via a `transport: ConnectorTransport = _default_transport` DI seam. It is explicitly documented today as a "thin pass-through to httpx" with retry deliberately absent — built only to prove the interface shape for a future on-prem agent relay.
- All three connectors have near-identical, copy-pasted retry loops: `_MAX_ATTEMPTS = 4`, `_BACKOFF_BASE_S = 1.5`, retry on 429 or >=500, honoring `Retry-After` if present else linear backoff. GitHub additionally treats 403 as rate-limiting when `X-RateLimit-Remaining: 0`, but inconsistently — its update path treats _any_ 403 as transient, not just header-confirmed ones.
- No rate-limit dashboard exists anywhere. Two existing internal dashboards (`/internal/ai-costs`, `/internal/time-to-value` in `apps/web/src/app/internal/`) establish the pattern: `isInternalAdmin()` env-allowlist gating.
- `AuditEvent` (Issue 8.1) is an append-only, immutable log with a generic shape (`workspaceId`, `projectId`, `actorType`, `action`, `entityType`, `entityId`, `metadata` JSONB) and an existing filtered UI. Well-suited to record rate-limit incidents without a new table.

## Design decisions (from clarifying questions)

1. **Retry logic moves into `DirectCloudTransport.request()` itself**, not a new wrapping layer — since the "no retry" comment predates this issue and updating it is the expected evolution, not a violated contract. Keyed by a new `target: Literal["jira", "ado", "github"]` param.
2. **Proactive pacing** is a simple per-target-tool minimum inter-request delay enforced inside `DirectCloudTransport` before each request — no new queue/worker/broker infrastructure, consistent with this repo's established no-broker philosophy (Epic 9's metering/drift-check scheduler gaps use the same reasoning).
3. **Incident recording reuses `AuditEvent`** with a new `action="connector.rate_limited"`, rather than a new table.

## Architecture

### `DirectCloudTransport.request()` extended signature

```python
async def request(
    self,
    method: str,
    url: str,
    *,
    target: Literal["jira", "ado", "github"],
    auth: httpx.Auth | tuple[str, str] | None = None,
    headers: dict[str, str] | None = None,
    json: object | None = None,
    params: dict[str, str | int] | None = None,
    timeout: float = 30,
    on_rate_limited: Callable[[int, float], Awaitable[None]] | None = None,
) -> httpx.Response:
```

- `target` selects the per-tool retry/backoff policy (max attempts, base backoff, 403-as-rate-limit detection for GitHub) and the proactive pacing delay.
- Before dispatching, waits out the minimum inter-request gap for `target` (an in-process, per-target `asyncio.Lock` + last-dispatch-timestamp, not distributed).
- On a 429/5xx/GitHub-403, retries internally per the tool's policy (moved verbatim from the connector's old loop), honoring `Retry-After`.
- `on_rate_limited` is an optional callback invoked once per retry-triggering response (not on the final give-up), letting the caller (the router layer, which has `workspace_id` and DB session access — the transport itself doesn't) record an `AuditEvent` without the transport needing to know about audit logging or workspace context.

### Connector call-site changes

Each `create_issue`/`update_issue`/etc. across `jira_publish.py`/`ado_publish.py`/`github_publish.py` drops its own `_MAX_ATTEMPTS`/`_BACKOFF_BASE_S`/retry loop and becomes a single `await transport.request(..., target="jira")` call, trusting the transport's internal retry. The function's return shape (`PublishOutcome`, etc.) and its final give-up error message are preserved — the transport raises a distinguishable exception (or returns the final failed `httpx.Response`) on exhausting retries, which the connector function translates into its existing `PublishOutcome(ok=False, error=...)` shape, so callers/tests see no behavior change on the failure path.

### Incident recording wiring

The publish routers (`apps/api/app/routers/publish.py`/`publish_ado.py`/`publish_github.py`), which already have `session`/`workspace_id` in scope, pass an `on_rate_limited` callback into the connector call that writes an `AuditEvent` (`action="connector.rate_limited"`, `actorType=SYSTEM`, `entityType="jira"|"ado"|"github"`, `metadata={"retry_count":, "wait_seconds":, "status_code":}`).

### Internal dashboard

New `apps/web/src/app/internal/rate-limit-incidents/page.tsx`, gated by the existing `isInternalAdmin()` check, querying `AuditEvent` where `action="connector.rate_limited"`, grouped by `entityType` (tool) and `workspaceId`, following the existing `/internal/ai-costs` page's query/table-rendering pattern.

## Testing

- Unit tests for `DirectCloudTransport`'s new retry/backoff/pacing logic in isolation (mocked via `httpx.MockTransport`, same pattern as Issue 11.1's `test_transport.py`) — per-target policy differences, `Retry-After` honoring, GitHub 403 detection tightened and tested for both create and update paths.
- Existing `test_publish.py`/`test_publish_ado.py`/`test_publish_github.py` router tests must continue to pass **unchanged** where they fake at the `PublishGateway` callable level (above the transport) — proof the retry relocation didn't change connector-level behavior.
- New test confirming `on_rate_limited` fires and writes the expected `AuditEvent`.
- New test for the internal dashboard page (or its data-query function) confirming correct grouping.

## Out of scope

- Real queue/worker/broker infrastructure for batch pacing.
- Per-workspace token-bucket rate limiting (would need distributed/Postgres-backed state across API replicas, similar to Issue 12.1's inbound limiter — bigger scope than this issue's proactive-pacing AC requires).
- Cross-replica coordination for the in-process pacing gate (best-effort only, acceptable at current scale).
