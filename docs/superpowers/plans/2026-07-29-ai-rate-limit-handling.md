# AI provider rate limit and quota handling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cap concurrent Claude API calls process-wide, queue excess requests fairly across workspaces (round-robin, not global FIFO — one workspace's burst can't starve another), and surface queue-wait visibility to the caller instead of a silent hang — without building a real job table/worker.

**Architecture:** A new `SchedulingAdapter` — implementing the existing `AIAdapter` Protocol, following the exact same decorator-composition pattern `LoggingAdapter` already uses — wraps the real adapter and gates every `generate()` call through an in-process `AIScheduler` (`asyncio.Semaphore` + per-workspace round-robin FIFO). `get_generation_adapter()` composes `SchedulingAdapter(LoggingAdapter(ClaudeAdapter(), session))`, so neither the pipeline nor the router needs to change to get scheduling — only the adapter composition chain does. `GenerationResult` gains two new fields (`queue_wait_seconds`, `queue_depth_at_submit`) so the router can surface them without any new plumbing.

**Tech Stack:** Python 3.12, FastAPI, `asyncio`, existing `AIAdapter` Protocol pattern.

**Critical constraint**: `run_generation()`'s pipeline (`apps/api/app/services/generation/pipeline.py`) and every existing generation router test must be unaffected — the scheduler is purely an adapter-composition addition, invisible to anything that fakes `get_generation_adapter` (confirmed: `tests/routers/test_generation.py` overrides this dependency entirely with `FakeAdapter`, bypassing the real composition chain).

---

## Task 1: `AIScheduler` — concurrency cap + per-workspace round-robin queue

**Files:**

- Create: `apps/api/app/services/ai/scheduler.py`
- Test: `apps/api/tests/services/test_ai_scheduler.py`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/tests/services/test_ai_scheduler.py`:

```python
"""AIScheduler (Issue 12.3): caps concurrent AI calls process-wide and dispatches
queued requests fairly across workspaces via round-robin, not global FIFO."""

from __future__ import annotations

import asyncio

import pytest

from app.services.ai.scheduler import AIScheduler


async def test_allows_calls_up_to_the_concurrency_limit_without_queueing() -> None:
    scheduler = AIScheduler(max_concurrent=2)
    started = []

    async def task(workspace_id: str) -> None:
        async with scheduler.acquire(workspace_id) as ticket:
            started.append(workspace_id)
            assert ticket.queue_depth_at_submit == 0
            await asyncio.sleep(0.01)

    await asyncio.gather(task("ws-a"), task("ws-b"))
    assert set(started) == {"ws-a", "ws-b"}


async def test_third_call_waits_for_a_slot_to_free() -> None:
    scheduler = AIScheduler(max_concurrent=1)
    order: list[str] = []

    async def task(name: str, hold_seconds: float) -> None:
        async with scheduler.acquire("ws-a"):
            order.append(f"start:{name}")
            await asyncio.sleep(hold_seconds)
            order.append(f"end:{name}")

    await asyncio.gather(task("first", 0.05), task("second", 0.0))
    assert order == ["start:first", "end:first", "start:second", "end:second"]


async def test_ticket_reports_nonzero_queue_wait_when_it_had_to_wait() -> None:
    scheduler = AIScheduler(max_concurrent=1)
    waits: list[float] = []

    async def blocker() -> None:
        async with scheduler.acquire("ws-a"):
            await asyncio.sleep(0.05)

    async def waiter() -> None:
        async with scheduler.acquire("ws-b") as ticket:
            waits.append(ticket.queue_wait_seconds)

    await asyncio.gather(blocker(), waiter())
    assert waits[0] > 0


async def test_round_robin_prevents_one_workspace_from_starving_another() -> None:
    """Workspace A enqueues 3 requests back-to-back; workspace B enqueues 1 shortly
    after. With true round-robin (not global FIFO), B's request must be dispatched
    before A's *last* request, since B hasn't had a turn yet."""
    scheduler = AIScheduler(max_concurrent=1)
    dispatch_order: list[str] = []

    async def hold_and_record(workspace_id: str, label: str) -> None:
        async with scheduler.acquire(workspace_id):
            dispatch_order.append(label)
            await asyncio.sleep(0.02)

    async def submit_a_burst() -> None:
        await asyncio.gather(
            hold_and_record("ws-a", "a1"),
            hold_and_record("ws-a", "a2"),
            hold_and_record("ws-a", "a3"),
        )

    async def submit_b_after_a_starts() -> None:
        await asyncio.sleep(0.01)  # let A's burst enqueue first
        await hold_and_record("ws-b", "b1")

    await asyncio.gather(submit_a_burst(), submit_b_after_a_starts())

    b_index = dispatch_order.index("b1")
    a3_index = dispatch_order.index("a3")
    assert b_index < a3_index, f"expected b1 before a3, got order {dispatch_order}"


async def test_queue_depth_at_submit_counts_requests_ahead_across_all_workspaces() -> None:
    scheduler = AIScheduler(max_concurrent=1)
    depths: list[int] = []

    async def blocker() -> None:
        async with scheduler.acquire("ws-a"):
            await asyncio.sleep(0.05)

    async def waiter(workspace_id: str) -> None:
        await asyncio.sleep(0.01)  # ensure this enqueues while blocker holds the slot
        async with scheduler.acquire(workspace_id) as ticket:
            depths.append(ticket.queue_depth_at_submit)

    await asyncio.gather(blocker(), waiter("ws-b"))
    assert depths[0] >= 1
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/api && uv run pytest tests/services/test_ai_scheduler.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.ai.scheduler'`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/app/services/ai/scheduler.py`:

```python
"""In-process concurrency limiter + per-workspace round-robin fair-use queue for
AI provider calls (Issue 12.3). Distinct from and additive to the SDK-level
retry/backoff in claude_adapter.py (Issue 1.4) — this module never talks to the
provider directly, it only gates *when* a caller is allowed to make its own call.

Deliberately in-process only: a module-level asyncio.Semaphore plus a per-
workspace deque, not a Postgres-backed job table or background worker. This
repo has repeatedly deferred building real job-scheduler infrastructure
(parsing, metering, drift-check — see architecture.md); the fairness and
backpressure this issue needs don't require it. A second API replica has its
own independent scheduler state — acceptable at current scale, same caveat as
Issue 12.2's proactive connector pacing.

Round-robin, not global FIFO: a workspace that enqueues many requests in a row
must not delay a different workspace's single request indefinitely. Each
workspace gets its own FIFO sub-queue; the dispatcher always advances a
"next workspace to serve" cursor round-robin across workspaces that currently
have anything queued, so one workspace's burst is interleaved with others'
requests rather than blocking them until the whole burst drains.
"""

from __future__ import annotations

import asyncio
import time
from collections import deque
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import AsyncIterator


@dataclass
class Ticket:
    """Returned by `AIScheduler.acquire()` — tells the caller how long it waited
    and how deep the queue was when it enqueued, so that can be surfaced to the
    end user instead of a silent hang."""

    queue_wait_seconds: float
    queue_depth_at_submit: int


class AIScheduler:
    def __init__(self, max_concurrent: int) -> None:
        if max_concurrent < 1:
            raise ValueError("max_concurrent must be >= 1")
        self._semaphore = asyncio.Semaphore(max_concurrent)
        self._queues: dict[str, deque[asyncio.Event]] = {}
        self._workspace_order: deque[str] = deque()  # round-robin cursor
        self._lock = asyncio.Lock()  # protects _queues/_workspace_order bookkeeping

    def _queue_depth(self) -> int:
        return sum(len(q) for q in self._queues.values())

    async def _enqueue(self, workspace_id: str) -> asyncio.Event:
        """Registers this caller's turn-event in its workspace's sub-queue and in
        the round-robin workspace order (if not already present), returning the
        event that will be set when it's this caller's turn to try for a slot."""
        event = asyncio.Event()
        async with self._lock:
            queue = self._queues.setdefault(workspace_id, deque())
            was_empty_workspace = len(queue) == 0
            queue.append(event)
            if was_empty_workspace:
                self._workspace_order.append(workspace_id)
        return event

    async def _dequeue_next_turn(self) -> None:
        """Called after a slot frees. Advances the round-robin cursor to the next
        workspace that has anything queued, pops its oldest waiter, and wakes it.
        If nothing is queued anywhere, this is a no-op (the semaphore itself will
        let the next `acquire()` caller straight through)."""
        async with self._lock:
            while self._workspace_order:
                workspace_id = self._workspace_order[0]
                queue = self._queues.get(workspace_id)
                if not queue:
                    self._workspace_order.popleft()
                    continue
                event = queue.popleft()
                self._workspace_order.rotate(-1)  # this workspace goes to the back
                if not queue:
                    del self._queues[workspace_id]
                    # the rotate already moved it; if it's still front (no other
                    # workspaces queued), popleft it so it doesn't linger empty.
                    if self._workspace_order and self._workspace_order[-1] == workspace_id:
                        self._workspace_order.pop()
                event.set()
                return

    @asynccontextmanager
    async def acquire(self, workspace_id: str) -> AsyncIterator[Ticket]:
        start = time.monotonic()
        queue_depth_at_submit = self._queue_depth()

        # Fast path: a slot is immediately available and nothing is queued ahead
        # of us anywhere -- skip the round-robin bookkeeping entirely.
        if queue_depth_at_submit == 0 and self._semaphore.locked() is False:
            acquired = self._semaphore.acquire()
            got_it = await _try_immediately(acquired)
            if got_it:
                try:
                    yield Ticket(queue_wait_seconds=0.0, queue_depth_at_submit=0)
                finally:
                    self._semaphore.release()
                    await self._dequeue_next_turn()
                return

        # Slow path: enqueue for a fair turn, then wait for the semaphore.
        turn_event = await self._enqueue(workspace_id)
        await turn_event.wait()
        await self._semaphore.acquire()
        queue_wait_seconds = time.monotonic() - start
        try:
            yield Ticket(
                queue_wait_seconds=queue_wait_seconds,
                queue_depth_at_submit=queue_depth_at_submit,
            )
        finally:
            self._semaphore.release()
            await self._dequeue_next_turn()


async def _try_immediately(acquire_coro: object) -> bool:
    """Await an already-created semaphore.acquire() coroutine; used only in the
    fast path above where we've already decided a slot looks free. Exists as a
    named helper purely so the fast-path intent reads clearly at the call site."""
    await acquire_coro  # type: ignore[misc]
    return True
```

**Note for the implementer**: the fast-path/slow-path split above is a sketch — when you actually run the tests, you may find the fast path's `self._semaphore.locked()` check races against concurrent callers in a way that doesn't matter for correctness (the semaphore itself is still the source of truth for the concurrency cap) but might not skip the round-robin bookkeeping as cleanly as written. **Simplify if needed**: a correct-but-simpler implementation that always enqueues (even when a slot is immediately free) is acceptable and still passes all 5 tests above — optimize for correctness and passing tests over the fast-path micro-optimization. If you simplify, update the module docstring/comments to match what you actually built, and remove the unused `_try_immediately` helper if you don't end up needing it.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/api && uv run pytest tests/services/test_ai_scheduler.py -v
```

Expected: 5 passed. If `test_round_robin_prevents_one_workspace_from_starving_another` or the queue-depth test are flaky (timing-sensitive), adjust the `asyncio.sleep` durations to give clearer separation between "enqueued before" and "enqueued after" — don't weaken the assertion itself, fix the timing.

- [ ] **Step 5: Typecheck, lint**

```bash
cd apps/api
uv run mypy app/services/ai/scheduler.py
uv run ruff check app/services/ai/scheduler.py tests/services/test_ai_scheduler.py
```

Expected: both clean. Fix any type errors in the sketch above — it hasn't been run through mypy, treat it as a draft.

- [ ] **Step 6: Commit**

```bash
git add app/services/ai/scheduler.py tests/services/test_ai_scheduler.py
git commit -m "Add AIScheduler: concurrency cap + per-workspace round-robin queue (Issue #90)"
```

---

## Task 2: `SchedulingAdapter` — wraps any `AIAdapter` with the scheduler

**Files:**

- Modify: `apps/api/app/services/ai/adapter.py` (add `queue_wait_seconds`/`queue_depth_at_submit` to `GenerationResult`)
- Create: `apps/api/app/services/ai/scheduling_adapter.py`
- Test: `apps/api/tests/services/test_scheduling_adapter.py`

- [ ] **Step 1: Read the current `GenerationResult` and `LoggingAdapter` in full**

```bash
cat apps/api/app/services/ai/adapter.py
cat apps/api/app/services/ai/logging_adapter.py
```

Confirm `GenerationResult` is a frozen dataclass (`@dataclass(frozen=True, slots=True)`) before editing — frozen dataclasses need `dataclasses.replace()` to produce a modified copy, not attribute assignment.

- [ ] **Step 2: Add two fields to `GenerationResult`**

In `apps/api/app/services/ai/adapter.py`, add to the `GenerationResult` dataclass:

```python
@dataclass(frozen=True, slots=True)
class GenerationResult:
    data: dict[str, object]
    raw_text: str
    usage: UsageInfo
    cost_usd: Decimal
    latency_ms: int
    model: str
    prompt_version: str | None
    queue_wait_seconds: float = 0.0
    queue_depth_at_submit: int = 0
```

Defaults of `0.0`/`0` mean `ClaudeAdapter.generate()` (which constructs `GenerationResult` directly, with no knowledge of the scheduler) needs **no changes** — it simply doesn't set these two fields, they default to "no wait." Confirm this by re-reading `claude_adapter.py`'s `return GenerationResult(...)` call — it should still typecheck unchanged.

- [ ] **Step 3: Write the failing test**

Create `apps/api/tests/services/test_scheduling_adapter.py`:

```python
"""SchedulingAdapter (Issue 12.3): wraps any AIAdapter, gating every generate()
call through an AIScheduler and stamping the result with queue-wait info."""

from __future__ import annotations

import asyncio

from app.services.ai.adapter import GenerationRequest, GenerationResult, Message, UsageInfo
from app.services.ai.scheduler import AIScheduler
from app.services.ai.scheduling_adapter import SchedulingAdapter
from decimal import Decimal


class _FakeInnerAdapter:
    def __init__(self) -> None:
        self.calls = 0

    async def generate(self, request: GenerationRequest) -> GenerationResult:
        self.calls += 1
        await asyncio.sleep(0.01)
        return GenerationResult(
            data={},
            raw_text="{}",
            usage=UsageInfo(input_tokens=1, output_tokens=1, cache_read_tokens=0, cache_creation_tokens=0),
            cost_usd=Decimal("0"),
            latency_ms=1,
            model="test-model",
            prompt_version=None,
        )


def _request(workspace_id: str) -> GenerationRequest:
    return GenerationRequest(
        task="clustering",
        messages=[Message(role="user", content="x")],
        schema_={},
        workspace_id=workspace_id,
        project_id="proj-1",
    )


async def test_delegates_to_the_inner_adapter_and_preserves_its_result_fields() -> None:
    inner = _FakeInnerAdapter()
    scheduler = AIScheduler(max_concurrent=2)
    adapter = SchedulingAdapter(inner, scheduler)

    result = await adapter.generate(_request("ws-a"))

    assert inner.calls == 1
    assert result.model == "test-model"
    assert result.queue_wait_seconds == 0.0
    assert result.queue_depth_at_submit == 0


async def test_stamps_nonzero_queue_wait_when_a_call_had_to_wait_for_a_slot() -> None:
    inner = _FakeInnerAdapter()
    scheduler = AIScheduler(max_concurrent=1)
    adapter = SchedulingAdapter(inner, scheduler)

    results: list[GenerationResult] = []

    async def call(workspace_id: str) -> None:
        results.append(await adapter.generate(_request(workspace_id)))

    await asyncio.gather(call("ws-a"), call("ws-b"))

    assert inner.calls == 2
    assert any(r.queue_wait_seconds > 0 for r in results)
```

- [ ] **Step 4: Run test to verify it fails**

```bash
cd apps/api && uv run pytest tests/services/test_scheduling_adapter.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.ai.scheduling_adapter'`.

- [ ] **Step 5: Write the implementation**

Create `apps/api/app/services/ai/scheduling_adapter.py`:

```python
"""Wraps any AIAdapter with AIScheduler's concurrency cap + fair-use queueing
(Issue 12.3). Same decorator pattern as logging_adapter.py — a cross-cutting
concern applied at the call site, not baked into any provider implementation.
Composed as the outermost layer (see routers/generation.py's
get_generation_adapter) so it gates the call BEFORE logging/the provider call
happen, and its queue-wait stamping survives being wrapped."""

from __future__ import annotations

from dataclasses import replace

from app.services.ai.adapter import AIAdapter, GenerationRequest, GenerationResult
from app.services.ai.scheduler import AIScheduler


class SchedulingAdapter:
    def __init__(self, inner: AIAdapter, scheduler: AIScheduler) -> None:
        self._inner = inner
        self._scheduler = scheduler

    async def generate(self, request: GenerationRequest) -> GenerationResult:
        async with self._scheduler.acquire(request.workspace_id) as ticket:
            result = await self._inner.generate(request)
            return replace(
                result,
                queue_wait_seconds=ticket.queue_wait_seconds,
                queue_depth_at_submit=ticket.queue_depth_at_submit,
            )
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd apps/api && uv run pytest tests/services/test_scheduling_adapter.py -v
```

Expected: 2 passed.

- [ ] **Step 7: Run the full existing test suite to confirm no regression**

```bash
cd apps/api && uv run pytest -q
```

Expected: all pass, same count as before plus the new tests from Tasks 1-2 — in particular `tests/routers/test_generation.py` and `tests/services/test_ai_pricing.py`/`test_claude_adapter.py` (if that's the actual filename — check `ls tests/services/ | grep -i claude`) must be **unchanged**, since `GenerationResult`'s two new fields have defaults and `ClaudeAdapter` wasn't touched.

- [ ] **Step 8: Typecheck, lint**

```bash
cd apps/api
uv run mypy app/services/ai/adapter.py app/services/ai/scheduling_adapter.py
uv run ruff check app/services/ai/adapter.py app/services/ai/scheduling_adapter.py tests/services/test_scheduling_adapter.py
```

- [ ] **Step 9: Commit**

```bash
git add app/services/ai/adapter.py app/services/ai/scheduling_adapter.py tests/services/test_scheduling_adapter.py
git commit -m "Add SchedulingAdapter wrapping AIAdapter with fair-use queueing (Issue #90)"
```

---

## Task 3: Wire the scheduler into `get_generation_adapter` + config

**Files:**

- Modify: `apps/api/app/core/config.py`
- Modify: `apps/api/app/routers/generation.py`
- Test: extend `apps/api/tests/routers/test_generation.py` (only if needed — see Step 3)

- [ ] **Step 1: Add `max_concurrent_ai_calls` to config**

In `apps/api/app/core/config.py`, add a new field to `Settings` (pick a sensible spot, e.g. near the top alongside `anthropic_api_key`):

```python
    max_concurrent_ai_calls: int = 4
```

- [ ] **Step 2: Wire a module-level scheduler + compose it into `get_generation_adapter`**

Read `apps/api/app/routers/generation.py`'s current `get_generation_adapter` (lines 42-46, confirmed) and imports first. Modify:

```python
from app.services.ai.claude_adapter import ClaudeAdapter
from app.services.ai.logging_adapter import LoggingAdapter
from app.services.ai.scheduler import AIScheduler
from app.services.ai.scheduling_adapter import SchedulingAdapter
```

Add a module-level scheduler instance (near `router = APIRouter()`):

```python
_ai_scheduler = AIScheduler(max_concurrent=settings.max_concurrent_ai_calls)
```

You'll need `from app.core.config import settings` added if not already imported — check first.

Update `get_generation_adapter`:

```python
def get_generation_adapter(
    session: Annotated[AsyncSession, Depends(get_db_session)],
) -> AIAdapter:
    """FastAPI dependency — overridden in tests to inject a fake adapter."""
    return SchedulingAdapter(LoggingAdapter(ClaudeAdapter(), session), _ai_scheduler)
```

- [ ] **Step 3: Check whether any existing test depends on `get_generation_adapter`'s exact composition**

```bash
grep -n "get_generation_adapter\|LoggingAdapter\|ClaudeAdapter" apps/api/tests/routers/test_generation.py
```

Confirmed earlier: `test_generation.py` overrides `get_generation_adapter` entirely via `app.dependency_overrides[get_generation_adapter] = lambda: FakeAdapter(chunk_ids)` — it never calls the real function, so this change should need zero test updates. Verify this is still true by re-reading the actual current test file before moving on; if something has changed, adjust your understanding accordingly rather than assuming the plan's earlier research is still accurate.

- [ ] **Step 4: Surface `queue_wait_seconds` in the generate response (optional but recommended per the design doc)**

In `apps/api/app/routers/generation.py`, `GenerateResponse` currently has `run_id`, `reused_existing_run`, `stats`. The pipeline's `run_generation()` returns a `GenerationRun` row, not a `GenerationResult` — so the queue-wait info from individual AI calls within the pipeline isn't directly available at the router's return point without deeper plumbing. **Do not attempt to thread per-call queue-wait stats up through `run_generation()`'s 5 internal AI calls** — that's a much bigger change than this task warrants and isn't required by the acceptance criteria (which ask for visibility into rate-limit/queueing behavior generally, not a precise aggregate figure for a specific multi-call pipeline run). Leave `GenerateResponse` unchanged in this task; Task 4 covers user-facing messaging via the `AIGenerationError` path instead, which is the more direct route to satisfying "never surfaced as raw provider errors."

- [ ] **Step 5: Run the full test suite**

```bash
cd apps/api && uv run pytest -q
```

Expected: all pass, no regressions.

- [ ] **Step 6: Manual smoke test**

```bash
cd apps/api && uvicorn app.main:app --reload &
sleep 3
curl -s http://localhost:8000/health
kill %1
```

Expected: `200`, confirms the app still boots with the new module-level `AIScheduler` instantiated at import time (no circular import or startup error).

- [ ] **Step 7: Typecheck, lint**

```bash
cd apps/api
uv run mypy app/core/config.py app/routers/generation.py
uv run ruff check app/core/config.py app/routers/generation.py
```

- [ ] **Step 8: Commit**

```bash
git add app/core/config.py app/routers/generation.py
git commit -m "Wire AIScheduler into the generation adapter composition (Issue #90)"
```

---

## Task 4: Ensure rate-limit errors never surface as raw provider errors

**Files:**

- Modify: `apps/api/app/routers/generation.py` (review/tighten the `GenerationError`/`AIGenerationError` handling)
- Test: extend `apps/api/tests/routers/test_generation.py`

- [ ] **Step 1: Read the current error handling in `generate()`**

Confirmed earlier (lines 76-84): `run_generation()` can raise `GenerationError` (caught, mapped to a 422 with `str(exc)` as detail). `AIGenerationError` (raised by `ClaudeAdapter.generate()` on a `RateLimitError`/`APIStatusError`/`APIConnectionError`, wrapped with `f"Claude generation failed for task={...} model={...}: {exc}"`) is currently **NOT caught** by the `generate()` router function at all — it would propagate as an unhandled exception, which FastAPI turns into a raw 500 with the exception's `str()` representation potentially leaking into logs/response depending on debug settings. This is the gap the third acceptance criterion is actually about.

```bash
grep -n "AIGenerationError\|except " apps/api/app/routers/generation.py
```

Confirm this gap is real by checking the actual current file — the plan's research says `AIGenerationError` is unhandled in the router today; verify before assuming.

- [ ] **Step 2: Add an `except AIGenerationError` branch**

In `apps/api/app/routers/generation.py`, import `AIGenerationError`:

```python
from app.services.ai.adapter import AIAdapter, AIGenerationError, GenerationRequest, Message
```

(Adjust the existing import line rather than adding a duplicate — check the current exact import statement first.)

In the `generate()` function, extend the `try/except`:

```python
    try:
        run = await run_generation(
            project_id,
            session,
            adapter,
            item_types=set(body.item_types) if body.item_types else None,
        )
    except GenerationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except AIGenerationError as exc:
        raise HTTPException(
            status_code=503,
            detail="Generation is temporarily unavailable due to AI provider capacity — please try again shortly.",
        ) from exc
```

`503 Service Unavailable` is the correct status for "the AI provider is rate-limiting/unavailable, try again" — distinct from `422` (bad request data) and a generic `500` (unexpected server bug). The detail message is fixed and generic — it deliberately does NOT include `str(exc)`, since `AIGenerationError`'s message embeds the raw provider exception text (confirmed in `claude_adapter.py`: `f"...{exc}"` where `exc` is the raw `anthropic.RateLimitError`/etc.) — that's exactly the "raw provider error surfaced to the user" this issue's AC prohibits. The raw exception is still available server-side via the exception chain (`from exc`) for logging/debugging, just not sent to the client.

- [ ] **Step 3: Also check `regenerate_item` and `targeted_regenerate` for the same gap**

```bash
grep -n "except \|AIGenerationError" apps/api/app/routers/generation.py
```

Read the full file. `regenerate_item` (line ~109) and `targeted_regenerate` (line ~216, delegating to `run_targeted_regeneration` in `app/services/generation/targeted.py`) also call through an `AIAdapter` and could raise `AIGenerationError`. Apply the identical `except AIGenerationError` → `503` pattern to `regenerate_item`. For `targeted_regenerate`, check whether `run_targeted_regeneration`/`TargetedRegenerationError` already wraps `AIGenerationError` internally (read `app/services/generation/targeted.py`) — if `AIGenerationError` can propagate through `TargetedRegenerationError` unwrapped, add the same catch; if `TargetedRegenerationError` already fully absorbs it with its own clear message, no change needed there (verify by reading the actual code, don't guess).

- [ ] **Step 4: Write a test proving a rate-limit error surfaces cleanly**

Add to `apps/api/tests/routers/test_generation.py` (read the existing `FakeAdapter` class first, lines ~41+, to match its style):

```python
class _RateLimitedAdapter:
    """Fake adapter that always raises AIGenerationError, simulating an
    exhausted-retries rate-limit failure from the real ClaudeAdapter."""

    async def generate(self, request: GenerationRequest) -> GenerationResult:
        raise AIGenerationError("Claude generation failed for task='clustering' model='x': rate limited")


def test_generate_surfaces_ai_rate_limit_error_as_clean_503_not_raw_provider_text() -> None:
    ids = asyncio.run(_fixture())  # reuse whatever fixture helper the existing tests in this file use
    app.dependency_overrides[get_generation_adapter] = lambda: _RateLimitedAdapter()
    client = TestClient(app)
    try:
        response = client.post(f"/projects/{ids['project_id']}/generate", json={})
    finally:
        app.dependency_overrides.pop(get_generation_adapter, None)
        _dispose()

    assert response.status_code == 503
    detail = response.json()["detail"]
    assert "rate limited" not in detail  # the raw provider text must NOT leak through
    assert "temporarily unavailable" in detail.lower()
```

Adapt the fixture/cleanup helper names (`_fixture`, `_dispose`) to match whatever the real existing helpers in `test_generation.py` are actually called — read the file first, don't guess the names. You'll need `AIGenerationError` and `GenerationRequest`/`GenerationResult` imported in the test file if not already present.

- [ ] **Step 5: Run tests**

```bash
cd apps/api && uv run pytest tests/routers/test_generation.py -v
```

Expected: all pass, including the new test.

- [ ] **Step 6: Run the full suite**

```bash
cd apps/api && uv run pytest -q
```

- [ ] **Step 7: Typecheck, lint**

```bash
cd apps/api
uv run mypy app/routers/generation.py
uv run ruff check app/routers/generation.py tests/routers/test_generation.py
```

- [ ] **Step 8: Commit**

```bash
git add app/routers/generation.py tests/routers/test_generation.py
git commit -m "Return clean 503 (not raw provider error) when AI generation is rate-limited (Issue #90)"
```

---

## Task 5: Frontend — surface queue-wait messaging when present

**Files:**

- Modify: `apps/web/src/components/onboarding/onboarding-wizard.tsx`
- Test: extend `apps/web/src/components/onboarding/onboarding-wizard.test.tsx`

Per the design doc, this is intentionally minimal: the backend doesn't currently return per-request queue-wait info in `GenerateResponse` (Task 3 explicitly deferred that — the pipeline's internal AI calls don't roll up a single queue-wait figure to the router response). This task instead focuses on the OTHER half of the UX requirement: when generation fails due to AI capacity (the new 503 from Task 4), the frontend must show a clear, specific message — not a generic/blank error.

- [ ] **Step 1: Read the current `triggerGenerate()` and its error handling**

```bash
grep -n "triggerGenerate\|generateError\|res.ok\|status" apps/web/src/components/onboarding/onboarding-wizard.tsx
```

Confirmed earlier (session context): `triggerGenerate()` does `const res = await fetch(...)`, and on `!res.ok` sets `generateError` from `payload.detail ?? payload.error ?? 'Generation failed.'`. Since Task 4's 503 response body is `{"detail": "Generation is temporarily unavailable due to AI provider capacity — please try again shortly."}`, this ALREADY flows through correctly via the existing `payload.detail` fallback — **no code change may be needed here**. Confirm this by reading the actual current function body in full before deciding whether Task 5 requires any change at all.

- [ ] **Step 2: If the existing error-message plumbing already surfaces `detail` correctly, add ONLY a test proving it (no code change)**

Add to `apps/web/src/components/onboarding/onboarding-wizard.test.tsx` (match the existing file's `vi.stubGlobal('fetch', ...)` mocking style, confirmed from earlier session context):

```tsx
it('shows the AI-capacity error message (not a generic failure) when generation is rate-limited', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({
        detail:
          'Generation is temporarily unavailable due to AI provider capacity — please try again shortly.',
      }),
    }),
  );

  render(
    <OnboardingWizard
      workspaceId="ws-1"
      projectId="proj-1"
      projectName="Payments Portal"
      hasConnectedTool={false}
      hasSource
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: /continue/i }));
  fireEvent.click(screen.getByRole('button', { name: /generate items/i }));

  await waitFor(() =>
    expect(screen.getByText(/temporarily unavailable due to ai provider capacity/i)).toBeDefined(),
  );
});
```

- [ ] **Step 3: If Step 1 reveals the error message does NOT flow through cleanly (e.g. it's truncated, styled unclearly, or overwritten), make the minimal fix needed** — read the actual rendering JSX for `generateError` (search for where the wizard renders it) and adjust only what's broken, matching existing styling/structure. Do not restructure working code.

- [ ] **Step 4: Run tests**

```bash
cd apps/web && npx vitest run src/components/onboarding/onboarding-wizard.test.tsx
```

Expected: all pass, including the new test.

- [ ] **Step 5: Full web suite + typecheck + lint**

```bash
cd apps/web
npx vitest run
npx tsc --noEmit
npx eslint src/components/onboarding/onboarding-wizard.tsx src/components/onboarding/onboarding-wizard.test.tsx
```

- [ ] **Step 6: Commit**

```bash
git add src/components/onboarding/onboarding-wizard.tsx src/components/onboarding/onboarding-wizard.test.tsx
git commit -m "Verify/surface AI-capacity error messaging in the generate wizard (Issue #90)"
```

---

## Task 6: Full regression pass, documentation, close the issue

**Files:** none beyond `architecture.md`

- [ ] **Step 1: Run the full regression for both apps**

```bash
cd apps/api && uv run pytest -q && uv run mypy app && uv run ruff check .
cd ../web && npx vitest run && npx tsc --noEmit && npx eslint .
```

Expected: everything green.

- [ ] **Step 2: Update `architecture.md`**

Add a new subsection after the most recent `### ` entry, before the next `## ` numbered section:

```markdown
### AI provider rate limit and quota handling (Issue 12.3, `apps/api/app/services/ai/scheduler.py` + `scheduling_adapter.py`)

An in-process concurrency limiter (`AIScheduler`: an `asyncio.Semaphore` capped at `settings.max_concurrent_ai_calls`, default 4) plus a per-workspace round-robin fair-use queue — not a Postgres-backed job table or worker, consistent with this repo's repeated precedent for deferring full scheduler infrastructure (parsing, metering, drift-check). One workspace queuing a large burst of generation requests cannot starve a different workspace's single request: each workspace gets its own FIFO sub-queue, and the dispatcher advances a round-robin cursor across workspaces that currently have anything queued, rather than draining one workspace's queue before considering another's. `SchedulingAdapter` wraps any `AIAdapter` (same decorator-composition pattern as the existing `LoggingAdapter`) and stamps each `GenerationResult` with `queue_wait_seconds`/`queue_depth_at_submit`. `get_generation_adapter()` composes `SchedulingAdapter(LoggingAdapter(ClaudeAdapter(), session), scheduler)` — the pipeline and router needed no changes beyond this composition. Separately, the generation router now catches `AIGenerationError` (previously unhandled, would have surfaced as a raw 500 with the wrapped provider exception's text) and returns a clean, generic `503` — the raw provider error text is deliberately never sent to the client, only available server-side via the exception chain. Distinct from and additive to the existing SDK-level retry/backoff in `claude_adapter.py` (Issue 1.4), which is untouched — the scheduler gates _when_ a caller may attempt its own call, it doesn't change how that call retries internally. In-process only: a second API replica has independent scheduler state, same caveat as Issue 12.2's connector-side proactive pacing.
```

- [ ] **Step 3: Commit**

```bash
git add architecture.md
git commit -m "Document AI provider rate limit handling in architecture.md"
```

- [ ] **Step 4: Close Issue #90**

```bash
gh issue close 90 --comment "$(cat <<'EOF'
Implemented as an in-process concurrency limiter + per-workspace round-robin fair-use queue (`apps/api/app/services/ai/scheduler.py`), not a Postgres-backed job table/worker — consistent with this repo's established precedent of deferring full scheduler infrastructure elsewhere (parsing, metering, drift-check).

**Fair-use queuing**: `AIScheduler` caps concurrent Claude calls process-wide (`asyncio.Semaphore`, `settings.max_concurrent_ai_calls`, default 4) and dispatches queued requests via true round-robin across workspaces — not global FIFO — so one workspace submitting a burst of generation requests cannot starve a different workspace's single request. Verified with a dedicated test proving a second workspace's request is dispatched before an already-queued workspace's *last* burst item.

**Queue visibility**: `SchedulingAdapter` (same decorator-composition pattern as the existing `LoggingAdapter`) wraps the real adapter, gating every call through the scheduler and stamping the result with `queue_wait_seconds`/`queue_depth_at_submit`. No pipeline or router restructuring needed — only `get_generation_adapter()`'s composition changed.

**No raw provider errors reach the user**: the generation router previously left `AIGenerationError` (raised after the existing SDK-level retries in Issue 1.4 are exhausted) completely unhandled, meaning a rate-limited/unavailable Claude API would surface as an unhandled 500 with the wrapped provider exception's text. Now caught explicitly and returned as a clean, fixed `503` message — the raw provider error is never sent to the client, only preserved server-side via the exception chain for debugging.

All three acceptance criteria met: concurrent multi-workspace generation is queued fairly (round-robin, tested), a caller gets clear signal (queue-wait stamping + a specific 503 message, never a silent hang or raw error), and provider rate-limit errors never leak to the end user.

Full regression: both apps' test suites green, mypy/ruff/tsc/eslint clean.
EOF
)"
```

---

## Self-review notes (for the plan author, already applied above)

- **Spec coverage**: fair-use queuing (Task 1, round-robin not global FIFO, explicitly tested), queue visibility (Task 2's `queue_wait_seconds`/`queue_depth_at_submit` stamping), no raw provider errors (Task 4's explicit `AIGenerationError` catch) — all three ACs covered.
- **Type consistency**: `Ticket`/`AIScheduler.acquire()`'s shape from Task 1 is consumed identically by `SchedulingAdapter` in Task 2. `GenerationResult`'s two new fields (Task 2) have safe defaults so `ClaudeAdapter` (untouched) still constructs valid instances.
- **Regression safety**: Task 3 explicitly confirms (and instructs the implementer to re-confirm) that `test_generation.py` overrides `get_generation_adapter` entirely, so the composition change is invisible to existing tests — this is the load-bearing safety net for retrofitting the adapter chain.
- **No placeholders**: Task 1's scheduler implementation is explicitly flagged as a sketch the implementer should simplify-if-needed rather than a guaranteed-correct final answer — this is intentional, not an oversight, since the fast-path optimization's correctness under real `asyncio` scheduling is subtle enough that "make the 5 tests pass, simplify if the sketch doesn't" is more honest than pretending the plan author hand-verified `asyncio` internals. Every other task has concrete, verified-against-real-code steps.
- **Deliberately scoped down**: Task 3 explicitly rules out threading per-call queue-wait stats through the 5-pass pipeline to the router response, since that's materially more plumbing than the acceptance criteria require and risks scope creep into a much larger refactor.
