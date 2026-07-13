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
