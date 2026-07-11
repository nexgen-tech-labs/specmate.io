"""Shared output type for every file-based parser (docx, PDF, ...) — one chunk of
extracted text tagged with a location pointer whose meaning is parser-specific
(docx: heading path, e.g. "1. Overview/1.1 Scope"; PDF: page number, e.g. "p.3")."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ParsedChunk:
    text: str
    section_path: str
    order: int
