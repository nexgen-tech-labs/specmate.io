"""Fragment-level diffing between two versions of the same Source (Issue 9.1) —
the foundation targeted regeneration (Issue 9.2) scopes itself to.

Matching strategy: fragments are paired by sectionPath first (docx heading path /
PDF page / row index survive most edits), then by normalized-text equality within
unmatched fragments (catches moved/renumbered sections with identical content).
Anything left unmatched on the new side is "added"; left unmatched on the old side
is "removed"; a sectionPath match with differing normalized text is "modified"."""

from __future__ import annotations

import re
from dataclasses import dataclass

from app.models import RawRequirement

_WS_RE = re.compile(r"\s+")


def _normalize(text: str) -> str:
    return _WS_RE.sub(" ", text).casefold().strip()


@dataclass(frozen=True)
class FragmentChange:
    change_type: str  # added | removed | modified | unchanged
    section_path: str
    raw_requirement_id: str | None  # new-version RawRequirement.id (None if removed)
    previous_raw_requirement_id: str | None  # previous-version RawRequirement.id (None if added)


@dataclass(frozen=True)
class SourceDiffResult:
    added: list[FragmentChange]
    removed: list[FragmentChange]
    modified: list[FragmentChange]
    unchanged: list[FragmentChange]

    @property
    def all_changes(self) -> list[FragmentChange]:
        return [*self.added, *self.removed, *self.modified, *self.unchanged]


def diff_fragments(
    previous: list[RawRequirement], current: list[RawRequirement]
) -> SourceDiffResult:
    prev_by_path: dict[str, list[RawRequirement]] = {}
    for f in previous:
        prev_by_path.setdefault(f.sectionPath, []).append(f)

    matched_prev_ids: set[str] = set()
    added: list[FragmentChange] = []
    modified: list[FragmentChange] = []
    unchanged: list[FragmentChange] = []

    unmatched_current: list[RawRequirement] = []
    for f in current:
        candidates = prev_by_path.get(f.sectionPath, [])
        candidate = next((c for c in candidates if c.id not in matched_prev_ids), None)
        if candidate is None:
            unmatched_current.append(f)
            continue
        matched_prev_ids.add(candidate.id)
        if _normalize(candidate.text) == _normalize(f.text):
            unchanged.append(
                FragmentChange("unchanged", f.sectionPath, f.id, candidate.id)
            )
        else:
            modified.append(
                FragmentChange("modified", f.sectionPath, f.id, candidate.id)
            )

    # Second pass: try to match remaining current fragments to remaining previous
    # fragments by normalized text (moved/renumbered sections with identical content).
    prev_by_text: dict[str, list[RawRequirement]] = {}
    for f in previous:
        if f.id not in matched_prev_ids:
            prev_by_text.setdefault(_normalize(f.text), []).append(f)

    still_unmatched: list[RawRequirement] = []
    for f in unmatched_current:
        candidates = prev_by_text.get(_normalize(f.text), [])
        candidate = next((c for c in candidates if c.id not in matched_prev_ids), None)
        if candidate is None:
            still_unmatched.append(f)
            continue
        matched_prev_ids.add(candidate.id)
        unchanged.append(FragmentChange("unchanged", f.sectionPath, f.id, candidate.id))

    added = [
        FragmentChange("added", f.sectionPath, f.id, None) for f in still_unmatched
    ]
    removed = [
        FragmentChange("removed", f.sectionPath, None, f.id)
        for f in previous
        if f.id not in matched_prev_ids
    ]

    return SourceDiffResult(added=added, removed=removed, modified=modified, unchanged=unchanged)
