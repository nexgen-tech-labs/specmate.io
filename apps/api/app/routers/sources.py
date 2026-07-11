"""Turns an uploaded Source's stored file into RawRequirement rows, plus the
project-level ingestion pipeline endpoints (Issue #17: reparse-all + summary).
Synchronous per-request parsing for now — no job queue/worker exists yet (see
architecture.md); apps/web calls the parse endpoint right after a successful upload."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db_session
from app.models import RawRequirement, Source, SourceKind, SourceStatus
from app.services.parsing.dedupe import dedupe_chunks
from app.services.parsing.docx_parser import DocxParseError, parse_docx
from app.services.parsing.pdf_parser import PdfParseError, parse_pdf
from app.services.parsing.spreadsheet_parser import SpreadsheetParseError, parse_csv, parse_xlsx
from app.services.parsing.text_parser import TextParseError, parse_text
from app.services.parsing.types import ParsedChunk
from app.services.storage.blob_client import BlobDownloadError, download_blob

router = APIRouter()

BlobDownloader = Callable[[str], Awaitable[bytes]]
Parser = Callable[[bytes], list[ParsedChunk]]

_PARSERS: dict[SourceKind, Parser] = {
    SourceKind.DOCX: parse_docx,
    SourceKind.PDF: parse_pdf,
    SourceKind.XLSX: parse_xlsx,
    SourceKind.CSV: parse_csv,
    SourceKind.TXT: parse_text,
    SourceKind.TRANSCRIPT: parse_text,
}

_PARSE_ERRORS: tuple[type[Exception], ...] = (
    BlobDownloadError,
    DocxParseError,
    PdfParseError,
    SpreadsheetParseError,
    TextParseError,
)


def get_blob_downloader() -> BlobDownloader:
    """FastAPI dependency — overridden in tests to inject a fake blob downloader."""
    return download_blob


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


async def replace_raw_requirements(
    session: AsyncSession, source_id: str, chunks: list[ParsedChunk]
) -> None:
    """Idempotent persist: replaces a Source's RawRequirements with the given chunks
    (shared by the file-parse flow and the connector sync flows)."""
    await session.execute(delete(RawRequirement).where(RawRequirement.sourceId == source_id))
    now = _now()
    for chunk in chunks:
        session.add(
            RawRequirement(
                sourceId=source_id,
                text=chunk.text,
                sectionPath=chunk.section_path,
                order=chunk.order,
                createdAt=now,
                updatedAt=now,
            )
        )


async def _parse_one(
    source: Source, session: AsyncSession, blob_downloader: BlobDownloader
) -> int:
    """Runs the full parse flow for one Source; returns the chunk count. Raises
    HTTPException(422) on parse failure after recording it on the Source row."""
    parser = _PARSERS.get(source.kind)
    if parser is None:
        raise HTTPException(
            status_code=400, detail=f"No parser available for source kind '{source.kind.value}'."
        )
    if not source.storageKey:
        raise HTTPException(status_code=400, detail="Source has no stored file to parse.")

    source.status = SourceStatus.PARSING
    source.updatedAt = _now()
    await session.commit()

    try:
        file_bytes = await blob_downloader(source.storageKey)
        chunks = dedupe_chunks(parser(file_bytes))
    except _PARSE_ERRORS as exc:
        source.status = SourceStatus.FAILED
        source.parseError = str(exc)
        source.updatedAt = _now()
        await session.commit()
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    await replace_raw_requirements(session, source.id, chunks)
    source.status = SourceStatus.PARSED
    source.parseError = None
    source.updatedAt = _now()
    await session.commit()
    return len(chunks)


class ParseSourceResponse(BaseModel):
    source_id: str
    status: str
    chunk_count: int


@router.post("/sources/{source_id}/parse")
async def parse_source(
    source_id: str,
    session: Annotated[AsyncSession, Depends(get_db_session)],
    blob_downloader: Annotated[BlobDownloader, Depends(get_blob_downloader)],
) -> ParseSourceResponse:
    source = await session.get(Source, source_id)
    if source is None:
        raise HTTPException(status_code=404, detail="Source not found.")

    chunk_count = await _parse_one(source, session, blob_downloader)
    return ParseSourceResponse(
        source_id=source_id, status=SourceStatus.PARSED.value, chunk_count=chunk_count
    )


class ReparseResult(BaseModel):
    source_id: str
    name: str
    status: str
    chunk_count: int
    error: str | None = None


class ReparseAllResponse(BaseModel):
    results: list[ReparseResult]


@router.post("/projects/{project_id}/reparse")
async def reparse_project(
    project_id: str,
    session: Annotated[AsyncSession, Depends(get_db_session)],
    blob_downloader: Annotated[BlobDownloader, Depends(get_blob_downloader)],
) -> ReparseAllResponse:
    """Re-runs the parse pipeline for every parseable (file-backed) Source in the
    project — one unified pass. Per-source failures are reported, not fatal to the
    rest of the batch."""
    result = await session.execute(
        select(Source).where(
            Source.projectId == project_id,
            Source.deletedAt.is_(None),
            Source.storageKey.is_not(None),
        )
    )
    sources = list(result.scalars())

    results: list[ReparseResult] = []
    for source in sources:
        if source.kind not in _PARSERS:
            continue
        try:
            chunk_count = await _parse_one(source, session, blob_downloader)
            results.append(
                ReparseResult(
                    source_id=source.id,
                    name=source.name,
                    status=SourceStatus.PARSED.value,
                    chunk_count=chunk_count,
                )
            )
        except HTTPException as exc:
            results.append(
                ReparseResult(
                    source_id=source.id,
                    name=source.name,
                    status=SourceStatus.FAILED.value,
                    chunk_count=0,
                    error=str(exc.detail),
                )
            )
    return ReparseAllResponse(results=results)


class SourceSummary(BaseModel):
    source_id: str
    name: str
    kind: str
    status: str
    fragment_count: int
    parse_error: str | None
    updated_at: datetime


class IngestionSummaryResponse(BaseModel):
    source_count: int
    by_status: dict[str, int]
    fragment_count: int
    sources: list[SourceSummary]
    last_updated: datetime | None


@router.get("/projects/{project_id}/ingestion-summary")
async def ingestion_summary(
    project_id: str,
    session: Annotated[AsyncSession, Depends(get_db_session)],
) -> IngestionSummaryResponse:
    """Ingestion stats for a project (Issue #17) — the numbers the source management
    UI (Issue #18) renders come from this same query path."""
    result = await session.execute(
        select(Source, func.count(RawRequirement.id))
        .outerjoin(
            RawRequirement,
            (RawRequirement.sourceId == Source.id) & RawRequirement.deletedAt.is_(None),
        )
        .where(Source.projectId == project_id, Source.deletedAt.is_(None))
        .group_by(Source.id)
        .order_by(Source.createdAt.desc())
    )
    rows = result.all()

    by_status: dict[str, int] = {}
    summaries: list[SourceSummary] = []
    fragment_total = 0
    last_updated: datetime | None = None

    for source, fragment_count in rows:
        status = source.status.value if hasattr(source.status, "value") else str(source.status)
        by_status[status] = by_status.get(status, 0) + 1
        fragment_total += fragment_count
        if last_updated is None or source.updatedAt > last_updated:
            last_updated = source.updatedAt
        summaries.append(
            SourceSummary(
                source_id=source.id,
                name=source.name,
                kind=source.kind.value if hasattr(source.kind, "value") else str(source.kind),
                status=status,
                fragment_count=fragment_count,
                parse_error=source.parseError,
                updated_at=source.updatedAt,
            )
        )

    return IngestionSummaryResponse(
        source_count=len(rows),
        by_status=by_status,
        fragment_count=fragment_total,
        sources=summaries,
        last_updated=last_updated,
    )
