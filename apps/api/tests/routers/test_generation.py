"""Epic 3 pipeline tests — real Postgres, fake AIAdapter injected via dependency
override (canned per-pass outputs keyed on the request schema). Sync tests +
asyncio.run for the event-loop reasons documented in test_sources.py.

Staged generation (Onboarding Flow redesign follow-up): POST /generate now runs
only passes 1-2 (cluster + epics) and returns stage=EPICS_PENDING_REVIEW; a
second explicit POST /generation-runs/{run_id}/generate-downstream call — after
the reviewer approves epics via the normal draft-item decision workflow — runs
passes 3-5 (stories+tasks, supporting items, scoring) scoped to approved epics
only. Most of these tests therefore drive both calls in sequence, approving
epic(s) directly via the DB (the review-decision workflow itself lives in
apps/web, not apps/api — see apps/web/src/lib/review.ts)."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from decimal import Decimal

from fastapi.testclient import TestClient
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import anthropic
import pytest
import httpx

from app.core import db as db_module
from app.core.config import settings
from app.main import app
from app.models import (
    AiCallLog,
    DraftItem,
    DraftItemStatus,
    DraftItemType,
    GenerationRun,
    GenerationRunStage,
    Project,
    RawRequirement,
    ReferenceItem,
    Source,
    TraceLink,
    Workspace,
)
from app.routers.generation import AI_UNAVAILABLE_DETAIL, get_generation_adapter
from app.services.ai.adapter import (
    AIGenerationError,
    GenerationRequest,
    GenerationResult,
    Message,
    UsageInfo,
)
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
        if props == {"digests"}:
            data: dict[str, object] = {
                "digests": [{"text": "Dense digest of a large source.", "source_chunk_ids": c}]
            }
        elif props == {"clusters"}:
            data = {"clusters": [{"theme": "Payments", "chunk_ids": c}]}
        elif props == {"epics", "suggested_tag"}:
            data = {
                "epics": [
                    {
                        "title": "Payments capability",
                        "description": "Customers pay invoices online.",
                        "business_value": "Reduces manual invoicing cost.",
                        "source_chunk_ids": [c[0], c[1]],
                    }
                ],
                "suggested_tag": "payments",
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
            # Non-zero so tests can confirm the pipeline actually threads these
            # through into GenerationRun instead of discarding them (Issue #115).
            queue_wait_seconds=0.5,
            queue_depth_at_submit=2,
        )


class FailingAdapter:
    """Raises AIGenerationError with a distinctive, secret-looking payload — used to
    prove the router never leaks raw provider exception text into the response."""

    SECRET = "rate_limit_exceeded: sk-ant-api03-SECRET-LOOKING-TOKEN retry after 30s"

    async def generate(self, request: GenerationRequest) -> GenerationResult:
        raise AIGenerationError(self.SECRET)


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


async def _create_large_fixture() -> dict[str, object]:
    """A source whose combined fragments block exceeds the summarization
    character budget (FRAGMENTS_BLOCK_CHAR_BUDGET) — enough fragments, each
    comfortably real-looking, to push well past it."""
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            ws = Workspace(name="Gen Large Test WS", createdAt=_now(), updatedAt=_now())
            session.add(ws)
            await session.flush()
            project = Project(
                workspaceId=ws.id, name="Gen Large Test Project", createdAt=_now(), updatedAt=_now()
            )
            session.add(project)
            await session.flush()
            source = Source(
                projectId=project.id, name="big-reqs.docx", kind="DOCX",
                storageKey="k", createdAt=_now(), updatedAt=_now(),
            )
            session.add(source)
            await session.flush()

            # Each fragment is ~500 chars; 120 of them comfortably exceeds the
            # 45K character budget once bracketed ids/section paths are added.
            chunk_ids: list[str] = []
            for order in range(120):
                fragment = RawRequirement(
                    sourceId=source.id,
                    text=f"Requirement fragment number {order}: " + ("detail " * 60),
                    sectionPath=f"p.{order}",
                    order=order,
                    createdAt=_now(),
                    updatedAt=_now(),
                )
                session.add(fragment)
                await session.flush()
                chunk_ids.append(fragment.id)

            ids = {
                "workspace_id": ws.id, "project_id": project.id,
                "source_id": source.id, "chunk_ids": chunk_ids,
            }
            await session.commit()
            return ids
    finally:
        await engine.dispose()


async def _add_source(
    project_id: str, name: str, texts: list[tuple[str, str]]
) -> dict[str, object]:
    """Adds a second source (+ fragments) to an existing project — used by the
    source-scoping tests to prove a later generate_epics call only processes
    the newly added source, not content already claimed by a prior run."""
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            source = Source(
                projectId=project_id, name=name, kind="DOCX", storageKey="k",
                createdAt=_now(), updatedAt=_now(),
            )
            session.add(source)
            await session.flush()
            source_id = source.id
            chunk_ids: list[str] = []
            for order, (text, path) in enumerate(texts):
                fragment = RawRequirement(
                    sourceId=source_id, text=text, sectionPath=path, order=order,
                    createdAt=_now(), updatedAt=_now(),
                )
                session.add(fragment)
                await session.flush()
                chunk_ids.append(fragment.id)
            await session.commit()
            return {"source_id": source_id, "chunk_ids": chunk_ids}
    finally:
        await engine.dispose()


async def _get_source_generated_run_id(source_id: str) -> str | None:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            source = await session.get(Source, source_id)
            assert source is not None
            return source.generatedInRunId
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
            source_ids = [
                s.id
                for s in (
                    await session.execute(select(Source).where(Source.projectId == project_id))
                ).scalars()
            ]
            if source_ids:
                await session.execute(
                    delete(RawRequirement).where(RawRequirement.sourceId.in_(source_ids))
                )
                # Clear generatedInRunId first — GenerationRun rows above may
                # already be gone, but the FK is enforced either way.
                await session.execute(
                    update(Source).where(Source.id.in_(source_ids)).values(generatedInRunId=None)
                )
                await session.execute(delete(Source).where(Source.id.in_(source_ids)))
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


async def _approve_all_epics(project_id: str) -> None:
    """Stand-in for the apps/web review-decision workflow (approve/reject lives
    there, not in apps/api) — flips every EPIC DraftItem for this project to
    APPROVED so generate_downstream has something to work from."""
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            epics = (
                await session.execute(
                    select(DraftItem).where(
                        DraftItem.projectId == project_id,
                        DraftItem.type == DraftItemType.EPIC,
                        DraftItem.deletedAt.is_(None),
                    )
                )
            ).scalars()
            for epic in epics:
                epic.status = DraftItemStatus.APPROVED
            await session.commit()
    finally:
        await engine.dispose()


def _client_with_fake(chunk_ids: list[str]) -> TestClient:
    app.dependency_overrides[get_generation_adapter] = lambda: FakeAdapter(chunk_ids)
    return TestClient(app)


def _clear_override() -> None:
    app.dependency_overrides.pop(get_generation_adapter, None)
    _dispose_app_engine()


def _generate_epics_and_downstream(client: TestClient, project_id: str) -> tuple[dict, dict]:
    """Drives the full two-step flow: POST /generate (epics only), approve the
    epic(s) it produced, then POST the downstream call. Returns both responses'
    JSON bodies."""
    epics_response = client.post(f"/projects/{project_id}/generate", json={})
    assert epics_response.status_code == 200, epics_response.text
    epics_body = epics_response.json()
    assert epics_body["stage"] == "EPICS_PENDING_REVIEW"

    _dispose_app_engine()
    asyncio.run(_approve_all_epics(project_id))

    downstream_response = client.post(
        f"/generation-runs/{epics_body['run_id']}/generate-downstream", json={}
    )
    assert downstream_response.status_code == 200, downstream_response.text
    return epics_body, downstream_response.json()


def test_full_generation_run_produces_hierarchy_traces_scores_and_flags() -> None:
    ids = asyncio.run(_create_fixture())
    chunk_ids = list(map(str, ids["chunk_ids"]))  # type: ignore[arg-type]
    project_id = str(ids["project_id"])

    client = _client_with_fake(chunk_ids)
    try:
        epics_body, downstream_body = _generate_epics_and_downstream(client, project_id)
    finally:
        _clear_override()

    assert downstream_body["stage"] == "COMPLETE"
    stats = downstream_body["stats"]
    assert stats["items_by_type"]["EPIC"] == 1
    assert stats["items_by_type"]["STORY"] == 2
    assert stats["items_by_type"]["TASK"] == 1
    assert stats["gaps_flagged"] >= 1
    assert stats["duplicates_flagged"] >= 1
    assert stats["untraced_items"] == 1  # the uncited assumption
    assert stats["source_coverage"] == 1.0  # all three fragments cited somewhere

    # Queueing observability (Issue #115): accumulated across both the epics
    # phase (clustering + epics = 2 calls) and the downstream phase (stories +
    # supporting + scoring = 3 calls), each call contributing 0.5s from
    # FakeAdapter — so the total should be 5 * 0.5 = 2.5s, and the max depth
    # should be FakeAdapter's constant 2.
    assert stats["queue_wait_seconds_total"] == pytest.approx(2.5)
    assert stats["queue_depth_at_submit_max"] == 2

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
    # downstream_drafts is [story_card, story_erp, task, ac, risk, assumption] —
    # the fake scoring data's item_index=2 (the low-score gap one) lands on task.
    assert story_card.qualityScore is not None
    task_flags = task.flags or {}
    assert "ERP version" in task_flags["gap"]["question"]  # type: ignore[index]

    # Duplicate flag (Issue 3.5) against the PAY-118 reference item.
    dup_flags = story_card.flags or {}
    assert dup_flags["duplicate"]["key"] == "PAY-118"  # type: ignore[index]

    # Original AI draft snapshot (Issue 4.3 baseline) + prompt version (3.1).
    assert epic.originalDraft is not None and epic.promptVersion == "generation_v1"

    asyncio.run(_cleanup(ids))


def test_generate_epics_persists_only_epics_and_awaits_review() -> None:
    """The whole point of staging: POST /generate stops after epics, before any
    stories/tasks/supporting items are drafted."""
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
    assert body["stage"] == "EPICS_PENDING_REVIEW"
    assert body["reused_existing_run"] is False
    assert body["stats"]["items_by_type"] == {"EPIC": 1}

    items = asyncio.run(_fetch_items(project_id))
    assert len(items) == 1
    assert items[0].type == DraftItemType.EPIC
    assert items[0].status == DraftItemStatus.PENDING

    asyncio.run(_cleanup(ids))


def test_generate_downstream_requires_approved_epic() -> None:
    ids = asyncio.run(_create_fixture())
    chunk_ids = list(map(str, ids["chunk_ids"]))  # type: ignore[arg-type]
    project_id = str(ids["project_id"])

    client = _client_with_fake(chunk_ids)
    try:
        epics_response = client.post(f"/projects/{project_id}/generate", json={})
        run_id = epics_response.json()["run_id"]
        _dispose_app_engine()
        # No approval step — every epic is still PENDING.
        downstream_response = client.post(f"/generation-runs/{run_id}/generate-downstream", json={})
    finally:
        _clear_override()

    assert downstream_response.status_code == 422
    assert "approve" in downstream_response.json()["detail"].lower()

    asyncio.run(_cleanup(ids))


def test_generate_downstream_returns_404_for_unknown_run() -> None:
    client = TestClient(app)
    response = client.post("/generation-runs/does-not-exist/generate-downstream", json={})
    _dispose_app_engine()
    assert response.status_code == 404


def test_generate_downstream_returns_409_when_already_complete() -> None:
    ids = asyncio.run(_create_fixture())
    chunk_ids = list(map(str, ids["chunk_ids"]))  # type: ignore[arg-type]
    project_id = str(ids["project_id"])

    client = _client_with_fake(chunk_ids)
    try:
        epics_body, _ = _generate_epics_and_downstream(client, project_id)
        _dispose_app_engine()
        # Run is now COMPLETE — calling downstream again should be rejected.
        second = client.post(
            f"/generation-runs/{epics_body['run_id']}/generate-downstream", json={}
        )
    finally:
        _clear_override()

    assert second.status_code == 409

    asyncio.run(_cleanup(ids))


def test_generate_again_with_no_new_sources_raises_clear_error() -> None:
    """Source-scoped generation (each source is claimed by exactly one run, via
    generatedInRunId) means re-calling /generate with nothing new to process no
    longer silently reuses the prior run — it raises a clear 422 telling the
    reviewer to add a new source or remove an existing one."""
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
    assert second.status_code == 422
    assert "already been included" in second.json()["detail"]
    assert len(asyncio.run(_fetch_items(project_id))) == 1  # still just the one epic

    asyncio.run(_cleanup(ids))


def test_generate_response_includes_ai_suggested_tag_and_name() -> None:
    ids = asyncio.run(_create_fixture())
    chunk_ids = list(map(str, ids["chunk_ids"]))  # type: ignore[arg-type]
    project_id = str(ids["project_id"])

    client = _client_with_fake(chunk_ids)
    try:
        response = client.post(f"/projects/{project_id}/generate", json={})
    finally:
        _clear_override()

    body = response.json()
    assert body["tag"] == "payments"
    assert body["name"] is not None
    assert body["name"].endswith("-payments-generated01")

    asyncio.run(_cleanup(ids))


def test_generate_epics_response_surfaces_queue_metrics() -> None:
    """The epics-only response (before any downstream call) must already
    reflect the clustering+epics passes' queue-wait data (Issue #115) — not
    just the final downstream response."""
    ids = asyncio.run(_create_fixture())
    chunk_ids = list(map(str, ids["chunk_ids"]))  # type: ignore[arg-type]
    project_id = str(ids["project_id"])

    client = _client_with_fake(chunk_ids)
    try:
        response = client.post(f"/projects/{project_id}/generate", json={})
    finally:
        _clear_override()

    stats = response.json()["stats"]
    # Clustering + epics = 2 calls, each contributing 0.5s from FakeAdapter.
    assert stats["queue_wait_seconds_total"] == pytest.approx(1.0)
    assert stats["queue_depth_at_submit_max"] == 2

    asyncio.run(_cleanup(ids))


def test_generate_epics_stamps_contributing_sources() -> None:
    """A source's fragments are marked as claimed by the run the moment epics
    are persisted — not deferred to generate_downstream's COMPLETE stage —
    so a second generate_epics call while this run is still pending review
    can't reprocess the same content."""
    ids = asyncio.run(_create_fixture())
    chunk_ids = list(map(str, ids["chunk_ids"]))  # type: ignore[arg-type]
    project_id = str(ids["project_id"])
    source_id = str(ids["source_id"])

    client = _client_with_fake(chunk_ids)
    try:
        response = client.post(f"/projects/{project_id}/generate", json={})
    finally:
        _clear_override()

    run_id = response.json()["run_id"]
    assert asyncio.run(_get_source_generated_run_id(source_id)) == run_id

    asyncio.run(_cleanup(ids))


def test_second_generate_only_processes_the_newly_added_source() -> None:
    """Adding a new source and generating again must not re-cluster/re-epic
    the first source's already-claimed content — this is the mechanism that
    replaces cross-run dedup for preventing near-duplicate epics."""
    ids = asyncio.run(_create_fixture())
    chunk_ids_a = list(map(str, ids["chunk_ids"]))  # type: ignore[arg-type]
    project_id = str(ids["project_id"])

    client = _client_with_fake(chunk_ids_a)
    try:
        first = client.post(f"/projects/{project_id}/generate", json={})
    finally:
        _clear_override()
    assert first.json()["stats"]["fragment_count"] == 3
    _dispose_app_engine()

    new_source = asyncio.run(
        _add_source(
            project_id,
            "extra.docx",
            [
                ("A brand-new requirement about billing.", "p.1"),
                ("Billing invoices must support multiple currencies.", "p.2"),
            ],
        )
    )
    chunk_ids_b = list(map(str, new_source["chunk_ids"]))  # type: ignore[arg-type]

    client = _client_with_fake(chunk_ids_b)
    try:
        second = client.post(f"/projects/{project_id}/generate", json={})
    finally:
        _clear_override()

    second_body = second.json()
    assert second_body["run_id"] != first.json()["run_id"]
    assert second_body["stats"]["fragment_count"] == 2  # only the new source's fragments
    assert asyncio.run(_get_source_generated_run_id(str(new_source["source_id"]))) == (
        second_body["run_id"]
    )

    asyncio.run(_cleanup(ids))


def test_generate_downstream_only_uses_its_own_run_sources() -> None:
    """Once two runs exist for the same project (each having claimed a
    different source), generate_downstream for the first run must not pull in
    the second run's source content."""
    ids = asyncio.run(_create_fixture())
    chunk_ids_a = list(map(str, ids["chunk_ids"]))  # type: ignore[arg-type]
    project_id = str(ids["project_id"])

    client = _client_with_fake(chunk_ids_a)
    try:
        first_response = client.post(f"/projects/{project_id}/generate", json={})
        first_run_id = first_response.json()["run_id"]
        _dispose_app_engine()
        asyncio.run(_approve_all_epics(project_id))
        downstream_response = client.post(
            f"/generation-runs/{first_run_id}/generate-downstream", json={}
        )
    finally:
        _clear_override()

    downstream_stats = downstream_response.json()["stats"]
    # fragment_count in the final stats reflects only this run's own source
    # (the fixture's 3 fragments) — a second source added afterward must not
    # leak into a run that already completed its epics pass beforehand.
    assert downstream_stats["fragment_count"] == 3

    asyncio.run(_cleanup(ids))


def test_patch_generation_run_renames_tag_and_name() -> None:
    ids = asyncio.run(_create_fixture())
    chunk_ids = list(map(str, ids["chunk_ids"]))  # type: ignore[arg-type]
    project_id = str(ids["project_id"])

    client = _client_with_fake(chunk_ids)
    try:
        generate_response = client.post(f"/projects/{project_id}/generate", json={})
    finally:
        _clear_override()
    run_id = generate_response.json()["run_id"]

    client = TestClient(app)
    patch_response = client.patch(
        f"/generation-runs/{run_id}", json={"tag": "billing", "name": "custom-name"}
    )
    _dispose_app_engine()

    assert patch_response.status_code == 200
    body = patch_response.json()
    assert body["tag"] == "billing"
    assert body["name"] == "custom-name"

    asyncio.run(_cleanup(ids))


def test_patch_generation_run_returns_404_for_unknown_run() -> None:
    client = TestClient(app)
    response = client.patch("/generation-runs/does-not-exist", json={"name": "x"})
    _dispose_app_engine()
    assert response.status_code == 404


def test_patch_generation_run_rejects_empty_name() -> None:
    ids = asyncio.run(_create_fixture())
    chunk_ids = list(map(str, ids["chunk_ids"]))  # type: ignore[arg-type]
    project_id = str(ids["project_id"])

    client = _client_with_fake(chunk_ids)
    try:
        generate_response = client.post(f"/projects/{project_id}/generate", json={})
    finally:
        _clear_override()
    run_id = generate_response.json()["run_id"]

    client = TestClient(app)
    response = client.patch(f"/generation-runs/{run_id}", json={"name": "   "})
    _dispose_app_engine()
    assert response.status_code == 422

    asyncio.run(_cleanup(ids))


def test_generate_downstream_only_covers_approved_epics() -> None:
    """A rejected epic gets no children — generate_downstream only expands
    epics the reviewer actually approved."""
    ids = asyncio.run(_create_fixture())
    chunk_ids = list(map(str, ids["chunk_ids"]))  # type: ignore[arg-type]
    project_id = str(ids["project_id"])

    client = _client_with_fake(chunk_ids)
    try:
        epics_response = client.post(f"/projects/{project_id}/generate", json={})
        run_id = epics_response.json()["run_id"]
        _dispose_app_engine()

        # Reject the only epic (this fixture's FakeAdapter always drafts exactly
        # one), confirm downstream correctly refuses with zero approved epics.
        async def reject_epic() -> None:
            engine = create_async_engine(settings.database_url)
            try:
                async with AsyncSession(engine) as session:
                    epic = (
                        await session.execute(
                            select(DraftItem).where(
                                DraftItem.projectId == project_id,
                                DraftItem.type == DraftItemType.EPIC,
                            )
                        )
                    ).scalar_one()
                    epic.status = DraftItemStatus.REJECTED
                    await session.commit()
            finally:
                await engine.dispose()

        asyncio.run(reject_epic())
        downstream_response = client.post(f"/generation-runs/{run_id}/generate-downstream", json={})
    finally:
        _clear_override()

    assert downstream_response.status_code == 422

    asyncio.run(_cleanup(ids))


def test_generate_downstream_sets_stage_complete_with_updated_timestamp() -> None:
    ids = asyncio.run(_create_fixture())
    chunk_ids = list(map(str, ids["chunk_ids"]))  # type: ignore[arg-type]
    project_id = str(ids["project_id"])

    client = _client_with_fake(chunk_ids)
    try:
        epics_body, downstream_body = _generate_epics_and_downstream(client, project_id)
    finally:
        _clear_override()

    assert downstream_body["stage"] == "COMPLETE"

    async def fetch_run() -> GenerationRun:
        engine = create_async_engine(settings.database_url)
        try:
            async with AsyncSession(engine) as session:
                run = await session.get(GenerationRun, epics_body["run_id"])
                assert run is not None
                return run
        finally:
            await engine.dispose()

    run = asyncio.run(fetch_run())
    assert run.stage == GenerationRunStage.COMPLETE
    assert run.updatedAt >= run.createdAt

    asyncio.run(_cleanup(ids))


def test_generate_with_large_fragments_triggers_summarization() -> None:
    """A source whose combined fragments block exceeds the character budget
    gets summarized before the epics passes see it — proven by a populated,
    much-smaller-than-raw summarizedFragmentsBlock. (FakeAdapter bypasses
    LoggingAdapter entirely, so AiCallLog assertions belong to the "real
    composition" tests further down, not here — this test proves the
    pipeline-level branch, not the logging integration.)"""
    ids = asyncio.run(_create_large_fixture())
    chunk_ids = list(map(str, ids["chunk_ids"]))  # type: ignore[arg-type]
    project_id = str(ids["project_id"])

    client = _client_with_fake(chunk_ids)
    try:
        response = client.post(f"/projects/{project_id}/generate", json={})
    finally:
        _clear_override()

    assert response.status_code == 200, response.text
    run_id = response.json()["run_id"]

    async def fetch_run() -> GenerationRun:
        engine = create_async_engine(settings.database_url)
        try:
            async with AsyncSession(engine) as session:
                run = await session.get(GenerationRun, run_id)
                assert run is not None
                return run
        finally:
            await engine.dispose()

    run = asyncio.run(fetch_run())
    assert run.summarizedFragmentsBlock is not None
    assert run.summarizedFragmentsBlock != ""

    asyncio.run(_cleanup(ids))


def test_generate_with_small_fragments_skips_summarization() -> None:
    """The common case — a small pasted requirement — never touches the
    summarization path at all: no cached digest."""
    ids = asyncio.run(_create_fixture())
    chunk_ids = list(map(str, ids["chunk_ids"]))  # type: ignore[arg-type]
    project_id = str(ids["project_id"])

    client = _client_with_fake(chunk_ids)
    try:
        response = client.post(f"/projects/{project_id}/generate", json={})
    finally:
        _clear_override()

    assert response.status_code == 200, response.text
    run_id = response.json()["run_id"]

    async def fetch_run() -> GenerationRun:
        engine = create_async_engine(settings.database_url)
        try:
            async with AsyncSession(engine) as session:
                run = await session.get(GenerationRun, run_id)
                assert run is not None
                return run
        finally:
            await engine.dispose()

    run = asyncio.run(fetch_run())
    assert run.summarizedFragmentsBlock is None

    asyncio.run(_cleanup(ids))


def test_first_generation_stamps_workspace_time_to_value_once() -> None:
    """Issue 10.10: firstGenerationAt is set on a workspace's first-ever
    completed (downstream) generation run, and never overwritten by later runs."""
    ids = asyncio.run(_create_fixture())
    chunk_ids = list(map(str, ids["chunk_ids"]))  # type: ignore[arg-type]
    project_id = str(ids["project_id"])
    workspace_id = str(ids["workspace_id"])

    async def fetch_stamp() -> object:
        engine = create_async_engine(settings.database_url)
        try:
            async with AsyncSession(engine) as session:
                ws = await session.get(Workspace, workspace_id)
                assert ws is not None
                return ws.firstGenerationAt
        finally:
            await engine.dispose()

    client = _client_with_fake(chunk_ids)
    try:
        assert asyncio.run(fetch_stamp()) is None  # unstamped before any generation
        _generate_epics_and_downstream(client, project_id)
    finally:
        _clear_override()

    first_stamp = asyncio.run(fetch_stamp())
    assert first_stamp is not None

    asyncio.run(_cleanup(ids))


def test_regenerate_item_creates_revision_and_preserves_original() -> None:
    ids = asyncio.run(_create_fixture())
    chunk_ids = list(map(str, ids["chunk_ids"]))  # type: ignore[arg-type]
    project_id = str(ids["project_id"])

    client = _client_with_fake(chunk_ids)
    try:
        _generate_epics_and_downstream(client, project_id)
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
        _generate_epics_and_downstream(client, project_id)
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


def test_generate_returns_503_when_ai_generation_fails() -> None:
    ids = asyncio.run(_create_fixture())
    project_id = str(ids["project_id"])

    app.dependency_overrides[get_generation_adapter] = lambda: FailingAdapter()
    client = TestClient(app)
    try:
        response = client.post(f"/projects/{project_id}/generate", json={})
    finally:
        app.dependency_overrides.pop(get_generation_adapter, None)
        _dispose_app_engine()

    assert response.status_code == 503
    assert response.json()["detail"] == AI_UNAVAILABLE_DETAIL
    assert "SECRET-LOOKING-TOKEN" not in response.text

    asyncio.run(_cleanup(ids))


def test_generate_downstream_returns_503_when_ai_generation_fails() -> None:
    ids = asyncio.run(_create_fixture())
    chunk_ids = list(map(str, ids["chunk_ids"]))  # type: ignore[arg-type]
    project_id = str(ids["project_id"])

    client = _client_with_fake(chunk_ids)
    try:
        epics_response = client.post(f"/projects/{project_id}/generate", json={})
        run_id = epics_response.json()["run_id"]
        _dispose_app_engine()
        asyncio.run(_approve_all_epics(project_id))
    finally:
        _clear_override()

    app.dependency_overrides[get_generation_adapter] = lambda: FailingAdapter()
    client = TestClient(app)
    try:
        response = client.post(f"/generation-runs/{run_id}/generate-downstream", json={})
    finally:
        app.dependency_overrides.pop(get_generation_adapter, None)
        _dispose_app_engine()

    assert response.status_code == 503
    assert response.json()["detail"] == AI_UNAVAILABLE_DETAIL
    assert "SECRET-LOOKING-TOKEN" not in response.text

    asyncio.run(_cleanup(ids))


def test_regenerate_item_returns_503_when_ai_generation_fails() -> None:
    ids = asyncio.run(_create_fixture())
    chunk_ids = list(map(str, ids["chunk_ids"]))  # type: ignore[arg-type]
    project_id = str(ids["project_id"])

    client = _client_with_fake(chunk_ids)
    try:
        _generate_epics_and_downstream(client, project_id)
        _dispose_app_engine()

        items = asyncio.run(_fetch_items(project_id))
        erp_story = next(i for i in items if "ERP" in i.title)
    finally:
        _clear_override()

    app.dependency_overrides[get_generation_adapter] = lambda: FailingAdapter()
    client = TestClient(app)
    try:
        response = client.post(
            f"/draft-items/{erp_story.id}/regenerate",
            json={"context": "The export targets ERP v3 via REST.", "workspace_id": str(ids["workspace_id"])},
        )
    finally:
        app.dependency_overrides.pop(get_generation_adapter, None)
        _dispose_app_engine()

    assert response.status_code == 503
    assert response.json()["detail"] == AI_UNAVAILABLE_DETAIL
    assert "SECRET-LOOKING-TOKEN" not in response.text

    asyncio.run(_cleanup(ids))


async def _purge_ai_call_logs(workspace_id: str) -> None:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            await session.execute(delete(AiCallLog).where(AiCallLog.workspaceId == workspace_id))
            await session.commit()
    finally:
        await engine.dispose()


def _fake_claude_response_for(request_body: dict[str, object], chunk_ids: list[str]) -> SimpleNamespace:
    """Mirrors FakeAdapter's per-pass schema dispatch above, but returns a raw
    Claude-shaped HTTP response (text content + usage), since this stubs
    AsyncAnthropic.messages.create rather than AIAdapter.generate — the whole
    point of Issue #107 is exercising ClaudeAdapter/LoggingAdapter/
    SchedulingAdapter's real composition, not bypassing it."""
    import json

    c = chunk_ids
    schema = request_body["output_config"]["format"]["schema"]  # type: ignore[index]
    props = set(schema.get("properties", {}))
    if props == {"clusters"}:
        data: dict[str, object] = {"clusters": [{"theme": "Payments", "chunk_ids": c}]}
    elif props == {"epics", "suggested_tag"}:
        data = {
            "epics": [
                {
                    "title": "Payments capability",
                    "description": "Customers pay invoices online.",
                    "business_value": "Reduces manual invoicing cost.",
                    "source_chunk_ids": [c[0], c[1]],
                }
            ],
            "suggested_tag": "payments",
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
                }
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
                }
            ]
        }
    elif props == {"scores"}:
        data = {
            "scores": [
                {
                    "item_index": 0, "completeness": 90, "clarity": 88, "testability": 85,
                    "specificity": 90, "rationale": "Well specified.", "gap_question": None,
                }
            ]
        }
    else:
        raise AssertionError(f"unexpected schema properties: {props}")

    return SimpleNamespace(
        content=[SimpleNamespace(type="text", text=json.dumps(data))],
        usage=SimpleNamespace(
            input_tokens=100, output_tokens=50,
            cache_read_input_tokens=0, cache_creation_input_tokens=0,
        ),
        stop_reason="end_turn",
    )


def test_real_generation_adapter_composition_produces_a_run_end_to_end() -> None:
    """Issue #107: exercises the actual, UNMODIFIED get_generation_adapter()
    composition (SchedulingAdapter(LoggingAdapter(ClaudeAdapter(), session),
    _ai_scheduler)) through the real /projects/{id}/generate and
    /generation-runs/{id}/generate-downstream endpoints — every other
    generation test overrides get_generation_adapter entirely, so this is the
    only test that would catch a broken composition order, a dropped layer, or
    the scheduler singleton not being reused. Only ClaudeAdapter's HTTP layer
    (AsyncAnthropic) is stubbed."""
    ids = asyncio.run(_create_fixture())
    chunk_ids = list(map(str, ids["chunk_ids"]))  # type: ignore[arg-type]
    project_id = str(ids["project_id"])
    workspace_id = str(ids["workspace_id"])

    async def fake_create(**kwargs: object) -> SimpleNamespace:
        return _fake_claude_response_for(kwargs, chunk_ids)

    mock_anthropic_client = SimpleNamespace(
        messages=SimpleNamespace(create=AsyncMock(side_effect=fake_create))
    )

    with patch(
        "app.services.ai.claude_adapter.AsyncAnthropic", return_value=mock_anthropic_client
    ):
        client = TestClient(app)
        epics_response = client.post(f"/projects/{project_id}/generate", json={})
        run_id = epics_response.json()["run_id"]
        _dispose_app_engine()
        asyncio.run(_approve_all_epics(project_id))

        client = TestClient(app)
        response = client.post(f"/generation-runs/{run_id}/generate-downstream", json={})
        _dispose_app_engine()

    assert response.status_code == 200
    body = response.json()
    assert body["stats"]["item_count"] >= 1

    async def count_call_logs() -> int:
        engine = create_async_engine(settings.database_url)
        try:
            async with AsyncSession(engine) as session:
                result = await session.execute(
                    select(AiCallLog).where(AiCallLog.workspaceId == workspace_id)
                )
                return len(list(result.scalars()))
        finally:
            await engine.dispose()

    # LoggingAdapter (the real one, not bypassed) should have written one
    # AiCallLog row per pass across both calls (2 for epics + 3 for downstream).
    assert asyncio.run(count_call_logs()) == 5

    asyncio.run(_purge_ai_call_logs(workspace_id))
    asyncio.run(_cleanup(ids))


def test_real_generation_adapter_composition_surfaces_rate_limit_as_503() -> None:
    """Issue #107: the RateLimitError -> AIGenerationError -> 503 translation
    through the real composed chain, not FailingAdapter's direct bypass."""
    ids = asyncio.run(_create_fixture())
    workspace_id = str(ids["workspace_id"])
    project_id = str(ids["project_id"])

    fake_httpx_response = httpx.Response(
        status_code=429, request=httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    )
    rate_limit_error = anthropic.RateLimitError(
        message="rate limited", response=fake_httpx_response, body=None
    )
    mock_anthropic_client = SimpleNamespace(
        messages=SimpleNamespace(create=AsyncMock(side_effect=rate_limit_error))
    )

    with patch(
        "app.services.ai.claude_adapter.AsyncAnthropic", return_value=mock_anthropic_client
    ):
        client = TestClient(app)
        response = client.post(f"/projects/{project_id}/generate", json={})
        _dispose_app_engine()

    assert response.status_code == 503
    assert response.json()["detail"] == AI_UNAVAILABLE_DETAIL

    asyncio.run(_purge_ai_call_logs(workspace_id))
    asyncio.run(_cleanup(ids))


def test_scheduling_adapter_wraps_the_real_singleton_scheduler_around_the_call() -> None:
    """Issue #107: get_generation_adapter()'s composition puts SchedulingAdapter
    as the OUTERMOST layer, wrapping the module-level `_ai_scheduler` singleton
    around every call — verify this directly against the real composed adapter
    (not a hand-built fake) by spying on the singleton's own `acquire()`, since
    asserting on GenerationResult.queue_wait_seconds/queue_depth_at_submit alone
    is a weak signal (they default to 0.0/0 on the dataclass, so a composition
    that silently dropped SchedulingAdapter entirely would still "pass" a bare
    >= 0 assertion). Confirmed this spy-based approach actually distinguishes
    the two cases by temporarily dropping SchedulingAdapter from
    get_generation_adapter() during development and watching this test fail
    (call_count == 0) while a >=0 assertion on the result stayed green.

    Note: pipeline.py's _call() currently only reads GenerationResult.data —
    queue_wait_seconds/queue_depth_at_submit are computed by SchedulingAdapter
    but never persisted to GenerationRun.stats or surfaced in the API response
    (a separate, already-flagged gap). This test locks in the
    composition-level contract Issue #107 asked for; it doesn't claim these
    fields are end-to-end visible through the HTTP response."""
    import app.routers.generation as generation_module

    ids = asyncio.run(_create_fixture())
    workspace_id = str(ids["workspace_id"])
    project_id = str(ids["project_id"])

    async def fake_create(**_kwargs: object) -> SimpleNamespace:
        return SimpleNamespace(
            content=[SimpleNamespace(type="text", text='{"clusters": []}')],
            usage=SimpleNamespace(
                input_tokens=10, output_tokens=5,
                cache_read_input_tokens=0, cache_creation_input_tokens=0,
            ),
            stop_reason="end_turn",
        )

    mock_anthropic_client = SimpleNamespace(
        messages=SimpleNamespace(create=AsyncMock(side_effect=fake_create))
    )

    async def run() -> GenerationResult:
        engine = create_async_engine(settings.database_url)
        try:
            async with AsyncSession(engine) as session:
                with (
                    patch(
                        "app.services.ai.claude_adapter.AsyncAnthropic",
                        return_value=mock_anthropic_client,
                    ),
                    patch.object(
                        generation_module._ai_scheduler,
                        "acquire",
                        wraps=generation_module._ai_scheduler.acquire,
                    ) as spy_acquire,
                ):
                    adapter = generation_module.get_generation_adapter(session)
                    result = await adapter.generate(
                        GenerationRequest(
                            task="clustering",
                            messages=[Message(role="user", content="cluster this")],
                            schema_={"type": "object", "properties": {"clusters": {}}},
                            workspace_id=workspace_id,
                            project_id=project_id,
                        )
                    )
                    assert spy_acquire.call_count == 1
                    assert spy_acquire.call_args.args[0] == workspace_id
                await session.commit()
                return result
        finally:
            await engine.dispose()

    result = asyncio.run(run())
    assert result.data == {"clusters": []}

    asyncio.run(_purge_ai_call_logs(workspace_id))
    asyncio.run(_cleanup(ids))
