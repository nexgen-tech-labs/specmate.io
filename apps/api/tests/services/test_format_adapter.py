import pytest

from app.services.connectors.format_adapter import (
    FormatMode,
    format_coding_agent,
    format_human,
    format_item,
)

from app.models import DraftItem, DraftItemType


def _item(**overrides: object) -> DraftItem:
    defaults: dict[str, object] = {
        "id": "item1",
        "projectId": "p1",
        "type": DraftItemType.STORY,
        "title": "As a customer, I can pay an invoice",
        "description": "Saved-card payment flow.",
        "payload": None,
    }
    defaults.update(overrides)
    return DraftItem(**defaults)  # type: ignore[arg-type]


def test_human_mode_produces_prose_description() -> None:
    content = format_human(_item())
    assert content.title == "As a customer, I can pay an invoice"
    assert content.body_markdown == "Saved-card payment flow."
    assert content.acceptance_criteria == []


def test_human_mode_appends_payload_fields_as_readable_lines() -> None:
    content = format_human(_item(type=DraftItemType.RISK, payload={"severity": "high"}))
    assert "**Severity:** high" in content.body_markdown


def test_coding_agent_mode_has_structured_sections() -> None:
    content = format_coding_agent(_item())
    assert "## Scope" in content.body_markdown
    assert "## Acceptance Criteria" in content.body_markdown
    assert "## Definition of Done" in content.body_markdown
    assert "- [ ] All acceptance criteria above are satisfied" in content.body_markdown


def test_coding_agent_mode_renders_ac_as_checklist_items() -> None:
    item = _item(
        type=DraftItemType.ACCEPTANCE_CRITERIA,
        payload={"statement": "Given a saved card, payment succeeds."},
    )
    content = format_coding_agent(item)
    assert content.acceptance_criteria == ["Given a saved card, payment succeeds."]
    assert "- [ ] Given a saved card, payment succeeds." in content.body_markdown


def test_coding_agent_mode_without_ac_says_so_rather_than_fabricating() -> None:
    content = format_coding_agent(_item())
    assert "No structured acceptance criteria were generated" in content.body_markdown


def test_coding_agent_mode_includes_file_references_when_provided() -> None:
    content = format_coding_agent(_item(), file_references=["apps/web/src/lib/payments.ts"])
    assert "`apps/web/src/lib/payments.ts`" in content.body_markdown


def test_coding_agent_mode_without_file_references_says_so_not_fabricated() -> None:
    content = format_coding_agent(_item())
    assert "No file/module references available" in content.body_markdown
    assert "apps/" not in content.body_markdown  # never invents a path


def test_format_item_dispatches_by_mode() -> None:
    item = _item()
    assert format_item(item, FormatMode.HUMAN).body_markdown == format_human(item).body_markdown
    assert format_item(item, FormatMode.CODING_AGENT).body_markdown == format_coding_agent(item).body_markdown


def test_format_item_rejects_both_mode_directly() -> None:
    with pytest.raises(ValueError, match="BOTH"):
        format_item(_item(), FormatMode.BOTH)
