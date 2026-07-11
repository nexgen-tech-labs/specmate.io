"""Jira Cloud backlog connector (Issue #14) — read-only pull of a project's issues
as ReferenceItems. Auth: Atlassian email + API token (shared with the Confluence
connector; the same credentials also serve Epic 5's publishing connector later).
No OAuth/per-workspace connection store yet — see architecture.md."""

from __future__ import annotations

import httpx

from app.core.config import settings
from app.services.connectors.types import ConnectorError, ReferenceItemData

_PAGE_SIZE = 100


def _adf_to_text(node: object) -> str:
    """Flattens Jira's Atlassian Document Format (v3 API descriptions) to plain text."""
    if node is None:
        return ""
    if isinstance(node, str):
        return node
    if isinstance(node, list):
        return "".join(_adf_to_text(child) for child in node)
    if isinstance(node, dict):
        if node.get("type") == "text":
            return str(node.get("text", ""))
        text = _adf_to_text(node.get("content", []))
        # Block-level nodes get a trailing newline so paragraphs don't run together.
        if node.get("type") in ("paragraph", "heading", "listItem", "codeBlock", "blockquote"):
            text += "\n"
        return text
    return ""


def _issue_to_reference_item(issue: dict[str, object]) -> ReferenceItemData:
    fields = issue.get("fields") or {}
    assert isinstance(fields, dict)
    issue_type = fields.get("issuetype") or {}
    status = fields.get("status") or {}
    key = str(issue.get("key", ""))
    return ReferenceItemData(
        external_key=key,
        title=str(fields.get("summary") or ""),
        description=_adf_to_text(fields.get("description")).strip(),
        item_type=str(issue_type.get("name", "") if isinstance(issue_type, dict) else ""),
        state=str(status.get("name", "") if isinstance(status, dict) else ""),
        url=f"{settings.jira_base_url}/browse/{key}" if settings.jira_base_url else None,
    )


async def fetch_jira_issues(project_key: str) -> list[ReferenceItemData]:
    if not (settings.jira_base_url and settings.atlassian_email and settings.atlassian_api_token):
        raise ConnectorError(
            "Jira connector is not configured — set JIRA_BASE_URL, ATLASSIAN_EMAIL, "
            "and ATLASSIAN_API_TOKEN."
        )

    items: list[ReferenceItemData] = []
    next_page_token: str | None = None
    auth = (settings.atlassian_email, settings.atlassian_api_token)

    async with httpx.AsyncClient(auth=auth, timeout=30) as client:
        while True:
            params: dict[str, str | int] = {
                "jql": f'project = "{project_key}" ORDER BY key ASC',
                "maxResults": _PAGE_SIZE,
                "fields": "summary,description,issuetype,status",
            }
            if next_page_token:
                params["nextPageToken"] = next_page_token
            try:
                response = await client.get(
                    f"{settings.jira_base_url}/rest/api/3/search/jql", params=params
                )
                response.raise_for_status()
            except httpx.HTTPError as exc:
                raise ConnectorError(f"Jira API request failed: {exc}") from exc

            payload = response.json()
            for issue in payload.get("issues", []):
                items.append(_issue_to_reference_item(issue))

            next_page_token = payload.get("nextPageToken")
            if not next_page_token or payload.get("isLast", True):
                break

    return items
