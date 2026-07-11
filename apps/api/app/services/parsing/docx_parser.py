"""Parses an uploaded .docx file into ordered text chunks tagged with a location
pointer (heading/section hierarchy, since .docx has no fixed page numbers).

Walks the document body in true document order (docx.oxml stores paragraphs and
tables as sibling elements) so tables are emitted in their actual position rather
than appended after all paragraphs.
"""

from __future__ import annotations

import io
import zipfile

import docx
from docx.opc.exceptions import PackageNotFoundError
from docx.table import Table
from docx.text.paragraph import Paragraph

from app.services.parsing.types import ParsedChunk

_HEADING_STYLE_PREFIX = "Heading "


class DocxParseError(Exception):
    """Raised when a .docx file can't be parsed — corrupt file, wrong format, etc."""


def _heading_level(paragraph: Paragraph) -> int | None:
    """Returns a 1-indexed nesting level for heading-style paragraphs (Title counts
    as level 1, the same rank as Heading 1), or None for body text."""
    style_name = paragraph.style.name if paragraph.style else ""
    if style_name == "Title":
        return 1
    if style_name.startswith(_HEADING_STYLE_PREFIX):
        suffix = style_name[len(_HEADING_STYLE_PREFIX) :].strip()
        if suffix.isdigit():
            return int(suffix)
    return None


def _table_to_text(table: Table) -> str:
    rows = [" | ".join(cell.text.strip() for cell in row.cells) for row in table.rows]
    return "\n".join(rows)


def _section_path(heading_stack: list[str], fallback_index: int) -> str:
    if heading_stack:
        return "/".join(heading_stack)
    return f"p.{fallback_index}"


def _extract_header_footer_chunks(document: docx.document.Document) -> list[ParsedChunk]:
    chunks: list[ParsedChunk] = []
    order = 0
    for section in document.sections:
        for label, part in (("header", section.header), ("footer", section.footer)):
            text = "\n".join(p.text.strip() for p in part.paragraphs if p.text.strip())
            if text:
                chunks.append(ParsedChunk(text=text, section_path=f"#{label}", order=order))
                order += 1
    return chunks


def parse_docx(file_bytes: bytes) -> list[ParsedChunk]:
    try:
        document = docx.Document(io.BytesIO(file_bytes))
    except (PackageNotFoundError, KeyError, ValueError, zipfile.BadZipFile) as exc:
        raise DocxParseError(
            f"Could not parse .docx file — it may be corrupt or not a valid Word document: {exc}"
        ) from exc

    chunks: list[ParsedChunk] = []
    heading_stack: list[str] = []
    order = 0
    fallback_index = 0

    for child in document.element.body.iterchildren():
        tag = child.tag.rsplit("}", 1)[-1]

        if tag == "p":
            paragraph = Paragraph(child, document)
            text = paragraph.text.strip()
            if not text:
                continue

            level = _heading_level(paragraph)
            if level is not None:
                # Truncate the stack to just above this level, then push the new
                # heading in its place — e.g. a new "Heading 1" (level=1) replaces
                # the previous level-1 entry at index 0 (and drops any "Heading
                # 2"/"Heading 3" children below it) rather than nesting under it.
                heading_stack = heading_stack[: level - 1]
                heading_stack.append(text)
                fallback_index += 1
                continue

            fallback_index += 1
            chunks.append(
                ParsedChunk(
                    text=text,
                    section_path=_section_path(heading_stack, fallback_index),
                    order=order,
                )
            )
            order += 1

        elif tag == "tbl":
            table = Table(child, document)
            text = _table_to_text(table)
            if not text.strip():
                continue

            fallback_index += 1
            chunks.append(
                ParsedChunk(
                    text=text,
                    section_path=_section_path(heading_stack, fallback_index),
                    order=order,
                )
            )
            order += 1

    for header_footer_chunk in _extract_header_footer_chunks(document):
        chunks.append(
            ParsedChunk(
                text=header_footer_chunk.text,
                section_path=header_footer_chunk.section_path,
                order=order,
            )
        )
        order += 1

    if not chunks:
        raise DocxParseError("Document contains no extractable text, tables, headers, or footers.")

    return chunks
