"""Jira publishing (Issues 5.2, 5.4, 5.6, 5.7): discovery of what a Jira project
actually supports, and creating real issues from approved DraftItems with
hierarchy-aware ordering, retry/backoff, and per-item results."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field

import httpx

from app.services.connectors.jira_auth import JiraConnection
from app.services.connectors.transport import DirectCloudTransport
from app.services.connectors.types import ConnectorError, ConnectorTransport

_MAX_ATTEMPTS = 4
_BACKOFF_BASE_S = 1.5

_default_transport = DirectCloudTransport()


# ---------- Discovery (Issue 5.2) ----------


async def discover_projects(
    connection: JiraConnection, transport: ConnectorTransport = _default_transport
) -> list[dict[str, str]]:
    try:
        response = await transport.request(
            "GET",
            f"{connection.base_url()}/rest/api/{connection.api_version()}/project/search",
            auth=connection.auth(),
            timeout=30,
        )
        response.raise_for_status()
    except httpx.HTTPError as exc:
        raise ConnectorError(f"Jira project discovery failed: {exc}") from exc
    return [
        {"key": p["key"], "name": p["name"]} for p in response.json().get("values", [])
    ]


async def discover_project_meta(
    connection: JiraConnection,
    project_key: str,
    transport: ConnectorTransport = _default_transport,
) -> dict[str, object]:
    """Issue types + their fields (required flagged) for one project — the real
    configured set, not an assumed one. Cached by the caller in PublishMapping."""
    base = f"{connection.base_url()}/rest/api/{connection.api_version()}"
    issue_types: list[dict[str, object]] = []
    try:
        types_response = await transport.request(
            "GET", f"{base}/issue/createmeta/{project_key}/issuetypes", auth=connection.auth(), timeout=30
        )
        types_response.raise_for_status()
        for issue_type in types_response.json().get("issueTypes", []):
            fields_response = await transport.request(
                "GET",
                f"{base}/issue/createmeta/{project_key}/issuetypes/{issue_type['id']}",
                auth=connection.auth(),
                timeout=30,
            )
            fields_response.raise_for_status()
            fields = [
                {
                    "id": f["fieldId"],
                    "name": f["name"],
                    "required": f.get("required", False),
                    "has_default": f.get("hasDefaultValue", False),
                }
                for f in fields_response.json().get("fields", [])
            ]
            issue_types.append(
                {
                    "id": issue_type["id"],
                    "name": issue_type["name"],
                    "subtask": issue_type.get("subtask", False),
                    "fields": fields,
                }
            )
    except httpx.HTTPError as exc:
        raise ConnectorError(f"Jira metadata discovery failed for {project_key}: {exc}") from exc
    return {"project_key": project_key, "issue_types": issue_types}


# ---------- Publishing (Issues 5.4/5.6/5.7) ----------


@dataclass(frozen=True)
class PublishCandidate:
    item_id: str
    item_type: str  # SpecMate DraftItemType value
    title: str
    description: str
    parent_item_id: str | None
    extra_description: str = ""  # e.g. appended AC/payload text per default field mapping


@dataclass
class PublishOutcome:
    item_id: str
    ok: bool
    key: str | None = None
    url: str | None = None
    error: str | None = None
    attempts: int = 1
    blocked: bool = False  # parent not published — retriable after parent publishes


@dataclass
class _JiraIssuePayload:
    fields: dict[str, object] = field(default_factory=dict)


def _adf(text: str) -> dict[str, object]:
    paragraphs = [p for p in text.split("\n") if p.strip()] or [""]
    return {
        "type": "doc",
        "version": 1,
        "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": p}]} for p in paragraphs
        ],
    }


# SpecMate types with no near-universal Jira equivalent publish as the mapped
# fallback type with their nature prefixed in the summary.
HIERARCHY_ORDER = ["EPIC", "STORY", "TASK", "SUBTASK"]


def sort_for_hierarchy(candidates: list[PublishCandidate]) -> list[PublishCandidate]:
    """Parents before children (Issue 5.6): epics, then stories, then tasks, then
    subtasks, then everything else (supporting items)."""

    def rank(candidate: PublishCandidate) -> int:
        try:
            return HIERARCHY_ORDER.index(candidate.item_type)
        except ValueError:
            return len(HIERARCHY_ORDER)

    return sorted(candidates, key=rank)


def validate_required_fields(
    issue_type_name: str,
    metadata: dict[str, object] | None,
    field_defaults: dict[str, object],
) -> str | None:
    """Fail-fast check (Issue 5.4): every required field must be summary/description/
    parent (naturally populated), have a Jira-side default, or have a fixed default
    in the mapping. Returns a human-readable error or None."""
    if not metadata:
        return None  # no discovery snapshot — let Jira validate
    naturally_populated = {"summary", "description", "project", "issuetype", "parent", "reporter"}
    issue_types = metadata.get("issue_types")
    if not isinstance(issue_types, list):
        return None
    for issue_type in issue_types:
        if not isinstance(issue_type, dict) or issue_type.get("name") != issue_type_name:
            continue
        fields = issue_type.get("fields")
        missing = [
            str(f["name"])
            for f in (fields if isinstance(fields, list) else [])
            if isinstance(f, dict)
            and f.get("required")
            and not f.get("has_default")
            and f.get("id") not in naturally_populated
            and f.get("id") not in field_defaults
        ]
        if missing:
            return (
                f"Jira requires field(s) {missing} for issue type '{issue_type_name}' — "
                "set fixed defaults in the publish mapping."
            )
        return None
    return f"Issue type '{issue_type_name}' not found in the Jira project's configuration."


async def create_issue(
    connection: JiraConnection,
    project_key: str,
    issue_type_name: str,
    candidate: PublishCandidate,
    parent_key: str | None,
    field_defaults: dict[str, object],
    transport: ConnectorTransport = _default_transport,
) -> PublishOutcome:
    """Creates one issue with 429/5xx retry + backoff (Issue 5.7). 4xx validation
    errors are permanent and surfaced with Jira's own messages."""
    description = candidate.description
    if candidate.extra_description:
        description += f"\n{candidate.extra_description}"

    payload = _JiraIssuePayload()
    payload.fields = {
        "project": {"key": project_key},
        "issuetype": {"name": issue_type_name},
        "summary": candidate.title[:255],
        "description": _adf(description),
        **field_defaults,
    }
    if parent_key:
        # Modern Jira Cloud accepts `parent` uniformly (company- and team-managed);
        # Server/DC epic-link differences are documented in jira_auth.py (Issue 5.8).
        payload.fields["parent"] = {"key": parent_key}

    last_error = "unknown"
    for attempt in range(1, _MAX_ATTEMPTS + 1):
        try:
            response = await transport.request(
                "POST",
                f"{connection.base_url()}/rest/api/{connection.api_version()}/issue",
                auth=connection.auth(),
                json={"fields": payload.fields},
                timeout=30,
            )
        except httpx.HTTPError as exc:
            last_error = f"network error: {exc}"
            await asyncio.sleep(_BACKOFF_BASE_S * attempt)
            continue

        if response.status_code in (200, 201):
            body = response.json()
            return PublishOutcome(
                item_id=candidate.item_id,
                ok=True,
                key=body["key"],
                url=f"{connection.base_url()}/browse/{body['key']}",
                attempts=attempt,
            )
        if response.status_code == 429 or response.status_code >= 500:
            retry_after = response.headers.get("Retry-After")
            delay = float(retry_after) if retry_after else _BACKOFF_BASE_S * attempt
            last_error = f"HTTP {response.status_code} (transient)"
            await asyncio.sleep(delay)
            continue
        # Permanent 4xx: surface Jira's specific field errors immediately.
        try:
            errors = response.json()
            detail = errors.get("errors") or errors.get("errorMessages") or errors
        except ValueError:
            detail = response.text[:300]
        return PublishOutcome(
            item_id=candidate.item_id,
            ok=False,
            error=f"Jira rejected the issue ({response.status_code}): {detail}",
            attempts=attempt,
        )

    return PublishOutcome(
        item_id=candidate.item_id,
        ok=False,
        error=f"Gave up after {_MAX_ATTEMPTS} attempts — last error: {last_error}",
        attempts=_MAX_ATTEMPTS,
    )


async def update_issue(
    connection: JiraConnection,
    issue_key: str,
    candidate: PublishCandidate,
    field_defaults: dict[str, object],
    transport: ConnectorTransport = _default_transport,
) -> PublishOutcome:
    """Updates summary/description/field-defaults on an already-published issue
    (Issue 9.4) — never touches project/issuetype/parent, set once at creation."""
    description = candidate.description
    if candidate.extra_description:
        description += f"\n{candidate.extra_description}"

    fields: dict[str, object] = {
        "summary": candidate.title[:255],
        "description": _adf(description),
        **field_defaults,
    }

    last_error = "unknown"
    for attempt in range(1, _MAX_ATTEMPTS + 1):
        try:
            response = await transport.request(
                "PUT",
                f"{connection.base_url()}/rest/api/{connection.api_version()}/issue/{issue_key}",
                auth=connection.auth(),
                json={"fields": fields},
                timeout=30,
            )
        except httpx.HTTPError as exc:
            last_error = f"network error: {exc}"
            await asyncio.sleep(_BACKOFF_BASE_S * attempt)
            continue

        if response.status_code in (200, 204):
            return PublishOutcome(
                item_id=candidate.item_id,
                ok=True,
                key=issue_key,
                url=f"{connection.base_url()}/browse/{issue_key}",
                attempts=attempt,
            )
        if response.status_code == 429 or response.status_code >= 500:
            retry_after = response.headers.get("Retry-After")
            delay = float(retry_after) if retry_after else _BACKOFF_BASE_S * attempt
            last_error = f"HTTP {response.status_code} (transient)"
            await asyncio.sleep(delay)
            continue
        try:
            errors = response.json()
            detail = errors.get("errors") or errors.get("errorMessages") or errors
        except ValueError:
            detail = response.text[:300]
        return PublishOutcome(
            item_id=candidate.item_id,
            ok=False,
            error=f"Jira rejected the issue update ({response.status_code}): {detail}",
            attempts=attempt,
        )

    return PublishOutcome(
        item_id=candidate.item_id,
        ok=False,
        error=f"Gave up after {_MAX_ATTEMPTS} attempts — last error: {last_error}",
        attempts=_MAX_ATTEMPTS,
    )


async def add_comment(
    connection: JiraConnection,
    issue_key: str,
    comment_text: str,
    transport: ConnectorTransport = _default_transport,
) -> None:
    """Flags an issue for reviewer attention (Issue 9.4) when its source requirement
    was removed — a comment, never an auto-close, so a human decides what happens."""
    try:
        response = await transport.request(
            "POST",
            f"{connection.base_url()}/rest/api/{connection.api_version()}/issue/{issue_key}/comment",
            auth=connection.auth(),
            json={"body": _adf(comment_text)},
            timeout=30,
        )
        response.raise_for_status()
    except httpx.HTTPError as exc:
        raise ConnectorError(f"Failed to comment on {issue_key}: {exc}") from exc


def _adf_to_text(node: object) -> str:
    """Best-effort plain-text extraction from Jira's ADF description format — enough
    fidelity for drift comparison (Issue 9.5), not a full renderer."""
    if not isinstance(node, dict):
        return ""
    parts: list[str] = []
    if node.get("type") == "text":
        parts.append(str(node.get("text", "")))
    for child in node.get("content", []) if isinstance(node.get("content"), list) else []:
        parts.append(_adf_to_text(child))
    return " ".join(p for p in parts if p)


@dataclass(frozen=True)
class RemoteIssueState:
    key: str
    title: str
    description: str
    status: str


async def fetch_issue(
    connection: JiraConnection,
    issue_key: str,
    transport: ConnectorTransport = _default_transport,
) -> RemoteIssueState:
    """Reads current summary/description/status straight from Jira (Issue 9.5's
    drift check) — never cached, always the live remote state."""
    try:
        response = await transport.request(
            "GET",
            f"{connection.base_url()}/rest/api/{connection.api_version()}/issue/{issue_key}",
            auth=connection.auth(),
            params={"fields": "summary,description,status"},
            timeout=30,
        )
        response.raise_for_status()
    except httpx.HTTPError as exc:
        raise ConnectorError(f"Failed to fetch {issue_key}: {exc}") from exc
    fields = response.json().get("fields", {})
    return RemoteIssueState(
        key=issue_key,
        title=str(fields.get("summary", "")),
        description=_adf_to_text(fields.get("description")),
        status=str((fields.get("status") or {}).get("name", "")),
    )
