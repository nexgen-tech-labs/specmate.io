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


async def test_round_robin_generalizes_across_more_than_two_workspaces() -> None:
    """Same idea as the 2-workspace round-robin test, but with 4 workspaces
    each enqueueing 2 requests, to give confidence the rotate/pop cleanup
    logic in `_dispatch_locked` doesn't only happen to work for the
    2-workspace case (e.g. an off-by-one in the rotate direction or in the
    "pop if still at the back" cleanup could easily go unnoticed with only
    two entries).

    Enqueue order is pinned explicitly (each workspace's first request
    enqueues, in a small stagger, before any workspace's second request)
    so the expected round-robin dispatch order is deterministic rather than
    left to task-scheduling luck, as `asyncio.gather`-everything-at-once
    would."""
    scheduler = AIScheduler(max_concurrent=1)
    dispatch_order: list[str] = []

    async def hold_and_record(workspace_id: str, label: str, delay_before: float) -> None:
        await asyncio.sleep(delay_before)
        async with scheduler.acquire(workspace_id):
            dispatch_order.append(label)
            await asyncio.sleep(0.01)

    workspaces = ["ws-a", "ws-b", "ws-c", "ws-d"]
    tasks = []
    # First pass: a1, b1, c1, d1 enqueue in order, staggered.
    for i, ws in enumerate(workspaces):
        label = f"{ws[-1]}1"
        tasks.append(hold_and_record(ws, label, delay_before=i * 0.005))
    # Second pass: a2, b2, c2, d2 enqueue afterward (well after the first
    # pass has finished enqueueing), so they queue up behind the first pass.
    for i, ws in enumerate(workspaces):
        label = f"{ws[-1]}2"
        tasks.append(hold_and_record(ws, label, delay_before=0.05 + i * 0.005))

    await asyncio.gather(*tasks)

    # Every request must eventually run exactly once.
    assert sorted(dispatch_order) == sorted(
        ["a1", "a2", "b1", "b2", "c1", "c2", "d1", "d2"]
    )

    # Round-robin fairness: with only 1 slot and the first-pass requests all
    # queued before any second-pass request, the first 4 dispatched must be
    # exactly a1/b1/c1/d1 (one full round-robin pass across all workspaces)
    # before any workspace gets its second turn.
    assert dispatch_order[:4] == ["a1", "b1", "c1", "d1"], (
        f"expected one full round-robin pass (a1,b1,c1,d1) before any "
        f"workspace's second request, got order {dispatch_order}"
    )


async def test_cancelled_while_still_queued_leaves_no_phantom_waiter_or_leaked_slot() -> None:
    """A waiter enqueued behind another caller holding the only slot, then
    cancelled before dispatch ever reaches it. Covers the `except
    asyncio.CancelledError` branch's "dispatch hasn't reached us yet" path:
    the waiter must be pruned from the per-workspace deque so it doesn't
    linger as a phantom entry that blocks/skews accounting for whoever
    queues behind it, and no slot may be leaked (this waiter never held
    one, so `_slots_available` must be untouched by its cancellation)."""
    scheduler = AIScheduler(max_concurrent=1)

    holder_release = asyncio.Event()
    holder_started = asyncio.Event()

    async def holder() -> None:
        async with scheduler.acquire("ws-a"):
            holder_started.set()
            await holder_release.wait()

    async def queued_waiter() -> None:
        # Enqueues behind the holder; never gets a slot because the holder
        # doesn't release until after we cancel this task.
        async with scheduler.acquire("ws-a"):
            pytest.fail("cancelled waiter should never have acquired a slot")

    holder_task = asyncio.create_task(holder())
    await holder_started.wait()

    waiter_task = asyncio.create_task(queued_waiter())
    # Give the waiter task a tick to reach `await waiter.event.wait()` and
    # actually be enqueued in ws-a's deque before we cancel it.
    await asyncio.sleep(0.01)

    # Sanity check: the waiter is genuinely queued (not dispatched) before
    # we cancel it -- otherwise this test would trivially pass.
    assert scheduler._queue_depth() == 1  # noqa: SLF001 -- white-box test
    assert "ws-a" in scheduler._queues  # noqa: SLF001

    waiter_task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiter_task

    # (b) the cancelled waiter must be removed from the internal queue --
    # no phantom entry left behind.
    assert scheduler._queue_depth() == 0  # noqa: SLF001
    assert "ws-a" not in scheduler._queues  # noqa: SLF001

    # Let the holder release its slot so we can prove nothing was leaked.
    holder_release.set()
    await holder_task

    # (c) no slot was leaked: a following acquire() for the same workspace
    # must get a slot promptly rather than hang.
    async def follow_up() -> str:
        async with scheduler.acquire("ws-a"):
            return "acquired"

    result = await asyncio.wait_for(follow_up(), timeout=1.0)
    assert result == "acquired"

    # Behavioral confirmation of (b): a subsequent caller for ws-a is not
    # blocked behind a leaked/phantom waiter -- it acquires immediately with
    # nothing ahead of it (queue is empty, one slot available).
    async def behind_check() -> int:
        async with scheduler.acquire("ws-a") as ticket:
            return ticket.queue_depth_at_submit

    depth = await asyncio.wait_for(behind_check(), timeout=1.0)
    assert depth == 0


async def test_cancelled_racing_with_dispatch_releases_slot_instead_of_leaking_it() -> None:
    """Exercises the harder-to-hit branch: cancellation arrives at roughly
    the same moment dispatch grants the waiter its slot (the
    `if waiter.event.is_set(): self._slots_available += 1; ...` recovery
    path), rather than the "still queued" path covered above.

    This exact interleaving (cancellation delivered to the waiting task in
    the same window `_dispatch_locked` sets `waiter.event`) is inherently
    timing-sensitive -- asyncio doesn't give us a hook to pause *inside*
    `acquire()` between `waiter.event.set()` and the waiter task noticing
    it woke up. Instead of trying to land exactly in that instant, we
    approximate it deterministically using a documented asyncio guarantee:
    `Event.set()` only *schedules* the waiting task's wakeup as a callback
    (via `call_soon`) rather than resuming it inline, and `Task.cancel()`
    called before that scheduled wakeup actually runs will deliver
    `CancelledError` into the `await event.wait()` even though the event
    is already `is_set() == True` by then. So: release the holder's slot
    directly (bypassing the holder task/`async with` entirely, calling the
    scheduler's internals the same way `release` would) to flip
    `waiter.event` to set, then immediately cancel the waiter task with no
    `await` in between -- guaranteeing the waiter task hasn't yet resumed
    from `event.wait()` and hits the `except asyncio.CancelledError` branch
    with `waiter.event.is_set() == True`, i.e. exactly the "dispatch
    reached us concurrently with the cancellation" recovery path.

    Whichever side "wins" in a given run, the observable outcome we actually
    care about is the same: no leaked slot, no hang for subsequent callers.
    """
    scheduler = AIScheduler(max_concurrent=1)

    holder_started = asyncio.Event()
    holder_may_release = asyncio.Event()

    async def holder() -> None:
        async with scheduler.acquire("ws-a"):
            holder_started.set()
            await holder_may_release.wait()

    got_cancelled = False

    async def queued_waiter() -> None:
        async with scheduler.acquire("ws-a"):
            pytest.fail(
                "waiter body should never run: either it was cancelled "
                "while queued, or cancelled right as it got the slot"
            )

    holder_task = asyncio.create_task(holder())
    await holder_started.wait()

    waiter_task = asyncio.create_task(queued_waiter())
    await asyncio.sleep(0.01)  # ensure the waiter is enqueued

    holder_may_release.set()
    # Let the holder task actually observe the release and run its
    # `finally` block (which calls `_dispatch_locked` and sets
    # `waiter.event`), but stop as soon as that happens -- do NOT let the
    # waiter task get a turn afterward. asyncio.Event.set() (used by
    # `holder_may_release` and, downstream, by `waiter.event` itself) only
    # schedules callbacks; it doesn't run them inline. A single
    # `asyncio.sleep(0)` yields exactly one turn of the loop, which is
    # enough for the holder task to finish (short coroutine, no further
    # blocking waits) but leaves the waiter task's wakeup callback still
    # merely *scheduled*, not yet executed.
    await asyncio.sleep(0)
    assert holder_task.done(), "holder should have finished releasing its slot by now"
    waiter_task.cancel()

    try:
        await waiter_task
    except asyncio.CancelledError:
        got_cancelled = True

    assert got_cancelled, "CancelledError must propagate out of acquire(), not be swallowed"

    # No leaked slot either way: a following acquire() must succeed promptly.
    async def follow_up() -> str:
        async with scheduler.acquire("ws-a"):
            return "acquired"

    result = await asyncio.wait_for(follow_up(), timeout=1.0)
    assert result == "acquired"

    # And internal state must be consistent: at most max_concurrent slots
    # ever considered available, none double-counted.
    assert 0 <= scheduler._slots_available <= scheduler._max_concurrent  # noqa: SLF001
