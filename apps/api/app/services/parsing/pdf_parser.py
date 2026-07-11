"""Parses an uploaded PDF into text chunks tagged with a page-number location
pointer — PDF's natural structural unit is the page (no heading hierarchy to
recover the way docx has), so extraction is one chunk per page.

Scanned/image-only PDFs have no extractable text layer at all; this is detected
and raised as a clear, typed error rather than silently returning an empty result
(OCR is out of scope for v1 — see architecture.md)."""

from __future__ import annotations

import io

from pypdf import PdfReader
from pypdf.errors import PdfReadError

from app.services.parsing.types import ParsedChunk


class PdfParseError(Exception):
    """Raised when a PDF can't be parsed — corrupt/unreadable file, or a
    scanned/image-only PDF with no extractable text on any page."""


def parse_pdf(file_bytes: bytes) -> list[ParsedChunk]:
    try:
        reader = PdfReader(io.BytesIO(file_bytes))
        page_count = len(reader.pages)
    except (PdfReadError, ValueError, KeyError) as exc:
        raise PdfParseError(
            f"Could not parse PDF — it may be corrupt or not a valid PDF file: {exc}"
        ) from exc

    chunks: list[ParsedChunk] = []
    order = 0
    for page_num, page in enumerate(reader.pages, start=1):
        text = (page.extract_text() or "").strip()
        if not text:
            continue
        chunks.append(ParsedChunk(text=text, section_path=f"p.{page_num}", order=order))
        order += 1

    if not chunks:
        raise PdfParseError(
            f"This PDF appears to be scanned/image-only (no extractable text found across "
            f"{page_count} page(s)) — text extraction unavailable, OCR not yet supported."
        )

    return chunks
