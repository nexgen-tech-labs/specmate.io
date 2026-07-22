"""Append-only audit event writes (Issue 8.1).

`record_audit_event` adds an AuditEvent row to the caller's session WITHOUT
committing — the caller's own commit persists the event in the same transaction
as the action it describes, so a failed audit write rolls the action back (and
vice versa). Never commit here, and never write audit events on a separate
session/connection: that would break the transactional-linkage acceptance
criterion.

Actor model:
- USER   — a human did it (review decisions, publishes); actor_user_id when known.
- SYSTEM — automated pipeline actions (parsing/ingest).
- AI     — model-generated content (generation runs, regenerations).

Rows are immutable at the database level (trigger rejects UPDATE/DELETE — see the
add_audit_immutability_and_snapshots Prisma migration); do not add update or
delete helpers to this module.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from app.models import AuditActorType, AuditEvent


def record_audit_event(
    session: AsyncSession,
    *,
    workspace_id: str,
    action: str,
    entity_type: str,
    entity_id: str,
    project_id: str | None = None,
    actor_user_id: str | None = None,
    actor_type: AuditActorType = AuditActorType.SYSTEM,
    before: dict[str, object] | None = None,
    after: dict[str, object] | None = None,
    metadata: dict[str, object] | None = None,
) -> AuditEvent:
    event = AuditEvent(
        workspaceId=workspace_id,
        projectId=project_id,
        actorUserId=actor_user_id,
        actorType=actor_type,
        action=action,
        entityType=entity_type,
        entityId=entity_id,
        beforeState=before,
        afterState=after,
        metadata_=metadata,
        createdAt=datetime.now(UTC).replace(tzinfo=None),
    )
    session.add(event)
    return event


def make_rate_limit_recorder(
    session: AsyncSession, workspace_id: str, tool: str
) -> Callable[[int, float, int], Awaitable[None]]:
    """Builds a transport `on_rate_limited` callback (Issue #89) that records a
    `connector.rate_limited` AuditEvent per retry-triggering response. The incident
    data (status code, computed wait, and the retry attempt number) is non-entity
    state — it describes a pause in an outbound call, not "the entity's state after
    the action" — so it goes in `metadata_`, not `afterState`. Task 7's dashboard
    queries `metadata_` for this action, per the design spec."""

    async def _record(status_code: int, wait_seconds: float, attempt: int) -> None:
        record_audit_event(
            session,
            workspace_id=workspace_id,
            action="connector.rate_limited",
            entity_type=tool,
            entity_id=tool,
            metadata={
                "status_code": status_code,
                "wait_seconds": wait_seconds,
                "retry_count": attempt,
            },
        )

    return _record
