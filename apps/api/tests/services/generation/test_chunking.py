"""Chunking/summarization pre-pass unit tests — pure functions, no DB/AI calls
needed (pipeline.py's integration with these is covered in
tests/routers/test_generation.py's summarization-trigger tests)."""

from __future__ import annotations

from datetime import UTC, datetime

from app.models import RawRequirement
from app.services.generation.chunking import (
    FRAGMENTS_BLOCK_CHAR_BUDGET,
    digest_block,
    group_fragments_for_summarization,
    needs_summarization,
)


def _fragment(text: str, order: int = 0, source_id: str = "src-1") -> RawRequirement:
    now = datetime.now(UTC).replace(tzinfo=None)
    return RawRequirement(
        id=f"frag-{source_id}-{order}",
        sourceId=source_id,
        text=text,
        sectionPath=f"p.{order}",
        order=order,
        createdAt=now,
        updatedAt=now,
    )


def test_needs_summarization_below_budget_is_false() -> None:
    assert needs_summarization("x" * (FRAGMENTS_BLOCK_CHAR_BUDGET - 1)) is False


def test_needs_summarization_at_budget_is_false() -> None:
    # Strictly-greater-than semantics: exactly at the budget doesn't trigger.
    assert needs_summarization("x" * FRAGMENTS_BLOCK_CHAR_BUDGET) is False


def test_needs_summarization_above_budget_is_true() -> None:
    assert needs_summarization("x" * (FRAGMENTS_BLOCK_CHAR_BUDGET + 1)) is True


def test_needs_summarization_empty_block_is_false() -> None:
    assert needs_summarization("") is False


def test_group_fragments_empty_list_returns_no_batches() -> None:
    assert group_fragments_for_summarization([]) == []


def test_group_fragments_never_splits_a_single_fragment() -> None:
    # One fragment alone exceeding the batch budget becomes its own one-item
    # batch rather than being split mid-text.
    huge = _fragment("y" * 20_000, order=0)
    batches = group_fragments_for_summarization([huge], batch_char_budget=15_000)
    assert len(batches) == 1
    assert batches[0] == [huge]


def test_group_fragments_bins_multiple_small_fragments_together() -> None:
    fragments = [_fragment("a" * 100, order=i) for i in range(5)]
    batches = group_fragments_for_summarization(fragments, batch_char_budget=1_000)
    assert len(batches) == 1
    assert batches[0] == fragments


def test_group_fragments_starts_a_new_batch_once_budget_exceeded() -> None:
    fragments = [_fragment("a" * 600, order=i) for i in range(3)]
    batches = group_fragments_for_summarization(fragments, batch_char_budget=1_000)
    # Each fragment is 600 chars; 600+600 > 1000, so every fragment after the
    # first starts a fresh batch — three fragments, three one-item batches.
    assert batches == [[fragments[0]], [fragments[1]], [fragments[2]]]


def test_group_fragments_two_fragments_fit_together_when_under_budget() -> None:
    fragments = [_fragment("a" * 400, order=i) for i in range(3)]
    batches = group_fragments_for_summarization(fragments, batch_char_budget=1_000)
    # 400+400+400 = 1200 > 1000, so the third fragment starts a new batch;
    # the first two (800 <= 1000) share one batch.
    assert batches == [[fragments[0], fragments[1]], [fragments[2]]]


def test_group_fragments_preserves_input_order_across_batches() -> None:
    fragments = [_fragment("a" * 100, order=i) for i in range(10)]
    batches = group_fragments_for_summarization(fragments, batch_char_budget=250)
    flattened = [f for batch in batches for f in batch]
    assert flattened == fragments


def test_digest_block_groups_multiple_ids_per_line() -> None:
    block = digest_block(
        [
            {"text": "Users can save addresses.", "source_chunk_ids": ["a", "b"]},
            {"text": "Admins see order volume.", "source_chunk_ids": ["c"]},
        ]
    )
    assert block == (
        "[a,b] Users can save addresses.\n"
        "[c] Admins see order volume."
    )


def test_digest_block_drops_digests_with_no_ids_or_no_text() -> None:
    block = digest_block(
        [
            {"text": "Valid digest.", "source_chunk_ids": ["a"]},
            {"text": "", "source_chunk_ids": ["b"]},  # no text -> dropped
            {"text": "No ids left after filtering.", "source_chunk_ids": []},  # empty ids -> dropped
        ]
    )
    assert block == "[a] Valid digest."


def test_digest_block_empty_input_returns_empty_string() -> None:
    assert digest_block([]) == ""
