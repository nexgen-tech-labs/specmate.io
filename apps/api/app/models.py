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


class PricingTier(str, enum.Enum):
    STARTER = "STARTER"
    ENTERPRISE = "ENTERPRISE"


class SubscriptionStatus(str, enum.Enum):
    NONE = "NONE"
    TRIALING = "TRIALING"
    ACTIVE = "ACTIVE"
    PAST_DUE = "PAST_DUE"
    CANCELED = "CANCELED"
    INCOMPLETE = "INCOMPLETE"


class OrgRole(str, enum.Enum):
    OWNER = "OWNER"
    ADMIN = "ADMIN"


class OrgSize(str, enum.Enum):
    SOLO = "SOLO"
    SMALL = "SMALL"
    MEDIUM = "MEDIUM"
    LARGE = "LARGE"
    ENTERPRISE = "ENTERPRISE"


class Organization(Base):
    """Top of the tenancy hierarchy (Issue 12.10): Organization → Workspace →
    Team → User. apps/api only mirrors these for schema completeness — all
    authorization decisions happen in apps/web (the auth boundary); apps/api
    keeps internal-only ingress."""

    __tablename__ = "Organization"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_cuid)
    name: Mapped[str] = mapped_column(String)
    size: Mapped[OrgSize | None] = mapped_column(
        Enum(OrgSize, name="OrgSize", create_type=False), nullable=True
    )
    createdAt: Mapped[datetime] = mapped_column(DateTime)
    updatedAt: Mapped[datetime] = mapped_column(DateTime)
    deletedAt: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class OrganizationMember(Base):
    __tablename__ = "OrganizationMember"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_cuid)
    organizationId: Mapped[str] = mapped_column(ForeignKey("Organization.id"))
    userId: Mapped[str] = mapped_column(ForeignKey("User.id"))
    role: Mapped[OrgRole] = mapped_column(Enum(OrgRole, name="OrgRole", create_type=False))
    createdAt: Mapped[datetime] = mapped_column(DateTime)
    updatedAt: Mapped[datetime] = mapped_column(DateTime)


class Workspace(Base):
    __tablename__ = "Workspace"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_cuid)
    name: Mapped[str] = mapped_column(String)
    organizationId: Mapped[str | None] = mapped_column(
        ForeignKey("Organization.id"), nullable=True
    )
    duplicateThreshold: Mapped[float | None] = mapped_column(Float, nullable=True)
    approvalStages: Mapped[int] = mapped_column(Integer, default=1)
    firstGenerationAt: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    pricingTier: Mapped[PricingTier] = mapped_column(
        Enum(PricingTier, name="PricingTier", create_type=False), default=PricingTier.STARTER
    )
    subscriptionStatus: Mapped[SubscriptionStatus] = mapped_column(
        Enum(SubscriptionStatus, name="SubscriptionStatus", create_type=False),
        default=SubscriptionStatus.NONE,
    )
    stripeCustomerId: Mapped[str | None] = mapped_column(String, nullable=True)
    stripeSubscriptionId: Mapped[str | None] = mapped_column(String, nullable=True)
    subscriptionBaseUsd: Mapped[float | None] = mapped_column(Float, nullable=True)
    createdAt: Mapped[datetime] = mapped_column(DateTime)
    updatedAt: Mapped[datetime] = mapped_column(DateTime)
    deletedAt: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class User(Base):
    __tablename__ = "User"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_cuid)
    email: Mapped[str] = mapped_column(String, unique=True)
    name: Mapped[str] = mapped_column(String)
    passwordHash: Mapped[str] = mapped_column(String)
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


class Team(Base):
    """Permission-scoping group within a Workspace (Issues 12.10/12.11) — see
    schema.prisma's Team model comment for the restriction semantics."""

    __tablename__ = "Team"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_cuid)
    workspaceId: Mapped[str] = mapped_column(ForeignKey("Workspace.id"))
    name: Mapped[str] = mapped_column(String)
    createdAt: Mapped[datetime] = mapped_column(DateTime)
    updatedAt: Mapped[datetime] = mapped_column(DateTime)
    deletedAt: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class TeamMember(Base):
    __tablename__ = "TeamMember"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_cuid)
    teamId: Mapped[str] = mapped_column(ForeignKey("Team.id"))
    userId: Mapped[str] = mapped_column(ForeignKey("User.id"))
    createdAt: Mapped[datetime] = mapped_column(DateTime)


class TeamProject(Base):
    __tablename__ = "TeamProject"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_cuid)
    teamId: Mapped[str] = mapped_column(ForeignKey("Team.id"))
    projectId: Mapped[str] = mapped_column(ForeignKey("Project.id"))
    createdAt: Mapped[datetime] = mapped_column(DateTime)


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
    version: Mapped[int] = mapped_column(Integer, default=1)
    previousVersionId: Mapped[str | None] = mapped_column(
        ForeignKey("Source.id"), nullable=True
    )
    createdAt: Mapped[datetime] = mapped_column(DateTime)
    updatedAt: Mapped[datetime] = mapped_column(DateTime)
    deletedAt: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class SourceDiff(Base):
    __tablename__ = "SourceDiff"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_cuid)
    sourceId: Mapped[str] = mapped_column(ForeignKey("Source.id"))
    previousSourceId: Mapped[str] = mapped_column(String)
    addedCount: Mapped[int] = mapped_column(Integer)
    removedCount: Mapped[int] = mapped_column(Integer)
    modifiedCount: Mapped[int] = mapped_column(Integer)
    unchangedCount: Mapped[int] = mapped_column(Integer)
    fragments: Mapped[list[dict[str, object]]] = mapped_column(JSONB)
    createdAt: Mapped[datetime] = mapped_column(DateTime)


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
    sourceVersionId: Mapped[str | None] = mapped_column(String, nullable=True)
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
    lastKnownState: Mapped[dict[str, object] | None] = mapped_column(JSONB, nullable=True)
    lastSyncedAt: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    createdAt: Mapped[datetime] = mapped_column(DateTime)
    deletedAt: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class DriftResolution(str, enum.Enum):
    ACCEPT_EXTERNAL = "ACCEPT_EXTERNAL"
    REASSERT_SPECMATE = "REASSERT_SPECMATE"


class DriftFlag(Base):
    __tablename__ = "DriftFlag"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_cuid)
    publishedItemId: Mapped[str] = mapped_column(ForeignKey("PublishedItem.id"))
    diff: Mapped[dict[str, object]] = mapped_column(JSONB)
    detectedAt: Mapped[datetime] = mapped_column(DateTime)
    resolution: Mapped[DriftResolution | None] = mapped_column(
        Enum(DriftResolution, name="DriftResolution", create_type=False), nullable=True
    )
    resolvedAt: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    resolvedByUserId: Mapped[str | None] = mapped_column(String, nullable=True)


class AuditActorType(str, enum.Enum):
    USER = "USER"
    SYSTEM = "SYSTEM"
    AI = "AI"


class AuditEvent(Base):
    """Append-only (Issue 8.1) — a Postgres trigger rejects UPDATE/DELETE; write
    rows into the same session/transaction as the action they describe so a failed
    audit write rolls the action back."""

    __tablename__ = "AuditEvent"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_cuid)
    workspaceId: Mapped[str] = mapped_column(ForeignKey("Workspace.id"))
    projectId: Mapped[str | None] = mapped_column(String, nullable=True)
    actorUserId: Mapped[str | None] = mapped_column(ForeignKey("User.id"), nullable=True)
    actorType: Mapped[AuditActorType] = mapped_column(
        Enum(AuditActorType, name="AuditActorType", create_type=False),
        default=AuditActorType.USER,
    )
    action: Mapped[str] = mapped_column(String)
    entityType: Mapped[str] = mapped_column(String)
    entityId: Mapped[str] = mapped_column(String)
    beforeState: Mapped[dict[str, object] | None] = mapped_column(JSONB, nullable=True)
    afterState: Mapped[dict[str, object] | None] = mapped_column(JSONB, nullable=True)
    metadata_: Mapped[dict[str, object] | None] = mapped_column("metadata", JSONB, nullable=True)
    createdAt: Mapped[datetime] = mapped_column(DateTime)


class Snapshot(Base):
    """Point-in-time project trace-map export (Issue 8.4). Immutable once created —
    `data` is the artifact; PDF rendering reads from it, never live tables."""

    __tablename__ = "Snapshot"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_cuid)
    workspaceId: Mapped[str] = mapped_column(ForeignKey("Workspace.id"))
    projectId: Mapped[str] = mapped_column(ForeignKey("Project.id"))
    createdByUserId: Mapped[str | None] = mapped_column(String, nullable=True)
    kind: Mapped[str] = mapped_column(String, default="TRACE_MAP")
    data: Mapped[dict[str, object]] = mapped_column(JSONB)
    createdAt: Mapped[datetime] = mapped_column(DateTime)


class UsagePeriod(Base):
    """One row per workspace per billing period (Issue 10.9) — the metered
    component of the hybrid pricing model. publishedItemCount is computed by
    metering.py; reportedCount is how much of that has been pushed to Stripe so
    far (Stripe meter events are additive, so only the delta is ever reported);
    reportedToStripeAt is the last time a report succeeded."""

    __tablename__ = "UsagePeriod"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_cuid)
    workspaceId: Mapped[str] = mapped_column(ForeignKey("Workspace.id"))
    periodStart: Mapped[datetime] = mapped_column(DateTime)
    periodEnd: Mapped[datetime] = mapped_column(DateTime)
    publishedItemCount: Mapped[int] = mapped_column(Integer, default=0)
    reportedCount: Mapped[int] = mapped_column(Integer, default=0)
    reportedToStripeAt: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    createdAt: Mapped[datetime] = mapped_column(DateTime)
    updatedAt: Mapped[datetime] = mapped_column(DateTime)


class AtlassianConnectInstall(Base):
    """One row per Jira Cloud site with the SpecMate Connect app installed
    (Issue 10.2) — read-only from apps/api's side; apps/web's lifecycle
    webhooks (installed/uninstalled) and the workspace-claim endpoint own
    writes. Used here only to resolve a ConnectJwtConnection for a claimed
    workspace (see jira_auth.get_connect_connection_for_workspace)."""

    __tablename__ = "AtlassianConnectInstall"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_cuid)
    clientKey: Mapped[str] = mapped_column(String, unique=True)
    sharedSecret: Mapped[str] = mapped_column(String)
    baseUrl: Mapped[str] = mapped_column(String)
    displayUrl: Mapped[str | None] = mapped_column(String, nullable=True)
    productType: Mapped[str | None] = mapped_column(String, nullable=True)
    installedAt: Mapped[datetime] = mapped_column(DateTime)
    uninstalledAt: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    workspaceId: Mapped[str | None] = mapped_column(ForeignKey("Workspace.id"), nullable=True)
    claimedAt: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    createdAt: Mapped[datetime] = mapped_column(DateTime)
    updatedAt: Mapped[datetime] = mapped_column(DateTime)


class TraceLink(Base):
    __tablename__ = "TraceLink"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_cuid)
    sourceId: Mapped[str] = mapped_column(ForeignKey("Source.id"))
    rawRequirementId: Mapped[str] = mapped_column(ForeignKey("RawRequirement.id"))
    draftItemId: Mapped[str] = mapped_column(ForeignKey("DraftItem.id"))
    publishedItemId: Mapped[str | None] = mapped_column(ForeignKey("PublishedItem.id"), nullable=True)
    createdAt: Mapped[datetime] = mapped_column(DateTime)
    updatedAt: Mapped[datetime] = mapped_column(DateTime)


class TicketFormatMode(str, enum.Enum):
    HUMAN = "HUMAN"
    CODING_AGENT = "CODING_AGENT"
    BOTH = "BOTH"


class PublishMapping(Base):
    """Per-project publish configuration for a target tool (Epics 5-7) — type map,
    fixed defaults for required remote fields, a cached discovery snapshot, and the
    ticket format mode (Human/Coding Agent/Both)."""

    __tablename__ = "PublishMapping"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_cuid)
    projectId: Mapped[str] = mapped_column(ForeignKey("Project.id"))
    tool: Mapped[PublishTarget] = mapped_column(
        Enum(PublishTarget, name="PublishTarget", create_type=False)
    )
    remoteProject: Mapped[str] = mapped_column(String)
    typeMap: Mapped[dict[str, object]] = mapped_column(JSONB)
    fieldDefaults: Mapped[dict[str, object] | None] = mapped_column(JSONB, nullable=True)
    metadata_: Mapped[dict[str, object] | None] = mapped_column("metadata", JSONB, nullable=True)
    formatMode: Mapped[TicketFormatMode] = mapped_column(
        Enum(TicketFormatMode, name="TicketFormatMode", create_type=False),
        default=TicketFormatMode.HUMAN,
    )
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
