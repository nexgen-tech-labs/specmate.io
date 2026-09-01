"""Chunking/summarization pre-pass for large sources (Onboarding Flow redesign
follow-up): a big document pasted whole into the epics/stories/supporting
prompts risks the model missing content buried in the middle. Below a
conservative character budget, generation behaves byte-for-byte identically to
before this module existed — only genuinely large sources ever touch this
path. Above it, fragments are batched and summarized into dense digests that
still cite real RawRequirement ids, so TraceLink creation downstream needs no
changes at all."""

from __future__ import annotations

from typing import cast

from app.models import RawRequirement

# Conservative — small pasted text or a few-page doc should never trigger this.
FRAGMENTS_BLOCK_CHAR_BUDGET = 45_000

# Per-batch input budget for one summarization call — well under the overall
# budget above, so a handful of batches comfortably replace one oversized block.
_BATCH_CHAR_BUDGET = 15_000


def needs_summarization(block: str) -> bool:
    return len(block) > FRAGMENTS_BLOCK_CHAR_BUDGET


def group_fragments_for_summarization(
    fragments: list[RawRequirement], batch_char_budget: int = _BATCH_CHAR_BUDGET
) -> list[list[RawRequirement]]:
    """Greedily bins fragments (already ordered by sourceId, order) into batches
    up to `batch_char_budget` characters each — never splits a single fragment,
    even if it alone exceeds the budget (it becomes its own one-item batch)."""
    batches: list[list[RawRequirement]] = []
    current: list[RawRequirement] = []
    current_len = 0
    for fragment in fragments:
        flen = len(fragment.text)
        if current and current_len + flen > batch_char_budget:
            batches.append(current)
            current, current_len = [], 0
        current.append(fragment)
        current_len += flen
    if current:
        batches.append(current)
    return batches


def digest_block(digests: list[dict[str, object]]) -> str:
    """Renders summarization digests in the same bracketed-id shape
    _fragments_block uses, so downstream prompts and TraceLink creation don't
    need to distinguish a digest line from a raw fragment line — a digest just
    groups multiple real ids into one bracket instead of one id per line."""
    lines = []
    for d in digests:
        ids = cast("list[str] | None", d.get("source_chunk_ids"))
        text = d.get("text")
        if not ids or not text:
            continue
        lines.append(f"[{','.join(ids)}] {text}")
    return "\n".join(lines)
