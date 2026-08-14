# Publish retry backoff holding an open DB transaction — design

Issue #106 (follow-up to #89, outbound rate limit handling).

## Context

Each publish router's per-candidate loop (`apps/api/app/routers/publish.py`, mirrored in `publish_ado.py`/`publish_github.py`) calls `gateway.create`/`gateway.update` — which contains the transport's internal retry-with-backoff loop (Issue #89, up to 4 attempts, up to a 30s timeout each, up to ~9s cumulative backoff sleep across 3 gaps) — from inside a loop body that has already read state via the shared `session` (`AsyncSession`) earlier in the request (e.g. the `items_result`/`published_result` queries before the loop, and the `existing = update_targets.get(...)` lookup — an in-memory dict read, but the session's transaction is already open from the earlier queries).

SQLAlchemy's `AsyncSession` begins an implicit transaction on first use and keeps it open until `commit()`/`rollback()`. Since the loop's first DB reads happen before the loop starts, and each iteration's `session.commit()` (persisting that item's `PublishedItem`/audit rows) only happens _after_ the network call returns, the network call — including all its retry sleeps — runs with an open, idle-in-transaction Postgres connection the whole time. Worst case per item: 2+ minutes with a checked-out connection doing nothing but waiting on an external API.

This isn't a correctness bug (results still commit per-item, no nested/cross-item transaction), but it's a latent connection-pool-exhaustion risk under concurrent batch publishes against a slow/struggling target API — flagged during #89's final review as a fast-follow, not a blocking defect.

## Decision

**Explicit `session.commit()` immediately before the network call**, not a larger three-phase restructure. Minimal, low-risk change: one added `await session.commit()` per router, right after the last synchronous/in-memory step and right before `gateway.create`/`gateway.update`, closing out whatever transaction is open (from the earlier batch-level queries, or the previous iteration) so the network call runs with no open transaction. The subsequent write (`PublishedItem`/`TraceLink`/`AuditEvent`/`DraftItem.flags` updates) starts a fresh transaction on its first `session.add()`/`session.flush()`/`session.execute()` after the call returns, committed exactly where the existing `await session.commit()` at the end of the loop body already is — that line doesn't move.

Rejected: restructuring into three distinct phases (fetch-all → network-only → write-all) across the whole candidate batch. It would reduce transaction churn further, but is a much larger structural change to logic that's already correct and shared near-identically across 3 routers — disproportionate risk for what the issue itself calls "not blocking, a fast-follow."

### Why this is safe with `make_rate_limit_recorder`

Each `gateway.create`/`update` call is passed `on_rate_limited=make_rate_limit_recorder(session, workspace.id, tool)` — a callback the transport invokes mid-retry-loop to record a `connector.rate_limited` audit event. `record_audit_event()` (`app/services/audit.py`) only calls `session.add(AuditEvent(...))` — no `flush`/`execute`/`commit` — so it's safe to call with no open transaction; the object stages in the session's identity map in memory and is written out whenever the next `commit()`/`flush()` happens (the one already at the end of the loop body). Verified by reading `record_audit_event`'s full body — confirmed add-only.

### Exact placement per router

In each of `publish.py`, `publish_ado.py`, `publish_github.py`, add `await session.commit()` as the last line before the `if existing is not None: outcome = await gateway.update(...) else: outcome = await gateway.create(...)` branch, inside the per-candidate loop — after the `parent_key`/blocked-check logic (which only reads the in-memory `published_keys` dict, not the DB) and after `existing = update_targets.get(...)` (also an in-memory dict read, populated once before the loop). No other loop-body ordering changes.

## Files touched

```
apps/api/app/routers/publish.py           # +1 session.commit() call, before gateway.create/update
apps/api/app/routers/publish_ado.py       # same
apps/api/app/routers/publish_github.py    # same
apps/api/tests/routers/test_publish.py           # extend: assert no open transaction is held during a simulated slow gateway.create call
apps/api/tests/routers/test_publish_ado.py       # same
apps/api/tests/routers/test_publish_github.py    # same
architecture.md                                   # document the fix
```

## Tests

The direct way to prove "no open transaction during the network call" from a test is to have the fake `gateway.create`/`update` callback itself query `pg_stat_activity` (or simpler: assert the session's own transaction state) partway through — but the existing test suites fake the gateway at the `PublishGateway.create`/`update` callable level (a plain async function substitution), which doesn't have access to the real session's transaction internals without deliberately threading it through.

Practical approach: extend one test per router's fake `create` callback to synchronously call `session.in_transaction()` (via a shared reference passed into the test's gateway closure) at the moment it's invoked, and assert it's `False` — proving the commit-before-call ordering actually took effect, not just that the code compiles. This requires the fake gateway closures to capture the real `AsyncSession` instance the router is using, which the existing test fixtures already construct and can expose.

Full regression: `cd apps/api && uv run pytest -q && uv run mypy app && uv run ruff check .` — the three existing publish test suites must pass completely unchanged in their assertions about `PublishedItem`/`TraceLink`/audit-event outcomes; only the new transaction-state assertion is additive.

## Explicitly out of scope

- The three-phase restructure (rejected above).
- Any change to the retry/backoff logic itself (Issue #89's `transport.py`) — this issue is purely about transaction lifetime around that existing logic, not the retry behavior.
- Connection pool sizing changes — the issue notes this as a related but separate concern; not touched here.
