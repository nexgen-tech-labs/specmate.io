"""Within-source dedup (Issue #17) — drops near-identical fragments (repeated
boilerplate like headers/footers/disclaimers) before they become RawRequirements.

"Near-identical" here means identical after normalization (casefold + whitespace
collapse). Cross-source semantic dedup is Issue 3.5's domain, not this."""

from __future__ import annotations

import re

from app.services.parsing.types import ParsedChunk

_WS_RE = re.compile(r"\s+")


def _normalize(text: str) -> str:
    return _WS_RE.sub(" ", text).casefold().strip()


def dedupe_chunks(chunks: list[ParsedChunk]) -> list[ParsedChunk]:
    """Keeps the first occurrence of each normalized text, re-numbering `order` so
    the persisted sequence stays contiguous."""
    seen: set[str] = set()
    deduped: list[ParsedChunk] = []
    for chunk in chunks:
        key = _normalize(chunk.text)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(
            ParsedChunk(text=chunk.text, section_path=chunk.section_path, order=len(deduped))
        )
    return deduped
