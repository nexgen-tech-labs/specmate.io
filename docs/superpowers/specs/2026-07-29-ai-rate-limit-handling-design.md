# AI provider rate limit and quota handling (Issue #90 / 12.3) — design

## Context

Issue #90 asks for queueing/backoff for Claude API rate limits (distinct from existing per-call retry, "Issue 1.4"), fair-use queuing across workspaces, and graceful queued/waiting UX instead of a silent hang or raw provider error.

## Current state (confirmed by reading the code)

- `apps/api/app/services/ai/claude_adapter.py`'s `ClaudeAdapter.generate()` is the sole Claude call site. Retry today is entirely SDK-level (`AsyncAnthropic(max_retries=3, timeout=60.0)`); a `try/except` wraps `RateLimitError`/`APIStatusError`/`APIConnectionError` (after SDK retries are exhausted) into `AIGenerationError`. No app-level backoff, no awareness of other in-flight calls. This is "Issue 1.4" — stays untouched.
- `apps/api/app/services/generation/pipeline.py`'s `run_generation()` runs 5 sequential AI passes inline, called directly and synchronously from `POST /projects/{project_id}/generate`. No job table, no queue, no worker — explicitly documented as "the job-table/worker is still the documented follow-up," matching the same deferred-infrastructure pattern already established for parsing (Issue #17), metering, and drift-check scheduling elsewhere in this repo.
- No queue/worker/concurrency-limiting infrastructure exists anywhere in `apps/api` today.
- Frontend (`onboarding-wizard.tsx`'s `triggerGenerate()`) does a single blocking fetch with a spinner — no queue-position/ETA messaging.
- `apps/api/app/core/config.py` has no concurrency or rate-limit tuning settings today.

## Scope decision (from clarifying questions)

Given this repo's repeated precedent for deferring full job-table/worker infrastructure (Epic 9's metering/drift-check gaps, parsing's still-synchronous model), this issue is scoped to **in-process concurrency limiting + synchronous queueing** — not a real async job table/worker. The HTTP request still blocks end-to-end; the goal is graceful degradation and fairness, not converting generation into a background job.

## Design

### 1. Concurrency limiter + fair-use scheduler

New `apps/api/app/services/ai/scheduler.py`:

- A process-wide `asyncio.Semaphore(max_concurrent)` (new config: `max_concurrent_ai_calls`, sensible default e.g. 3-5) caps simultaneous Claude calls.
- A per-workspace FIFO round-robin structure: each workspace gets its own sub-queue; when a semaphore slot frees, the scheduler dispatches from whichever workspace has waited longest since its last dispatch — true round-robin, not global FIFO, so one workspace queuing many requests can't starve another workspace's single request.
- All state is in-process (module-level), no new DB table, no background worker loop. Acceptable given current scale and consistent with this repo's no-broker philosophy.

### 2. Request flow

`run_generation()`'s caller (the generation router) wraps the call through the scheduler: enqueue → await turn → run → return. The scheduler records `queue_wait_seconds` and `queue_depth_at_submit` (how many requests were ahead across all workspaces at submission time), surfaced in the generation response so the caller isn't left with zero visibility into why a request took longer than the AI calls alone would suggest.

### 3. Rate-limit error handling

Existing Issue 1.4 SDK-level retry/error-wrapping is untouched. The generation router's handling of a resulting `AIGenerationError` is reviewed/tightened to guarantee a clear, user-facing message — never a raw provider exception string — satisfying the third acceptance criterion, which is largely already met structurally.

### 4. Frontend UX

`onboarding-wizard.tsx`'s `triggerGenerate()` surfaces the response's `queue_wait_seconds`/`queue_depth_at_submit` if present (i.e., if the request had to wait), showing "waited Xs behind N other requests" messaging rather than a bare spinner for the whole duration. A pre-flight queue-depth check is explicitly NOT built (out of scope) — showing the wait retroactively in the same response is simpler and avoids a second endpoint/round-trip, while still satisfying "not a silent hang or generic error" since the final state is informative.

## Testing

- Unit tests for the scheduler: concurrency cap enforced (Nth request blocks until a slot frees), round-robin fairness (workspace B's single request isn't starved behind workspace A's queued burst), `queue_wait_seconds`/`queue_depth_at_submit` correctness.
- Router-level test confirming a `RateLimitError`-wrapped `AIGenerationError` surfaces as a clean, specific user-facing message, not a raw exception string.
- Existing generation pipeline tests must continue to pass unchanged — the scheduler wraps the call, it doesn't change pipeline behavior.

## Out of scope

- Real Postgres-backed job table / background worker / job status polling endpoint.
- Cross-replica coordination (in-process only; a second API replica has its own independent semaphore/queue — acceptable at current scale, same caveat as Issue 12.2's proactive pacing).
- Changes to the existing SDK-level retry/backoff logic (Issue 1.4).
- A dedicated pre-flight "check queue depth before committing" endpoint.
