"""Duplicate detection against the existing backlog (Issue 3.5).

v1 uses pure-Python TF-cosine similarity over title+description — Anthropic has no
embeddings API, and adding a separate embedding provider is a new paid dependency
that needs an explicit decision (CLAUDE.md rule 4/6). This catches near-duplicates
(shared vocabulary) well; a real embedding index is the documented upgrade path if
semantic-paraphrase recall proves insufficient in practice."""

from __future__ import annotations

import math
import re
from collections import Counter
from dataclasses import dataclass

_TOKEN_RE = re.compile(r"[a-z0-9]+")
_STOPWORDS = frozenset(
    "a an and are as at be by can for from has have i in is it of on or that the this to "
    "user want we will with".split()
)


def _vector(text: str) -> Counter[str]:
    tokens = [t for t in _TOKEN_RE.findall(text.lower()) if t not in _STOPWORDS]
    return Counter(tokens)


def cosine_similarity(text_a: str, text_b: str) -> float:
    va, vb = _vector(text_a), _vector(text_b)
    if not va or not vb:
        return 0.0
    dot = sum(count * vb[token] for token, count in va.items())
    norm = math.sqrt(sum(c * c for c in va.values())) * math.sqrt(sum(c * c for c in vb.values()))
    return dot / norm if norm else 0.0


@dataclass(frozen=True)
class DuplicateMatch:
    external_key: str
    tool: str
    confidence: float


def find_best_duplicate(
    item_text: str,
    references: list[tuple[str, str, str]],  # (external_key, tool, text)
    threshold: float,
) -> DuplicateMatch | None:
    """Returns the highest-similarity reference at/above threshold, else None."""
    best: DuplicateMatch | None = None
    for external_key, tool, text in references:
        score = cosine_similarity(item_text, text)
        if score >= threshold and (best is None or score > best.confidence):
            best = DuplicateMatch(external_key=external_key, tool=tool, confidence=round(score, 3))
    return best
