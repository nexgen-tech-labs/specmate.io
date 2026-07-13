"""Project trace-map assembly (Issues 8.4/8.5).

`build_trace_map` produces the full point-in-time state of a project — every
active item with its review decisions, published external keys, and source
citations — as one plain-JSON dict. It is the payload stored on a Snapshot row
(Issue 8.4: the stored JSON is the immutable artifact; PDFs render from it, never
from live tables) and the superset the approval report (Issue 8.5) filters down.
"""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    DraftItem,
    Project,
    PublishedItem,
    RawRequirement,
    ReviewDecision,
    Source,
    TraceLink,
    User,
    Workspace,
)

SNAPSHOT_VERSION = 1


def _iso(dt: datetime) -> str:
    return dt.isoformat()


async def build_trace_map(session: AsyncSession, project: Project) -> dict[str, object]:
    workspace = await session.get(Workspace, project.workspaceId)
    assert workspace is not None

    sources = list(
        (
            await session.execute(
                select(Source).where(Source.projectId == project.id, Source.deletedAt.is_(None))
            )
        ).scalars()
    )
    items = list(
        (
            await session.execute(
                select(DraftItem).where(
                    DraftItem.projectId == project.id, DraftItem.deletedAt.is_(None)
                )
            )
        ).scalars()
    )
    item_ids = [i.id for i in items]

    decisions_rows = (
        await session.execute(
            select(ReviewDecision, User)
            .join(User, User.id == ReviewDecision.actorUserId)
            .where(ReviewDecision.draftItemId.in_(item_ids))
            .order_by(ReviewDecision.createdAt)
        )
    ).all()
    decisions_by_item: dict[str, list[dict[str, object]]] = {}
    for decision, actor in decisions_rows:
        decisions_by_item.setdefault(decision.draftItemId, []).append(
            {
                "decision": decision.decision.value,
                "actor_name": actor.name,
                "actor_email": actor.email,
                "notes": decision.notes,
                "at": _iso(decision.createdAt),
            }
        )

    published_rows = list(
        (
            await session.execute(
                select(PublishedItem).where(
                    PublishedItem.draftItemId.in_(item_ids), PublishedItem.deletedAt.is_(None)
                )
            )
        ).scalars()
    )
    published_by_item: dict[str, list[dict[str, object]]] = {}
    for pub in published_rows:
        published_by_item.setdefault(pub.draftItemId, []).append(
            {
                "tool": pub.targetTool.value,
                "key": pub.externalKey,
                "url": pub.externalUrl,
                "at": _iso(pub.createdAt),
            }
        )

    source_names = {s.id: s.name for s in sources}
    trace_rows = (
        await session.execute(
            select(TraceLink, RawRequirement)
            .join(RawRequirement, RawRequirement.id == TraceLink.rawRequirementId)
            .where(TraceLink.draftItemId.in_(item_ids))
        )
    ).all()
    citations_by_item: dict[str, list[dict[str, object]]] = {}
    for link, fragment in trace_rows:
        citations_by_item.setdefault(link.draftItemId, []).append(
            {
                "source_id": link.sourceId,
                "source_name": source_names.get(link.sourceId, link.sourceId),
                "section_path": fragment.sectionPath,
                "excerpt": fragment.text[:280],
            }
        )

    item_dicts: list[dict[str, object]] = [
        {
            "id": item.id,
            "type": item.type.value,
            "title": item.title,
            "description": item.description,
            "status": item.status.value,
            "parent_id": item.parentId,
            "quality_score": item.qualityScore,
            "signed_off": item.signedOffByUserId is not None,
            "decisions": decisions_by_item.get(item.id, []),
            "published": published_by_item.get(item.id, []),
            "citations": citations_by_item.get(item.id, []),
        }
        for item in items
    ]

    return {
        "snapshot_version": SNAPSHOT_VERSION,
        "generated_at": _iso(datetime.now(UTC).replace(tzinfo=None)),
        "workspace": {"id": workspace.id, "name": workspace.name},
        "project": {"id": project.id, "name": project.name},
        "sources": [
            {"id": s.id, "name": s.name, "kind": s.kind.value, "status": s.status.value}
            for s in sources
        ],
        "items": item_dicts,
        "counts": {
            "sources": len(sources),
            "items": len(item_dicts),
            "published": len(published_rows),
            "decisions": len(decisions_rows),
        },
    }


def approval_report_rows(
    trace_map: dict[str, object],
    date_from: datetime | None = None,
    date_to: datetime | None = None,
) -> list[dict[str, object]]:
    """Issue 8.5: approved items only — who approved what, when, from which source.
    Operates on a trace map so the same logic serves live reports and snapshots."""
    rows: list[dict[str, object]] = []
    items = trace_map.get("items")
    assert isinstance(items, list)
    for item in items:
        if item["status"] != "APPROVED":
            continue
        approvals = [d for d in item["decisions"] if d["decision"] == "APPROVED"]
        if not approvals:
            continue
        latest = approvals[-1]
        approved_at = datetime.fromisoformat(str(latest["at"]))
        if date_from and approved_at < date_from:
            continue
        if date_to and approved_at > date_to:
            continue
        citations = item["citations"]
        rows.append(
            {
                "title": item["title"],
                "type": item["type"],
                "approver": latest["actor_name"] or latest["actor_email"],
                "approved_at": latest["at"],
                "signed_off": item["signed_off"],
                "source_citation": (
                    f"{citations[0]['source_name']} ({citations[0]['section_path']})"
                    if citations
                    else "(no source citation recorded)"
                ),
                "published": [f"{p['tool']} {p['key']}" for p in item["published"]],
            }
        )
    rows.sort(key=lambda r: str(r["approved_at"]))
    return rows
