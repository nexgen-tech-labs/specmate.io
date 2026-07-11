"""SQLAlchemy models mirroring apps/web/prisma/schema.prisma.

Prisma owns migrations for this schema. If you change schema.prisma, update this
file to match by hand — there is no cross-language schema sync tool in this stack.
Table and column names must match Prisma's defaults (PascalCase table names via
__tablename__, camelCase columns) since both ORMs read/write the same tables.
"""

from __future__ import annotations

import enum
import uuid
from datetime import UTC, datetime
from decimal import Decimal

from sqlalchemy import DateTime, Enum, Float, ForeignKey, Integer, Numeric, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def _cuid() -> str:
    return uuid.uuid4().hex


class Base(DeclarativeBase):
    pass


class Role(str, enum.Enum):
    ADMIN = "ADMIN"
    REVIEWER = "REVIEWER"
    VIEWER = "VIEWER"


class SourceKind(str, enum.Enum):
    DOCX = "DOCX"
    PDF = "PDF"
    XLSX = "XLSX"
    CSV = "CSV"
    TXT = "TXT"
    TRANSCRIPT = "TRANSCRIPT"
    CONFLUENCE = "CONFLUENCE"
    SLACK = "SLACK"
    JIRA_REF = "JIRA_REF"
    ADO_REF = "ADO_REF"
    GITHUB_REF = "GITHUB_REF"


class SourceStatus(str, enum.Enum):
    QUEUED = "QUEUED"
    PARSING = "PARSING"
    PARSED = "PARSED"
    FAILED = "FAILED"


class ScanStatus(str, enum.Enum):
    PENDING = "PENDING"
    CLEAN = "CLEAN"
    INFECTED = "INFECTED"


class DraftItemStatus(str, enum.Enum):
    PENDING = "PENDING"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"
    EDITED = "EDITED"


class DraftItemType(str, enum.Enum):
    EPIC = "EPIC"
    STORY = "STORY"
    TASK = "TASK"
    SUBTASK = "SUBTASK"
    ACCEPTANCE_CRITERIA = "ACCEPTANCE_CRITERIA"
    TEST = "TEST"
    RISK = "RISK"
    NFR = "NFR"
    DEPENDENCY = "DEPENDENCY"
    ASSUMPTION = "ASSUMPTION"
    QUESTION = "QUESTION"


class ReviewDecisionType(str, enum.Enum):
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"
    EDITED = "EDITED"


class PublishTarget(str, enum.Enum):
    JIRA = "JIRA"
    ADO = "ADO"
    GITHUB = "GITHUB"


class Workspace(Base):
    __tablename__ = "Workspace"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_cuid)
    name: Mapped[str] = mapped_column(String)
    duplicateThreshold: Mapped[float | None] = mapped_column(Float, nullable=True)
    approvalStages: Mapped[int] = mapped_column(Integer, default=1)
    createdAt: Mapped[datetime] = mapped_column(DateTime)
    updatedAt: Mapped[datetime] = mapped_column(DateTime)
    deletedAt: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class User(Base):
    __tablename__ = "User"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_cuid)
    email: Mapped[str] = mapped_column(String, unique=True)
    name: Mapped[str] = mapped_column(String)
    createdAt: Mapped[datetime] = mapped_column(DateTime)
    updatedAt: Mapped[datetime] = mapped_column(DateTime)


class WorkspaceMember(Base):
    __tablename__ = "WorkspaceMember"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_cuid)
    workspaceId: Mapped[str] = mapped_column(ForeignKey("Workspace.id"))
    userId: Mapped[str] = mapped_column(ForeignKey("User.id"))
    role: Mapped[Role] = mapped_column(Enum(Role, name="Role", create_type=False))
    createdAt: Mapped[datetime] = mapped_column(DateTime)
    updatedAt: Mapped[datetime] = mapped_column(DateTime)


class Project(Base):
    __tablename__ = "Project"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_cuid)
    workspaceId: Mapped[str] = mapped_column(ForeignKey("Workspace.id"))
    name: Mapped[str] = mapped_column(String)
    createdAt: Mapped[datetime] = mapped_column(DateTime)
    updatedAt: Mapped[datetime] = mapped_column(DateTime)
    deletedAt: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class Source(Base):
    __tablename__ = "Source"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_cuid)
    projectId: Mapped[str] = mapped_column(ForeignKey("Project.id"))
    name: Mapped[str] = mapped_column(String)
    kind: Mapped[SourceKind] = mapped_column(Enum(SourceKind, name="SourceKind", create_type=False))
    status: Mapped[SourceStatus] = mapped_column(
        Enum(SourceStatus, name="SourceStatus", create_type=False), default=SourceStatus.QUEUED
    )
    storageKey: Mapped[str | None] = mapped_column(String, nullable=True)
    sizeBytes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    mimeType: Mapped[str | None] = mapped_column(String, nullable=True)
    externalRef: Mapped[str | None] = mapped_column(String, nullable=True)
    parseError: Mapped[str | None] = mapped_column(String, nullable=True)
    scanStatus: Mapped[ScanStatus] = mapped_column(
        Enum(ScanStatus, name="ScanStatus", create_type=False), default=ScanStatus.PENDING
    )
    createdAt: Mapped[datetime] = mapped_column(DateTime)
    updatedAt: Mapped[datetime] = mapped_column(DateTime)
    deletedAt: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class RawRequirement(Base):
    __tablename__ = "RawRequirement"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_cuid)
    sourceId: Mapped[str] = mapped_column(ForeignKey("Source.id"))
    text: Mapped[str] = mapped_column(Text)
    sectionPath: Mapped[str] = mapped_column(String)
    order: Mapped[int] = mapped_column(Integer)
    createdAt: Mapped[datetime] = mapped_column(DateTime)
    updatedAt: Mapped[datetime] = mapped_column(DateTime)
    deletedAt: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class DraftItem(Base):
    __tablename__ = "DraftItem"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_cuid)
    projectId: Mapped[str] = mapped_column(ForeignKey("Project.id"))
    type: Mapped[DraftItemType] = mapped_column(
        Enum(DraftItemType, name="DraftItemType", create_type=False)
    )
    title: Mapped[str] = mapped_column(String)
    description: Mapped[str] = mapped_column(Text)
    payload: Mapped[dict[str, object] | None] = mapped_column(JSONB, nullable=True)
    qualityScore: Mapped[int | None] = mapped_column(Integer, nullable=True)
    parentId: Mapped[str | None] = mapped_column(ForeignKey("DraftItem.id"), nullable=True)
    status: Mapped[DraftItemStatus] = mapped_column(
        Enum(DraftItemStatus, name="DraftItemStatus", create_type=False),
        default=DraftItemStatus.PENDING,
    )
    signedOffByUserId: Mapped[str | None] = mapped_column(String, nullable=True)
    promptVersion: Mapped[str | None] = mapped_column(String, nullable=True)
    generationRunId: Mapped[str | None] = mapped_column(String, nullable=True)
    scoreDetail: Mapped[dict[str, object] | None] = mapped_column(JSONB, nullable=True)
    flags: Mapped[dict[str, object] | None] = mapped_column(JSONB, nullable=True)
    originalDraft: Mapped[dict[str, object] | None] = mapped_column(JSONB, nullable=True)
    editHistory: Mapped[list[object] | None] = mapped_column(JSONB, nullable=True)
    revisionOfId: Mapped[str | None] = mapped_column(String, nullable=True)
    createdAt: Mapped[datetime] = mapped_column(DateTime)
    updatedAt: Mapped[datetime] = mapped_column(DateTime)
    deletedAt: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    children: Mapped[list["DraftItem"]] = relationship(back_populates="parent")
    parent: Mapped["DraftItem | None"] = relationship(back_populates="children", remote_side=[id])


class ReviewDecision(Base):
    __tablename__ = "ReviewDecision"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_cuid)
    draftItemId: Mapped[str] = mapped_column(ForeignKey("DraftItem.id"))
    decision: Mapped[ReviewDecisionType] = mapped_column(
        Enum(ReviewDecisionType, name="ReviewDecisionType", create_type=False)
    )
    actorUserId: Mapped[str] = mapped_column(ForeignKey("User.id"))
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    createdAt: Mapped[datetime] = mapped_column(DateTime)


class PublishedItem(Base):
    __tablename__ = "PublishedItem"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_cuid)
    draftItemId: Mapped[str] = mapped_column(ForeignKey("DraftItem.id"))
    targetTool: Mapped[PublishTarget] = mapped_column(
        Enum(PublishTarget, name="PublishTarget", create_type=False)
    )
    externalKey: Mapped[str] = mapped_column(String)
    externalUrl: Mapped[str] = mapped_column(String)
    createdAt: Mapped[datetime] = mapped_column(DateTime)
    deletedAt: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class AuditEvent(Base):
    __tablename__ = "AuditEvent"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_cuid)
    workspaceId: Mapped[str] = mapped_column(ForeignKey("Workspace.id"))
    actorUserId: Mapped[str | None] = mapped_column(ForeignKey("User.id"), nullable=True)
    action: Mapped[str] = mapped_column(String)
    entityType: Mapped[str] = mapped_column(String)
    entityId: Mapped[str] = mapped_column(String)
    metadata_: Mapped[dict[str, object] | None] = mapped_column("metadata", JSONB, nullable=True)
    createdAt: Mapped[datetime] = mapped_column(DateTime)


class TraceLink(Base):
    __tablename__ = "TraceLink"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_cuid)
    sourceId: Mapped[str] = mapped_column(ForeignKey("Source.id"))
    rawRequirementId: Mapped[str] = mapped_column(ForeignKey("RawRequirement.id"))
    draftItemId: Mapped[str] = mapped_column(ForeignKey("DraftItem.id"))
    publishedItemId: Mapped[str | None] = mapped_column(ForeignKey("PublishedItem.id"), nullable=True)
    createdAt: Mapped[datetime] = mapped_column(DateTime)
    updatedAt: Mapped[datetime] = mapped_column(DateTime)


class GenerationRun(Base):
    """One AI generation run over a project's RawRequirements (Issue 3.1) — contentHash
    provides idempotency, stats power the generation summary (Issue 3.10)."""

    __tablename__ = "GenerationRun"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_cuid)
    projectId: Mapped[str] = mapped_column(ForeignKey("Project.id"))
    contentHash: Mapped[str] = mapped_column(String)
    promptVersion: Mapped[str] = mapped_column(String)
    stats: Mapped[dict[str, object] | None] = mapped_column(JSONB, nullable=True)
    createdAt: Mapped[datetime] = mapped_column(
        DateTime, default=lambda: datetime.now(UTC).replace(tzinfo=None)
    )


class ReferenceItem(Base):
    """Read-only snapshot of an existing Jira/ADO/GitHub backlog item (Issues #14-16),
    pulled for duplicate-detection reference (Issue 3.5) — never edited or published.
    Re-sync upserts by (projectId, tool, externalKey)."""

    __tablename__ = "ReferenceItem"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_cuid)
    projectId: Mapped[str] = mapped_column(ForeignKey("Project.id"))
    tool: Mapped[PublishTarget] = mapped_column(
        Enum(PublishTarget, name="PublishTarget", create_type=False)
    )
    externalKey: Mapped[str] = mapped_column(String)
    title: Mapped[str] = mapped_column(String)
    description: Mapped[str] = mapped_column(Text)
    itemType: Mapped[str] = mapped_column(String)
    state: Mapped[str] = mapped_column(String)
    url: Mapped[str | None] = mapped_column(String, nullable=True)
    syncedAt: Mapped[datetime] = mapped_column(DateTime)
    createdAt: Mapped[datetime] = mapped_column(DateTime)
    updatedAt: Mapped[datetime] = mapped_column(DateTime)


class AiCallLog(Base):
    """Immutable log of every AI adapter call — no deletedAt/updatedAt, same
    convention as ReviewDecision/AuditEvent. Populated by app.services.ai;
    aggregated by the (future) Issue #1.6 cost-tracking dashboard."""

    __tablename__ = "AiCallLog"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_cuid)
    workspaceId: Mapped[str] = mapped_column(ForeignKey("Workspace.id"))
    projectId: Mapped[str] = mapped_column(ForeignKey("Project.id"))
    task: Mapped[str] = mapped_column(String)
    model: Mapped[str] = mapped_column(String)
    promptVersion: Mapped[str | None] = mapped_column(String, nullable=True)
    inputTokens: Mapped[int] = mapped_column(Integer)
    outputTokens: Mapped[int] = mapped_column(Integer)
    cacheReadTokens: Mapped[int] = mapped_column(Integer)
    cacheCreationTokens: Mapped[int] = mapped_column(Integer)
    costUsd: Mapped[Decimal] = mapped_column(Numeric(12, 6))
    latencyMs: Mapped[int] = mapped_column(Integer)
    createdAt: Mapped[datetime] = mapped_column(
        DateTime, default=lambda: datetime.now(UTC).replace(tzinfo=None)
    )
