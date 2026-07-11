"""Unit tests for the pure (no-network) parts of the connectors: Confluence HTML
section extraction, Slack message filtering/chunking, Jira ADF flattening, ADO HTML
stripping, and GitHub issue normalization."""

import pytest

from app.services.connectors.ado import _strip_html, _work_item_to_reference_item
from app.services.connectors.confluence import extract_confluence_chunks
from app.services.connectors.github import _issue_to_reference_item as github_issue_to_item
from app.services.connectors.jira import _adf_to_text
from app.services.connectors.slack import filter_and_chunk_messages
from app.services.connectors.types import ConnectorError


def test_confluence_chunks_carry_page_title_and_section_heading_pointers() -> None:
    html = (
        "<h1>Overview</h1><p>Intro text.</p>"
        "<h2>Scope</h2><p>Scope text.</p><ul><li>First item</li></ul>"
        "<h1>Requirements</h1><p>Req text.</p>"
    )
    chunks = extract_confluence_chunks("Payments Spec", html)

    assert [c.section_path for c in chunks] == [
        "Payments Spec/Overview",
        "Payments Spec/Overview/Scope",
        "Payments Spec/Overview/Scope",
        "Payments Spec/Requirements",
    ]
    assert chunks[0].text == "Intro text."
    assert chunks[2].text == "First item"


def test_confluence_content_above_any_heading_uses_page_title_pointer() -> None:
    chunks = extract_confluence_chunks("My Page", "<p>Preamble before headings.</p>")
    assert chunks[0].section_path == "My Page"


def test_confluence_empty_page_raises() -> None:
    with pytest.raises(ConnectorError):
        extract_confluence_chunks("Empty", "<p>   </p>")


def test_slack_chunks_tag_author_timestamp_and_channel() -> None:
    messages: list[dict[str, object]] = [
        {"user": "U123", "text": "We need saved-card payments.", "ts": "1751059200.000100"},
        {"user": "U456", "text": "And refunds within 30 days.", "ts": "1751059260.000200"},
    ]
    chunks = filter_and_chunk_messages(messages, "payments")

    assert chunks[0].text == "U123: We need saved-card payments."
    assert chunks[0].section_path.startswith("#payments@")
    assert [c.order for c in chunks] == [0, 1]


def test_slack_bot_system_and_empty_messages_are_filtered_out() -> None:
    messages: list[dict[str, object]] = [
        {"user": "U1", "text": "Real requirement.", "ts": "1751059200.0"},
        {"bot_id": "B99", "text": "I am a bot.", "ts": "1751059201.0"},
        {"user": "U2", "subtype": "channel_join", "text": "joined", "ts": "1751059202.0"},
        {"user": "U3", "text": "   ", "ts": "1751059203.0"},
    ]
    chunks = filter_and_chunk_messages(messages, "general")
    assert len(chunks) == 1
    assert chunks[0].text == "U1: Real requirement."


def test_slack_channel_with_only_noise_raises() -> None:
    with pytest.raises(ConnectorError):
        filter_and_chunk_messages([{"bot_id": "B1", "text": "bot", "ts": "1.0"}], "general")


def test_jira_adf_description_flattens_to_plain_text() -> None:
    adf = {
        "type": "doc",
        "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": "First line."}]},
            {"type": "paragraph", "content": [{"type": "text", "text": "Second line."}]},
        ],
    }
    assert _adf_to_text(adf).strip() == "First line.\nSecond line."


def test_ado_html_description_is_stripped() -> None:
    stripped = _strip_html("<div>Needs <b>refunds</b>&nbsp;support</div>")
    assert "refunds" in stripped
    assert "<" not in stripped and ">" not in stripped
    assert "&nbsp;" not in stripped


def test_ado_work_item_normalizes_fields() -> None:
    item = _work_item_to_reference_item(
        {
            "id": 42,
            "url": "https://dev.azure.com/org/_apis/wit/workItems/42",
            "fields": {
                "System.Title": "Add refunds",
                "System.Description": "<p>Refund flow</p>",
                "System.WorkItemType": "User Story",
                "System.State": "Active",
            },
        }
    )
    assert item.external_key == "42"
    assert item.title == "Add refunds"
    assert item.description == "Refund flow"
    assert item.item_type == "User Story"
    assert item.state == "Active"


def test_github_issue_normalizes_fields_with_labels_as_item_type() -> None:
    item = github_issue_to_item(
        {
            "number": 7,
            "title": "Support bank transfer",
            "body": "Needed for EU customers.",
            "state": "open",
            "labels": [{"name": "feature"}, {"name": "payments"}],
            "html_url": "https://github.com/acme/app/issues/7",
        }
    )
    assert item.external_key == "7"
    assert item.item_type == "feature, payments"
    assert item.url == "https://github.com/acme/app/issues/7"
