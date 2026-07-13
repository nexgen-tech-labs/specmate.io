"""Epic 3 pipeline tests — real Postgres, fake AIAdapter injected via dependency
override (canned per-pass outputs keyed on the request schema). Sync tests +
asyncio.run for the event-loop reasons documented in test_sources.py."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from decimal import Decimal

from fastapi.testclient import TestClient
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.core import db as db_module
from app.core.config import settings
from app.main import app
from app.models import (
    DraftItem,
    GenerationRun,
    Project,
    RawRequirement,
    ReferenceItem,
    Source,
    TraceLink,
    Workspace,
)
from app.routers.generation import get_generation_adapter
from app.services.ai.adapter import GenerationRequest, GenerationResult, UsageInfo
from tests.audit_cleanup import purge_audit_events


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _dispose_app_engine() -> None:
    asyncio.run(db_module.engine.dispose())


class FakeAdapter:
    """Returns canned structured outputs per pass, citing the real fragment ids."""

    def __init__(self, chunk_ids: list[str]) -> None:
        self.chunks = chunk_ids

    async def generate(self, request: GenerationRequest) -> GenerationResult:
        c = self.chunks
        # Pydantic copies dict fields on validation, so identity checks against the
        # schema constants fail — dispatch on the schema's top-level property instead.
        props = set(request.schema_.get("properties", {}))  # type: ignore[union-attr]
        if props == {"clusters"}:
            data: dict[str, object] = {"clusters": [{"theme": "Payments", "chunk_ids": c}]}
        elif props == {"epics"}:
            data = {
                "epics": [
                    {
                        "title": "Payments capability",
                        "description": "Customers pay invoices online.",
                        "business_value": "Reduces manual invoicing cost.",
                        "source_chunk_ids": [c[0], c[1]],
                    }
                ]
            }
        elif props == {"stories"}:
            data = {
                "stories": [
                    {
                        "title": "As a customer, I can pay an invoice with a saved card",
                        "description": "Saved card payment flow.",
                        "epic_index": 0,
                        "source_chunk_ids": [c[0]],
                        "tasks": [
                            {"title": "Build card vault integration", "description": "Tokenize cards."}
                        ],
                    },
                    {
                        "title": "As a finance user, I can export invoices to the ERP",
                        "description": "ERP export flow.",
                        "epic_index": -1,
                        "source_chunk_ids": [c[2]],
                        "tasks": [],
                    },
                ]
            }
        elif props == {"items"}:
            data = {
                "items": [
                    {
                        "type": "ACCEPTANCE_CRITERIA",
                        "story_index": 0,
                        "title": "Saved card payment succeeds",
                        "description": "Given a saved card, when the customer pays, the invoice is settled.",
                        "extra": {"statement": "Given/When/Then as described"},
                        "source_chunk_ids": [c[0]],
                    },
                    {
                        "type": "RISK",
                        "story_index": 0,
                        "title": "PCI-DSS scope expansion",
                        "description": "Storing card tokens brings PCI-DSS obligations.",
                        "extra": {"severity": "high"},
                        "source_chunk_ids": [c[1]],
                    },
                    {
                        "type": "ASSUMPTION",
                        "story_index": -1,
                        "title": "Single currency",
                        "description": "All invoices are in GBP.",
                        "extra": {"confidence": "low"},
                        "source_chunk_ids": [],
                    },
                ]
            }
        elif props == {"scores"}:
            data = {
                "scores": [
                    {"item_index": 0, "completeness": 90, "clarity": 88, "testability": 85,
                     "specificity": 90, "rationale": "Well specified.", "gap_question": None},
                    {"item_index": 1, "completeness": 85, "clarity": 90, "testability": 88,
                     "specificity": 82, "rationale": "Clear story.", "gap_question": None},
                    {"item_index": 2, "completeness": 40, "clarity": 70, "testability": 50,
                     "specificity": 35, "rationale": "Source doesn't say which ERP version.",
                     "gap_question": "Which ERP version (v2 or v3) does the invoice export target?"},
                ]
            }
        elif "title" in props:
            data = {
                "title": "As a finance user, I can export invoices to ERP v3",
                "description": "ERP v3 export via the REST API.",
                "extra": {},
            }
        else:
            raise AssertionError("unexpected schema")
        return GenerationResult(
            data=data,
            raw_text="{}",
            usage=UsageInfo(10, 10, 0, 0),
            cost_usd=Decimal("0.001"),
            latency_ms=5,
            model="fake-model",
            prompt_version="generation_v1",
        )


async def _create_fixture() -> dict[str, object]:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            ws = Workspace(name="Gen Test WS", createdAt=_now(), updatedAt=_now())
            session.add(ws)
            await session.flush()
            project = Project(workspaceId=ws.id, name="Gen Test Project", createdAt=_now(), updatedAt=_now())
            session.add(project)
            await session.flush()
            source = Source(
                projectId=project.id, name="reqs.docx", kind="DOCX",
                storageKey="k", createdAt=_now(), updatedAt=_now(),
            )
            session.add(source)
            await session.flush()

            texts = [
                ("Customers pay invoices with a saved card.", "p.1"),
                ("Card data storage must respect PCI-DSS scope.", "p.2"),
                ("Finance exports invoices to the ERP.", "p.3"),
            ]
            chunk_ids: list[str] = []
            for order, (text, path) in enumerate(texts):
                fragment = RawRequirement(
                    sourceId=source.id, text=text, sectionPath=path, order=order,
                    createdAt=_now(), updatedAt=_now(),
                )
                session.add(fragment)
                await session.flush()
                chunk_ids.append(fragment.id)

            # Near-duplicate of the saved-card story to trigger Issue 3.5 flagging.
            session.add(
                ReferenceItem(
                    projectId=project.id, tool="JIRA", externalKey="PAY-118",
                    title="Customer can pay an invoice with a saved card",
                    description="Saved card payment flow for invoices.",
                    itemType="Story", state="Open", syncedAt=_now(),
                    createdAt=_now(), updatedAt=_now(),
                )
            )
            ids = {
                "workspace_id": ws.id, "project_id": project.id,
                "source_id": source.id, "chunk_ids": chunk_ids,
            }
            await session.commit()
            return ids
    finally:
        await engine.dispose()


async def _cleanup(ids: dict[str, object]) -> None:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            project_id = str(ids["project_id"])
            item_ids = [
                i.id for i in (
                    await session.execute(select(DraftItem).where(DraftItem.projectId == project_id))
                ).scalars()
            ]
            if item_ids:
                await session.execute(delete(TraceLink).where(TraceLink.draftItemId.in_(item_ids)))
                await session.execute(delete(DraftItem).where(DraftItem.id.in_(item_ids)))
            await session.execute(delete(GenerationRun).where(GenerationRun.projectId == project_id))
            await session.execute(delete(ReferenceItem).where(ReferenceItem.projectId == project_id))
            await session.execute(
                delete(RawRequirement).where(RawRequirement.sourceId == str(ids["source_id"]))
            )
            await session.execute(delete(Source).where(Source.id == str(ids["source_id"])))
            await session.execute(delete(Project).where(Project.id == project_id))
            await purge_audit_events(session, str(ids["workspace_id"]))
            await session.execute(delete(Workspace).where(Workspace.id == str(ids["workspace_id"])))
            await session.commit()
    finally:
        await engine.dispose()


async def _fetch_items(project_id: str) -> list[DraftItem]:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            return list(
                (
                    await session.execute(
                        select(DraftItem).where(
                            DraftItem.projectId == project_id, DraftItem.deletedAt.is_(None)
                        )
                    )
                ).scalars()
            )
    finally:
        await engine.dispose()


async def _count_traces(item_id: str) -> int:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            rows = (
                await session.execute(select(TraceLink).where(TraceLink.draftItemId == item_id))
            ).all()
            return len(rows)
    finally:
        await engine.dispose()


def _client_with_fake(chunk_ids: list[str]) -> TestClient:
    app.dependency_overrides[get_generation_adapter] = lambda: FakeAdapter(chunk_ids)
    return TestClient(app)


def _clear_override() -> None:
    app.dependency_overrides.pop(get_generation_adapter, None)
    _dispose_app_engine()


def test_full_generation_run_produces_hierarchy_traces_scores_and_flags() -> None:
    ids = asyncio.run(_create_fixture())
    chunk_ids = list(map(str, ids["chunk_ids"]))  # type: ignore[arg-type]
    project_id = str(ids["project_id"])

    client = _client_with_fake(chunk_ids)
    try:
        response = client.post(f"/projects/{project_id}/generate", json={})
    finally:
        _clear_override()

    assert response.status_code == 200
    body = response.json()
    assert body["reused_existing_run"] is False
    stats = body["stats"]
    assert stats["items_by_type"]["EPIC"] == 1
    assert stats["items_by_type"]["STORY"] == 2
    assert stats["items_by_type"]["TASK"] == 1
    assert stats["gaps_flagged"] >= 1
    assert stats["duplicates_flagged"] >= 1
    assert stats["untraced_items"] == 1  # the uncited assumption
    assert stats["source_coverage"] == 1.0  # all three fragments cited somewhere

    items = asyncio.run(_fetch_items(project_id))
    by_title = {i.title: i for i in items}

    epic = by_title["Payments capability"]
    story_card = by_title["As a customer, I can pay an invoice with a saved card"]
    story_erp = by_title["As a finance user, I can export invoices to the ERP"]
    task = by_title["Build card vault integration"]
    assumption = by_title["Single currency"]

    # Hierarchy (Issue 3.7): story under epic; orphan story unparented, not forced.
    assert story_card.parentId == epic.id
    assert story_erp.parentId is None
    assert task.parentId == story_card.id

    # Traceability (Issue 3.3): cited items have TraceLinks; uncited flagged.
    assert asyncio.run(_count_traces(story_card.id)) == 1
    assert assumption.flags is not None and assumption.flags.get("noTrace") is True

    # Scoring + gap (Issues 3.4/3.6): specific answerable question, not generic.
    assert epic.qualityScore is not None and epic.scoreDetail is not None
    erp_flags = story_erp.flags or {}
    assert "ERP version" in erp_flags["gap"]["question"]  # type: ignore[index]

    # Duplicate flag (Issue 3.5) against the PAY-118 reference item.
    dup_flags = story_card.flags or {}
    assert dup_flags["duplicate"]["key"] == "PAY-118"  # type: ignore[index]

    # Original AI draft snapshot (Issue 4.3 baseline) + prompt version (3.1).
    assert epic.originalDraft is not None and epic.promptVersion == "generation_v1"

    asyncio.run(_cleanup(ids))


def test_regenerating_unchanged_content_reuses_run_without_duplicating_items() -> None:
    ids = asyncio.run(_create_fixture())
    chunk_ids = list(map(str, ids["chunk_ids"]))  # type: ignore[arg-type]
    project_id = str(ids["project_id"])

    client = _client_with_fake(chunk_ids)
    try:
        first = client.post(f"/projects/{project_id}/generate", json={})
        _dispose_app_engine()
        second = client.post(f"/projects/{project_id}/generate", json={})
    finally:
        _clear_override()

    assert first.json()["reused_existing_run"] is False
    assert second.json()["reused_existing_run"] is True
    assert second.json()["run_id"] == first.json()["run_id"]
    assert len(asyncio.run(_fetch_items(project_id))) == 7  # unchanged

    asyncio.run(_cleanup(ids))


def test_regenerate_item_creates_revision_and_preserves_original() -> None:
    ids = asyncio.run(_create_fixture())
    chunk_ids = list(map(str, ids["chunk_ids"]))  # type: ignore[arg-type]
    project_id = str(ids["project_id"])

    client = _client_with_fake(chunk_ids)
    try:
        client.post(f"/projects/{project_id}/generate", json={})
        _dispose_app_engine()

        items = asyncio.run(_fetch_items(project_id))
        erp_story = next(i for i in items if "ERP" in i.title)

        response = client.post(
            f"/draft-items/{erp_story.id}/regenerate",
            json={"context": "The export targets ERP v3 via REST.", "workspace_id": str(ids["workspace_id"])},
        )
    finally:
        _clear_override()

    assert response.status_code == 200
    new_id = response.json()["new_item_id"]

    async def fetch(item_id: str) -> DraftItem | None:
        engine = create_async_engine(settings.database_url)
        try:
            async with AsyncSession(engine) as session:
                return await session.get(DraftItem, item_id)
        finally:
            await engine.dispose()

    new_item = asyncio.run(fetch(new_id))
    old_item = asyncio.run(fetch(erp_story.id))
    assert new_item is not None and old_item is not None
    assert new_item.revisionOfId == erp_story.id
    assert "v3" in new_item.title
    assert old_item.deletedAt is not None  # preserved, out of the active queue
    assert asyncio.run(_count_traces(new_id)) == asyncio.run(_count_traces(erp_story.id))

    asyncio.run(_cleanup(ids))


def test_generation_summary_reports_live_counts() -> None:
    ids = asyncio.run(_create_fixture())
    chunk_ids = list(map(str, ids["chunk_ids"]))  # type: ignore[arg-type]
    project_id = str(ids["project_id"])

    client = _client_with_fake(chunk_ids)
    try:
        client.post(f"/projects/{project_id}/generate", json={})
        _dispose_app_engine()
        summary = client.get(f"/projects/{project_id}/generation-summary")
    finally:
        _clear_override()

    assert summary.status_code == 200
    live = summary.json()["live"]
    assert live["item_count"] == 7
    assert live["gaps_flagged"] == 1
    assert live["average_score"] is not None

    asyncio.run(_cleanup(ids))


def test_generate_with_no_fragments_returns_422() -> None:
    async def make_empty_project() -> dict[str, str]:
        engine = create_async_engine(settings.database_url)
        try:
            async with AsyncSession(engine) as session:
                ws = Workspace(name="Empty WS", createdAt=_now(), updatedAt=_now())
                session.add(ws)
                await session.flush()
                project = Project(workspaceId=ws.id, name="Empty", createdAt=_now(), updatedAt=_now())
                session.add(project)
                await session.flush()
                ids = {"workspace_id": ws.id, "project_id": project.id}
                await session.commit()
                return ids
        finally:
            await engine.dispose()

    ids = asyncio.run(make_empty_project())
    client = _client_with_fake([])
    try:
        response = client.post(f"/projects/{ids['project_id']}/generate", json={})
    finally:
        _clear_override()
    assert response.status_code == 422

    async def cleanup() -> None:
        engine = create_async_engine(settings.database_url)
        try:
            async with AsyncSession(engine) as session:
                await session.execute(delete(Project).where(Project.id == ids["project_id"]))
                await purge_audit_events(session, ids["workspace_id"])
                await session.execute(delete(Workspace).where(Workspace.id == ids["workspace_id"]))
                await session.commit()
        finally:
            await engine.dispose()

    asyncio.run(cleanup())
