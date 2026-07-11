"""Parses plain text files and meeting transcripts into text chunks.

Two modes, auto-detected:
- Transcript mode: when enough lines begin with a timestamp (formats like
  "[00:31:12]", "(31:12)", "00:31:12 —", "00:31:12:"), chunks are the text between
  timestamps and each chunk's location pointer is its nearest preceding timestamp.
- Paragraph mode (fallback): chunks are blank-line-separated paragraphs with "p.N"
  pointers, matching the docx parser's no-heading fallback convention.

Both modes chunk on logical boundaries (timestamp or paragraph break), never on
character counts, so sentences are never split mid-way.
"""

from __future__ import annotations

import re

from app.services.parsing.types import ParsedChunk

# Matches a leading timestamp like "[00:31:12]", "(31:12)", "00:31:12", "1:02:33",
# optionally followed by separator punctuation ("—", "-", ":") before the content.
_TIMESTAMP_RE = re.compile(
    r"^\s*[\[\(]?(?P<ts>(?:\d{1,2}:)?\d{1,2}:\d{2})[\]\)]?\s*(?:[—\-:]\s*)?"
)

# Minimum share of non-blank lines that must carry a timestamp for the file to be
# treated as a transcript rather than prose that merely mentions a time once.
_TRANSCRIPT_LINE_THRESHOLD = 0.25
_TRANSCRIPT_MIN_MATCHES = 3


class TextParseError(Exception):
    """Raised when a text file can't be parsed — undecodable bytes or no content."""


def _decode(file_bytes: bytes) -> str:
    try:
        return file_bytes.decode("utf-8-sig")
    except UnicodeDecodeError:
        return file_bytes.decode("latin-1")


def _parse_transcript(lines: list[str]) -> list[ParsedChunk]:
    chunks: list[ParsedChunk] = []
    current_ts: str | None = None
    current_parts: list[str] = []
    order = 0

    def flush() -> None:
        nonlocal order
        text = "\n".join(current_parts).strip()
        if text:
            chunks.append(
                ParsedChunk(
                    text=text,
                    section_path=current_ts if current_ts else "p.1",
                    order=order,
                )
            )
            order += 1

    for line in lines:
        match = _TIMESTAMP_RE.match(line)
        if match:
            flush()
            current_parts = []
            current_ts = match.group("ts")
            remainder = line[match.end() :].strip()
            if remainder:
                current_parts.append(remainder)
        else:
            if line.strip():
                current_parts.append(line.strip())
    flush()
    return chunks


def _parse_paragraphs(text: str) -> list[ParsedChunk]:
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text)]
    chunks: list[ParsedChunk] = []
    order = 0
    for i, paragraph in enumerate(paragraphs, start=1):
        if not paragraph:
            continue
        chunks.append(ParsedChunk(text=paragraph, section_path=f"p.{i}", order=order))
        order += 1
    return chunks


def parse_text(file_bytes: bytes) -> list[ParsedChunk]:
    text = _decode(file_bytes)

    lines = text.splitlines()
    non_blank = [line for line in lines if line.strip()]
    if not non_blank:
        raise TextParseError("File contains no extractable text.")

    timestamped = sum(1 for line in non_blank if _TIMESTAMP_RE.match(line))
    is_transcript = (
        timestamped >= _TRANSCRIPT_MIN_MATCHES
        and timestamped / len(non_blank) >= _TRANSCRIPT_LINE_THRESHOLD
    )

    chunks = _parse_transcript(lines) if is_transcript else _parse_paragraphs(text)

    if not chunks:
        raise TextParseError("File contains no extractable text.")
    return chunks
