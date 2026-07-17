"""Unit tests for the fragment-level diff engine (Issue 9.1)."""

from __future__ import annotations

from datetime import UTC, datetime

from app.models import RawRequirement
from app.services.parsing.source_diff import diff_fragments


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _frag(id_: str, section_path: str, text: str, order: int = 0) -> RawRequirement:
    return RawRequirement(
        id=id_,
        sourceId="irrelevant",
        text=text,
        sectionPath=section_path,
        order=order,
        createdAt=_now(),
        updatedAt=_now(),
    )


def test_identical_fragments_are_all_unchanged() -> None:
    previous = [_frag("p1", "1. Overview", "Some text.")]
    current = [_frag("c1", "1. Overview", "Some text.")]

    result = diff_fragments(previous, current)

    assert len(result.unchanged) == 1
    assert result.unchanged[0].raw_requirement_id == "c1"
    assert result.unchanged[0].previous_raw_requirement_id == "p1"
    assert not result.added
    assert not result.removed
    assert not result.modified


def test_new_fragment_at_same_path_is_modified() -> None:
    previous = [_frag("p1", "1. Overview", "Old text.")]
    current = [_frag("c1", "1. Overview", "New text.")]

    result = diff_fragments(previous, current)

    assert len(result.modified) == 1
    assert result.modified[0].raw_requirement_id == "c1"
    assert result.modified[0].previous_raw_requirement_id == "p1"


def test_whitespace_and_case_only_changes_count_as_unchanged() -> None:
    previous = [_frag("p1", "1. Overview", "Some   Text.")]
    current = [_frag("c1", "1. Overview", "some text.")]

    result = diff_fragments(previous, current)

    assert len(result.unchanged) == 1
    assert not result.modified


def test_fragment_only_in_current_is_added() -> None:
    previous: list[RawRequirement] = []
    current = [_frag("c1", "2. New Section", "Brand new requirement.")]

    result = diff_fragments(previous, current)

    assert len(result.added) == 1
    assert result.added[0].raw_requirement_id == "c1"
    assert result.added[0].previous_raw_requirement_id is None


def test_fragment_only_in_previous_is_removed() -> None:
    previous = [_frag("p1", "3. Old Section", "Deleted requirement.")]
    current: list[RawRequirement] = []

    result = diff_fragments(previous, current)

    assert len(result.removed) == 1
    assert result.removed[0].previous_raw_requirement_id == "p1"
    assert result.removed[0].raw_requirement_id is None


def test_moved_but_identical_text_matches_by_content_not_path() -> None:
    previous = [_frag("p1", "1. Overview", "Reused paragraph.")]
    current = [_frag("c1", "2. Renamed Section", "Reused paragraph.")]

    result = diff_fragments(previous, current)

    assert len(result.unchanged) == 1
    assert result.unchanged[0].raw_requirement_id == "c1"
    assert result.unchanged[0].previous_raw_requirement_id == "p1"
    assert not result.added
    assert not result.removed


def test_mixed_diff_counts_each_category_independently() -> None:
    previous = [
        _frag("p1", "1. Overview", "Unchanged text.", 0),
        _frag("p2", "2. Scope", "Old scope text.", 1),
        _frag("p3", "3. Deprecated", "Will be removed.", 2),
    ]
    current = [
        _frag("c1", "1. Overview", "Unchanged text.", 0),
        _frag("c2", "2. Scope", "New scope text.", 1),
        _frag("c3", "4. New Section", "Freshly added.", 2),
    ]

    result = diff_fragments(previous, current)

    assert len(result.unchanged) == 1
    assert len(result.modified) == 1
    assert len(result.added) == 1
    assert len(result.removed) == 1

    all_types = {c.change_type for c in result.all_changes}
    assert all_types == {"unchanged", "modified", "added", "removed"}
