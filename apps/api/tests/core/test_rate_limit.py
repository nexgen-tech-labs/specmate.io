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
            await session.flush()
            workspace_id = ws.id
            await session.commit()
            return workspace_id
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
