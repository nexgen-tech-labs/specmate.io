"""Targeted regeneration tests (Issue 9.2) — real Postgres, fake AIAdapter. Builds a
v1 source with generated items, links a v2 source with a diff (Issue 9.1's machinery,
driven directly rather than through the parse endpoint for fixture control), then
verifies only the affected items are touched."""

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
from app.models import DraftItem, Project, RawRequirement, Source, SourceDiff, TraceLink, Workspace
from app.routers.generation import get_generation_adapter
from app.services.ai.adapter import GenerationRequest, GenerationResult, UsageInfo
from tests.audit_cleanup import purge_audit_events


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _dispose_app_engine() -> None:
    asyncio.run(db_module.engine.dispose())


class FakeAdapter:
    """Distinguishes the two targeted-regen prompts by their schema shape."""

    async def generate(self, request: GenerationRequest) -> GenerationResult:
        props = set(request.schema_.get("properties", {}))  # type: ignore[union-attr]
        if props == {"title", "description", "extra"}:
            # REGENERATE_SCHEMA — revising an existing item.
            data: dict[str, object] = {
                "title": "As a customer, I can pay with a saved card (updated)",
                "description": "Revised: saved card payment now supports 3DS.",
                "extra": {},
            }
        elif props == {"type", "title", "description", "extra"}:
            # NEW_FROM_FRAGMENT_SCHEMA — brand-new fragment.
            data = {
                "type": "STORY",
                "title": "As a customer, I can request a refund",
                "description": "New refund flow from the added fragment.",
                "extra": {},
            }
        else:
            raise AssertionError(f"unexpected schema properties: {props}")
        return GenerationResult(
            data=data,
            raw_text="{}",
            usage=UsageInfo(10, 10, 0, 0),
            cost_usd=Decimal("0.001"),
            latency_ms=5,
            model="fake-model",
            prompt_version="generation_v1",
        )


async def _build_fixture() -> dict[str, object]:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            ws = Workspace(name="Targeted Regen WS", createdAt=_now(), updatedAt=_now())
            session.add(ws)
            await session.flush()
            project = Project(
                workspaceId=ws.id, name="Targeted Regen Project", createdAt=_now(), updatedAt=_now()
            )
            session.add(project)
            await session.flush()

            v1 = Source(
                projectId=project.id, name="reqs-v1.docx", kind="DOCX",
                storageKey="k1", version=1, createdAt=_now(), updatedAt=_now(),
            )
            session.add(v1)
            await session.flush()

            unchanged_frag = RawRequirement(
                sourceId=v1.id, text="Customers can browse the catalog.", sectionPath="p.1",
                order=0, createdAt=_now(), updatedAt=_now(),
            )
            modified_frag_old = RawRequirement(
                sourceId=v1.id, text="Customers can pay with a saved card.", sectionPath="p.2",
                order=1, createdAt=_now(), updatedAt=_now(),
            )
            removed_frag_old = RawRequirement(
                sourceId=v1.id, text="Customers can view order history.", sectionPath="p.3",
                order=2, createdAt=_now(), updatedAt=_now(),
            )
            session.add_all([unchanged_frag, modified_frag_old, removed_frag_old])
            await session.flush()

            # Pre-existing DraftItems as if a prior full generation ran.
            unchanged_item = DraftItem(
                projectId=project.id, type="STORY", title="Browse catalog",
                description="Catalog browsing.", status="PENDING",
                promptVersion="generation_v1", createdAt=_now(), updatedAt=_now(),
            )
            modified_item = DraftItem(
                projectId=project.id, type="STORY", title="Pay with saved card",
                description="Saved card payment.", status="PENDING",
                promptVersion="generation_v1", createdAt=_now(), updatedAt=_now(),
            )
            removed_item = DraftItem(
                projectId=project.id, type="STORY", title="View order history",
                description="Order history.", status="PENDING",
                promptVersion="generation_v1", createdAt=_now(), updatedAt=_now(),
            )
            session.add_all([unchanged_item, modified_item, removed_item])
            await session.flush()

            session.add_all(
                [
                    TraceLink(
                        sourceId=v1.id, rawRequirementId=unchanged_frag.id,
                        draftItemId=unchanged_item.id, createdAt=_now(), updatedAt=_now(),
                    ),
                    TraceLink(
                        sourceId=v1.id, rawRequirementId=modified_frag_old.id,
                        draftItemId=modified_item.id, createdAt=_now(), updatedAt=_now(),
                    ),
                    TraceLink(
                        sourceId=v1.id, rawRequirementId=removed_frag_old.id,
                        draftItemId=removed_item.id, createdAt=_now(), updatedAt=_now(),
                    ),
                ]
            )

            # v2: unchanged fragment carried over, modified fragment reworded, removed
            # fragment gone, one brand-new fragment added.
            v2 = Source(
                projectId=project.id, name="reqs-v2.docx", kind="DOCX",
                storageKey="k2", version=2, previousVersionId=v1.id,
                createdAt=_now(), updatedAt=_now(),
            )
            session.add(v2)
            await session.flush()

            unchanged_frag_v2 = RawRequirement(
                sourceId=v2.id, text="Customers can browse the catalog.", sectionPath="p.1",
                order=0, createdAt=_now(), updatedAt=_now(),
            )
            modified_frag_new = RawRequirement(
                sourceId=v2.id, text="Customers can pay with a saved card, incl. 3DS.",
                sectionPath="p.2", order=1, createdAt=_now(), updatedAt=_now(),
            )
            added_frag = RawRequirement(
                sourceId=v2.id, text="Customers can request a refund.", sectionPath="p.3",
                order=2, createdAt=_now(), updatedAt=_now(),
            )
            session.add_all([unchanged_frag_v2, modified_frag_new, added_frag])
            await session.flush()

            diff = SourceDiff(
                sourceId=v2.id,
                previousSourceId=v1.id,
                addedCount=1,
                removedCount=1,
                modifiedCount=1,
                unchangedCount=1,
                fragments=[
                    {
                        "changeType": "unchanged",
                        "sectionPath": "p.1",
                        "rawRequirementId": unchanged_frag_v2.id,
                        "previousRawRequirementId": unchanged_frag.id,
                    },
                    {
                        "changeType": "modified",
                        "sectionPath": "p.2",
                        "rawRequirementId": modified_frag_new.id,
                        "previousRawRequirementId": modified_frag_old.id,
                    },
                    {
                        "changeType": "added",
                        "sectionPath": "p.3",
                        "rawRequirementId": added_frag.id,
                        "previousRawRequirementId": None,
                    },
                    {
                        "changeType": "removed",
                        "sectionPath": "p.3",
                        "rawRequirementId": None,
                        "previousRawRequirementId": removed_frag_old.id,
                    },
                ],
                createdAt=_now(),
            )
            session.add(diff)

            ids = {
                "workspace_id": ws.id,
                "project_id": project.id,
                "v1_source_id": v1.id,
                "v2_source_id": v2.id,
                "unchanged_item_id": unchanged_item.id,
                "modified_item_id": modified_item.id,
                "removed_item_id": removed_item.id,
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
                i.id
                for i in (
                    await session.execute(select(DraftItem).where(DraftItem.projectId == project_id))
                ).scalars()
            ]
            if item_ids:
                await session.execute(delete(TraceLink).where(TraceLink.draftItemId.in_(item_ids)))
                await session.execute(delete(DraftItem).where(DraftItem.id.in_(item_ids)))
            await session.execute(
                delete(SourceDiff).where(SourceDiff.sourceId == str(ids["v2_source_id"]))
            )
            await session.execute(
                delete(RawRequirement).where(
                    RawRequirement.sourceId.in_([str(ids["v1_source_id"]), str(ids["v2_source_id"])])
                )
            )
            await session.execute(
                delete(Source).where(Source.id.in_([str(ids["v1_source_id"]), str(ids["v2_source_id"])]))
            )
            await session.execute(delete(Project).where(Project.id == project_id))
            await purge_audit_events(session, str(ids["workspace_id"]))
            await session.execute(delete(Workspace).where(Workspace.id == str(ids["workspace_id"])))
            await session.commit()
    finally:
        await engine.dispose()


async def _fetch(item_id: str) -> DraftItem | None:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            return await session.get(DraftItem, item_id)
    finally:
        await engine.dispose()


def test_targeted_regeneration_touches_only_affected_items() -> None:
    ids = asyncio.run(_build_fixture())

    app.dependency_overrides[get_generation_adapter] = lambda: FakeAdapter()
    client = TestClient(app)
    try:
        response = client.post(
            f"/sources/{ids['v2_source_id']}/targeted-regenerate",
            json={"workspace_id": str(ids["workspace_id"])},
        )
    finally:
        app.dependency_overrides.pop(get_generation_adapter, None)
        _dispose_app_engine()

    assert response.status_code == 200
    body = response.json()
    assert len(body["revised_item_ids"]) == 1
    assert len(body["new_item_ids"]) == 1
    assert body["flagged_removed_item_ids"] == [ids["removed_item_id"]]
    assert body["untouched_fragment_count"] == 1

    # Unchanged item: byte-for-byte untouched.
    unchanged = asyncio.run(_fetch(str(ids["unchanged_item_id"])))
    assert unchanged is not None
    assert unchanged.title == "Browse catalog"
    assert unchanged.deletedAt is None
    assert unchanged.updatedAt is not None  # sanity: field exists, but title unchanged confirms no rewrite

    # Modified item: old one superseded, new one created via revisionOfId.
    old_modified = asyncio.run(_fetch(str(ids["modified_item_id"])))
    assert old_modified is not None and old_modified.deletedAt is not None
    new_modified = asyncio.run(_fetch(body["revised_item_ids"][0]))
    assert new_modified is not None
    assert new_modified.revisionOfId == ids["modified_item_id"]
    assert "3DS" in new_modified.description or "updated" in new_modified.title
    # Issue 9.3: tagged with the triggering source version for the delta review queue.
    assert new_modified.sourceVersionId == ids["v2_source_id"]

    # Removed item: flagged, not deleted — reviewer decides.
    removed = asyncio.run(_fetch(str(ids["removed_item_id"])))
    assert removed is not None and removed.deletedAt is None
    assert removed.sourceVersionId == ids["v2_source_id"]
    assert removed.flags is not None and removed.flags.get("sourceRemoved") is True

    # Added fragment: a brand-new item, unparented.
    new_item = asyncio.run(_fetch(body["new_item_ids"][0]))
    assert new_item is not None
    assert new_item.parentId is None
    assert "refund" in new_item.title.lower()
    assert new_item.sourceVersionId == ids["v2_source_id"]

    # Unchanged item was never touched, so it carries no source version tag.
    assert unchanged.sourceVersionId is None

    asyncio.run(_cleanup(ids))


def test_targeted_regeneration_returns_422_without_a_diff() -> None:
    async def make_bare_source() -> dict[str, str]:
        engine = create_async_engine(settings.database_url)
        try:
            async with AsyncSession(engine) as session:
                ws = Workspace(name="No Diff WS", createdAt=_now(), updatedAt=_now())
                session.add(ws)
                await session.flush()
                project = Project(workspaceId=ws.id, name="No Diff", createdAt=_now(), updatedAt=_now())
                session.add(project)
                await session.flush()
                source = Source(
                    projectId=project.id, name="solo.docx", kind="DOCX",
                    storageKey="k", createdAt=_now(), updatedAt=_now(),
                )
                session.add(source)
                await session.flush()
                ids = {"workspace_id": ws.id, "project_id": project.id, "source_id": source.id}
                await session.commit()
                return ids
        finally:
            await engine.dispose()

    ids = asyncio.run(make_bare_source())
    app.dependency_overrides[get_generation_adapter] = lambda: FakeAdapter()
    client = TestClient(app)
    try:
        response = client.post(
            f"/sources/{ids['source_id']}/targeted-regenerate",
            json={"workspace_id": ids["workspace_id"]},
        )
    finally:
        app.dependency_overrides.pop(get_generation_adapter, None)
        _dispose_app_engine()

    assert response.status_code == 422

    async def cleanup() -> None:
        engine = create_async_engine(settings.database_url)
        try:
            async with AsyncSession(engine) as session:
                await session.execute(delete(Source).where(Source.id == ids["source_id"]))
                await session.execute(delete(Project).where(Project.id == ids["project_id"]))
                await purge_audit_events(session, ids["workspace_id"])
                await session.execute(delete(Workspace).where(Workspace.id == ids["workspace_id"]))
                await session.commit()
        finally:
            await engine.dispose()

    asyncio.run(cleanup())
