"""In-process concurrency limiter + per-workspace round-robin fair-use queue for
AI provider calls (Issue 12.3). Distinct from and additive to the SDK-level
retry/backoff in claude_adapter.py (Issue 1.4) — this module never talks to the
provider directly, it only gates *when* a caller is allowed to make its own call.

Deliberately in-process only: a per-workspace deque guarded by an asyncio.Lock,
not a Postgres-backed job table or background worker. This repo has repeatedly
deferred building real job-scheduler infrastructure (parsing, metering,
drift-check — see architecture.md); the fairness and backpressure this issue
needs don't require it. A second API replica has its own independent scheduler
state — acceptable at current scale, same caveat as Issue 12.2's proactive
connector pacing.

Round-robin, not global FIFO: a workspace that enqueues many requests in a row
must not delay a different workspace's single request indefinitely. Each
workspace gets its own FIFO sub-queue; the dispatcher always advances a
"next workspace to serve" cursor round-robin across workspaces that currently
have anything queued, so one workspace's burst is interleaved with others'
requests rather than blocking them until the whole burst drains.

Implementation note: this does NOT use asyncio.Semaphore. A bare semaphore
only tells you "a slot is free," not "whose turn is it" — pairing it with a
round-robin queue means every acquire/release has to coordinate two separate
primitives, which gets error-prone once you need an accurate queue-depth
count. The original sketch tried exactly that (semaphore + separate
event-queue) and its `queue_depth_at_submit` only counted items sitting in
the per-workspace deques, not callers that already held a semaphore slot —
so a waiter enqueued while the sole slot was in use could observe
`queue_depth_at_submit == 0` when it should have been >= 1, which is
reported to end users and must be accurate. Instead, `_slots_available` is
tracked directly as plain state protected by `_lock`, so slot occupancy and
queue contents are always visible in one place when computing depth.
`_dispatch()` — the single place that assigns free slots to queued callers —
is invoked both after enqueueing (so waves of callers self-dispatch
immediately) and after release (so callers waiting behind a freed slot get
woken).
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
    and how many requests were ahead of it (running or queued, across all
    workspaces) when it enqueued, so that can be surfaced to the end user
    instead of a silent hang."""

    queue_wait_seconds: float
    queue_depth_at_submit: int


class _Waiter:
    __slots__ = ("event",)

    def __init__(self) -> None:
        self.event = asyncio.Event()


class AIScheduler:
    def __init__(self, max_concurrent: int) -> None:
        if max_concurrent < 1:
            raise ValueError("max_concurrent must be >= 1")
        self._max_concurrent = max_concurrent
        self._slots_available = max_concurrent
        self._queues: dict[str, deque[_Waiter]] = {}
        self._workspace_order: deque[str] = deque()  # round-robin cursor
        self._lock = asyncio.Lock()  # protects all mutable state above

    def _queue_depth(self) -> int:
        return sum(len(q) for q in self._queues.values())

    def _dispatch_locked(self) -> None:
        """Assigns any currently-free slots to queued waiters, round-robin
        across workspaces. Must be called while holding `_lock`."""
        while self._slots_available > 0 and self._workspace_order:
            workspace_id = self._workspace_order[0]
            queue = self._queues.get(workspace_id)
            if not queue:
                self._workspace_order.popleft()
                continue
            waiter = queue.popleft()
            self._workspace_order.rotate(-1)  # this workspace goes to the back
            if not queue:
                del self._queues[workspace_id]
                # the rotate already moved it to the back; if it's still there
                # (no other workspace queued behind it), pop it so it doesn't
                # linger as an empty entry.
                if self._workspace_order and self._workspace_order[-1] == workspace_id:
                    self._workspace_order.pop()
            self._slots_available -= 1
            waiter.event.set()

    @asynccontextmanager
    async def acquire(self, workspace_id: str) -> AsyncIterator[Ticket]:
        start = time.monotonic()
        waiter = _Waiter()

        async with self._lock:
            # Requests ahead of this one -- everyone currently holding a slot
            # (running) plus everyone else already queued -- at the moment
            # this one submits, computed before this waiter is appended.
            # If this caller still gets dispatched a slot in this very pass
            # (no contention -- e.g. two peers submitting in the same tick
            # with capacity for both), it was never actually made to wait
            # behind anyone, so it reports 0 regardless of the raw count.
            requests_ahead = (self._max_concurrent - self._slots_available) + self._queue_depth()

            queue = self._queues.setdefault(workspace_id, deque())
            if not queue:
                self._workspace_order.append(workspace_id)
            queue.append(waiter)
            self._dispatch_locked()

            queue_depth_at_submit = 0 if waiter.event.is_set() else requests_ahead

        got_slot = False
        try:
            try:
                await waiter.event.wait()
                got_slot = True
            except asyncio.CancelledError:
                # Cancelled while still waiting for a turn (e.g. caller-side
                # timeout). If dispatch hasn't reached us yet, drop our
                # waiter from the queue so it doesn't linger forever and
                # skew queue-depth accounting for everyone behind it. If
                # dispatch *did* reach us concurrently with the cancellation,
                # we now hold a slot we'll never use -- give it back.
                async with self._lock:
                    if waiter.event.is_set():
                        self._slots_available += 1
                        self._dispatch_locked()
                    else:
                        pending = self._queues.get(workspace_id)
                        if pending is not None and waiter in pending:
                            pending.remove(waiter)
                            if not pending:
                                del self._queues[workspace_id]
                raise

            queue_wait_seconds = time.monotonic() - start
            yield Ticket(
                queue_wait_seconds=queue_wait_seconds,
                queue_depth_at_submit=queue_depth_at_submit,
            )
        finally:
            if got_slot:
                async with self._lock:
                    self._slots_available += 1
                    self._dispatch_locked()
