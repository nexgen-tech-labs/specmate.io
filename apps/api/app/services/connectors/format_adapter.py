"""Ticket format mode (Issues 6.3/6.4, 7.3/7.4): how a DraftItem's content is
rendered before it's sent to a publish target. Two real modes — Human (prose) and
Coding Agent (structured, testable, machine-checkable) — selected per PublishMapping.

"Both" mode (dual issue/work-item creation) is explicitly deferred: it doubles
write-back bookkeeping (two PublishedItem rows + cross-linking) for a mode with no
validated demand yet. FormatMode still declares the value so the schema and UI don't
need a follow-up migration once it's built — publish_to_ado/github simply reject it
with a clear "not yet supported" error rather than silently downgrading to Human.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from app.models import DraftItem


class FormatMode(str, Enum):
    HUMAN = "HUMAN"
    CODING_AGENT = "CODING_AGENT"
    BOTH = "BOTH"  # accepted by the schema; publish rejects it today, see module docstring


@dataclass(frozen=True)
class FormattedContent:
    title: str
    body_markdown: str
    acceptance_criteria: list[str]  # checklist lines, empty if none


def _payload_lines(payload: dict[str, object] | None) -> list[str]:
    if not payload:
        return []
    return [f"**{key.replace('_', ' ').title()}:** {value}" for key, value in payload.items() if value]


def _extract_ac(item: DraftItem) -> list[str]:
    """Pulls acceptance-criteria-shaped text out of an item for the checklist
    representation — from its own payload.statement if it's an AC item itself, or
    from a payload.acceptance_criteria list if generation attached one."""
    payload = item.payload or {}
    if item.type.value == "ACCEPTANCE_CRITERIA" and payload.get("statement"):
        return [str(payload["statement"])]
    ac = payload.get("acceptance_criteria")
    if isinstance(ac, list):
        return [str(a) for a in ac]
    return []


def format_human(item: DraftItem) -> FormattedContent:
    """Prose description + readable extra fields — what Jira publishing already
    produces, now named as the Human mode baseline."""
    lines = [item.description, *_payload_lines(item.payload)]
    return FormattedContent(
        title=item.title,
        body_markdown="\n\n".join(line for line in lines if line),
        acceptance_criteria=_extract_ac(item),
    )


def format_coding_agent(item: DraftItem, file_references: list[str] | None = None) -> FormattedContent:
    """Structured body: explicit scope, testable AC as a checklist, file/module
    references when available (best-effort — repo file discovery is Issue 7.2's
    job; when no references are supplied this section says so rather than
    fabricating paths), and an explicit machine-checkable definition of done."""
    ac = _extract_ac(item)
    sections = [f"## Scope\n{item.description}"]

    extra = _payload_lines(item.payload)
    if extra:
        sections.append("## Details\n" + "\n".join(extra))

    if ac:
        checklist = "\n".join(f"- [ ] {line}" for line in ac)
        sections.append(f"## Acceptance Criteria\n{checklist}")
    else:
        sections.append(
            "## Acceptance Criteria\n(No structured acceptance criteria were generated for "
            "this item — verify scope manually before treating as done.)"
        )

    if file_references:
        refs = "\n".join(f"- `{ref}`" for ref in file_references)
        sections.append(f"## Referenced files/modules\n{refs}")
    else:
        sections.append(
            "## Referenced files/modules\n(No file/module references available — repo "
            "structure discovery did not resolve any for this item.)"
        )

    sections.append(
        "## Definition of Done\n"
        "- [ ] All acceptance criteria above are satisfied\n"
        "- [ ] Changes are covered by tests where applicable\n"
        "- [ ] No regressions in existing functionality"
    )

    return FormattedContent(
        title=item.title,
        body_markdown="\n\n".join(sections),
        acceptance_criteria=ac,
    )


def format_item(
    item: DraftItem, mode: FormatMode, file_references: list[str] | None = None
) -> FormattedContent:
    if mode == FormatMode.CODING_AGENT:
        return format_coding_agent(item, file_references)
    if mode == FormatMode.HUMAN:
        return format_human(item)
    raise ValueError(f"format_item does not support mode {mode!r} directly — see FormatMode.BOTH docs.")
