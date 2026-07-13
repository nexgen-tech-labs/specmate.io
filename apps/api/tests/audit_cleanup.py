"""Shared test-cleanup helper for the append-only AuditEvent table (Issue 8.1).

AuditEvent rows are trigger-protected against UPDATE/DELETE; the `specmate.maintenance`
session GUC is the sanctioned escape hatch for test-database cleanup. SET LOCAL scopes
it to the current transaction, so it must run in the same transaction as the delete —
call this before the session's final commit.
"""

from __future__ import annotations

from sqlalchemy import delete, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import AuditEvent


async def purge_audit_events(session: AsyncSession, workspace_id: str) -> None:
    await session.execute(text("SET LOCAL specmate.maintenance = 'on'"))
    await session.execute(delete(AuditEvent).where(AuditEvent.workspaceId == workspace_id))
