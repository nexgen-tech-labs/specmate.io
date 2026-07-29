"""AIScheduler (Issue 12.3): caps concurrent AI calls process-wide and dispatches
queued requests fairly across workspaces via round-robin, not global FIFO."""

from __future__ import annotations

import asyncio

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
