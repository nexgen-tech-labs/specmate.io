"""Azure DevOps publishing (Issues 6.2, 6.4, 6.6, 6.7): discovery of a project's
real process-template configuration, and creating work items from approved
DraftItems with hierarchy-aware ordering (native parent-child link type), retry/
backoff, and per-item results. Mirrors jira_publish.py's shape."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass

import httpx

from app.services.connectors.ado_auth import AdoConnection
from app.services.connectors.format_adapter import FormatMode, FormattedContent, format_item
from app.services.connectors.transport import DirectCloudTransport
from app.services.connectors.types import ConnectorError, ConnectorTransport
from app.models import DraftItem

_MAX_ATTEMPTS = 4
_BACKOFF_BASE_S = 1.5
# ADO's native parent-child relation type (not a generic "related" link — Issue 6.6 AC).
_PARENT_RELATION = "System.LinkTypes.Hierarchy-Reverse"

_default_transport = DirectCloudTransport()


# ---------- Discovery (Issue 6.2) ----------


async def discover_projects(
    connection: AdoConnection, transport: ConnectorTransport = _default_transport
) -> list[dict[str, str]]:
    try:
        response = await transport.request(
            "GET",
            f"{connection.org_url()}/_apis/projects",
            auth=connection.auth(),
            params={"api-version": connection.api_version()},
            timeout=30,
        )
        response.raise_for_status()
    except httpx.HTTPError as exc:
        raise ConnectorError(f"ADO project discovery failed: {exc}") from exc
    return [{"id": p["id"], "name": p["name"]} for p in response.json().get("value", [])]


async def discover_project_meta(
    connection: AdoConnection,
    project_name: str,
    transport: ConnectorTransport = _default_transport,
) -> dict[str, object]:
    """Work item types (from the project's actual process template) + their
    genuinely required fields (alwaysRequired, not the full system-field dump),
    plus area/iteration paths."""
    base = f"{connection.org_url()}/{project_name}/_apis/wit"
    try:
        types_response = await transport.request(
            "GET",
            f"{base}/workitemtypes",
            auth=connection.auth(),
            params={"api-version": connection.api_version()},
            timeout=30,
        )
        types_response.raise_for_status()
        work_item_types: list[dict[str, object]] = []
        for wit in types_response.json().get("value", []):
            if wit.get("isDisabled"):
                continue
            required = [
                {"id": f["referenceName"], "name": f["name"]}
                for f in wit.get("fields", [])
                if f.get("alwaysRequired")
            ]
            work_item_types.append({"name": wit["name"], "required_fields": required})

        areas_response = await transport.request(
            "GET",
            f"{base}/classificationnodes/areas",
            auth=connection.auth(),
            params={"api-version": connection.api_version(), "$depth": 2},
            timeout=30,
        )
        iterations_response = await transport.request(
            "GET",
            f"{base}/classificationnodes/iterations",
            auth=connection.auth(),
            params={"api-version": connection.api_version(), "$depth": 2},
            timeout=30,
        )
    except httpx.HTTPError as exc:
        raise ConnectorError(f"ADO metadata discovery failed for {project_name}: {exc}") from exc

    def _paths(payload: dict[str, object]) -> list[str]:
        root = str(payload.get("name", ""))
        children = payload.get("children") or []
        paths = [root]
        for child in children if isinstance(children, list) else []:
            paths.append(f"{root}\\{child.get('name', '')}")
        return paths

    return {
        "project_name": project_name,
        "work_item_types": work_item_types,
        "area_paths": _paths(areas_response.json()) if areas_response.status_code == 200 else [],
        "iteration_paths": (
            _paths(iterations_response.json()) if iterations_response.status_code == 200 else []
        ),
    }


# ---------- Publishing (Issues 6.4/6.6/6.7) ----------


@dataclass(frozen=True)
class AdoPublishCandidate:
    item_id: str
    item_type: str
    content: FormattedContent
    parent_item_id: str | None


@dataclass
class AdoPublishOutcome:
    item_id: str
    ok: bool
    key: str | None = None
    url: str | None = None
    error: str | None = None
    attempts: int = 1


HIERARCHY_ORDER = ["EPIC", "STORY", "TASK", "SUBTASK"]


def sort_for_hierarchy(candidates: list[AdoPublishCandidate]) -> list[AdoPublishCandidate]:
    def rank(c: AdoPublishCandidate) -> int:
        try:
            return HIERARCHY_ORDER.index(c.item_type)
        except ValueError:
            return len(HIERARCHY_ORDER)

    return sorted(candidates, key=rank)


def validate_required_fields(
    work_item_type: str, metadata: dict[str, object] | None, field_defaults: dict[str, object]
) -> str | None:
    """Fail-fast (Issue 6.4): required fields must be naturally populated
    (Title/Description via content, Area/Iteration via mapping defaults) or have a
    fixed default in the mapping."""
    if not metadata:
        return None
    naturally_populated = {
        "System.Title",
        "System.Description",
        "System.State",
        "System.AreaId",
        "System.AreaPath",
        "System.IterationId",
        "System.IterationPath",
    }
    types = metadata.get("work_item_types")
    if not isinstance(types, list):
        return None
    for wit in types:
        if not isinstance(wit, dict) or wit.get("name") != work_item_type:
            continue
        required = wit.get("required_fields")
        missing = [
            str(f["name"])
            for f in (required if isinstance(required, list) else [])
            if isinstance(f, dict)
            and f.get("id") not in naturally_populated
            and f.get("id") not in field_defaults
        ]
        if missing:
            return (
                f"ADO requires field(s) {missing} for work item type '{work_item_type}' — "
                "set fixed defaults in the publish mapping."
            )
        return None
    return f"Work item type '{work_item_type}' not found in the ADO project's configuration."


def _json_patch(
    content: FormattedContent,
    area_path: str | None,
    iteration_path: str | None,
    field_defaults: dict[str, object],
    parent_url: str | None,
) -> list[dict[str, object]]:
    ops: list[dict[str, object]] = [
        {"op": "add", "path": "/fields/System.Title", "value": content.title[:255]},
        {"op": "add", "path": "/fields/System.Description", "value": content.body_markdown},
    ]
    if area_path:
        ops.append({"op": "add", "path": "/fields/System.AreaPath", "value": area_path})
    if iteration_path:
        ops.append({"op": "add", "path": "/fields/System.IterationPath", "value": iteration_path})
    for field_id, value in field_defaults.items():
        ops.append({"op": "add", "path": f"/fields/{field_id}", "value": value})
    if parent_url:
        ops.append(
            {
                "op": "add",
                "path": "/relations/-",
                "value": {
                    "rel": _PARENT_RELATION,
                    "url": parent_url,
                },
            }
        )
    return ops


async def create_work_item(
    connection: AdoConnection,
    project_name: str,
    work_item_type: str,
    candidate: AdoPublishCandidate,
    parent_url: str | None,
    area_path: str | None,
    iteration_path: str | None,
    field_defaults: dict[str, object],
    transport: ConnectorTransport = _default_transport,
) -> AdoPublishOutcome:
    """Creates one work item with 429/5xx retry + backoff (Issue 6.7)."""
    patch = _json_patch(candidate.content, area_path, iteration_path, field_defaults, parent_url)

    last_error = "unknown"
    for attempt in range(1, _MAX_ATTEMPTS + 1):
        try:
            response = await transport.request(
                "POST",
                f"{connection.org_url()}/{project_name}/_apis/wit/workitems/${work_item_type}",
                auth=connection.auth(),
                params={"api-version": connection.api_version()},
                json=patch,
                headers={"Content-Type": "application/json-patch+json"},
                timeout=30,
            )
        except httpx.HTTPError as exc:
            last_error = f"network error: {exc}"
            await asyncio.sleep(_BACKOFF_BASE_S * attempt)
            continue

        if response.status_code in (200, 201):
            body = response.json()
            work_item_id = body["id"]
            return AdoPublishOutcome(
                item_id=candidate.item_id,
                ok=True,
                key=f"AB#{work_item_id}",
                url=f"{connection.org_url()}/_workitems/edit/{work_item_id}",
                attempts=attempt,
            )
        if response.status_code == 429 or response.status_code >= 500:
            retry_after = response.headers.get("Retry-After")
            delay = float(retry_after) if retry_after else _BACKOFF_BASE_S * attempt
            last_error = f"HTTP {response.status_code} (transient)"
            await asyncio.sleep(delay)
            continue
        try:
            detail = response.json()
        except ValueError:
            detail = response.text[:300]
        return AdoPublishOutcome(
            item_id=candidate.item_id,
            ok=False,
            error=f"ADO rejected the work item ({response.status_code}): {detail}",
            attempts=attempt,
        )

    return AdoPublishOutcome(
        item_id=candidate.item_id,
        ok=False,
        error=f"Gave up after {_MAX_ATTEMPTS} attempts — last error: {last_error}",
        attempts=_MAX_ATTEMPTS,
    )


async def update_work_item(
    connection: AdoConnection,
    work_item_id: int,
    candidate: AdoPublishCandidate,
    field_defaults: dict[str, object],
    transport: ConnectorTransport = _default_transport,
) -> AdoPublishOutcome:
    """Updates title/description/field-defaults on an already-published work item
    (Issue 9.4) — never touches area/iteration/parent relations, which are set once
    at creation and are not part of a source-content update."""
    ops: list[dict[str, object]] = [
        {"op": "replace", "path": "/fields/System.Title", "value": candidate.content.title[:255]},
        {
            "op": "replace",
            "path": "/fields/System.Description",
            "value": candidate.content.body_markdown,
        },
    ]
    for field_id, value in field_defaults.items():
        ops.append({"op": "replace", "path": f"/fields/{field_id}", "value": value})

    last_error = "unknown"
    for attempt in range(1, _MAX_ATTEMPTS + 1):
        try:
            response = await transport.request(
                "PATCH",
                f"{connection.org_url()}/_apis/wit/workitems/{work_item_id}",
                auth=connection.auth(),
                params={"api-version": connection.api_version()},
                json=ops,
                headers={"Content-Type": "application/json-patch+json"},
                timeout=30,
            )
        except httpx.HTTPError as exc:
            last_error = f"network error: {exc}"
            await asyncio.sleep(_BACKOFF_BASE_S * attempt)
            continue

        if response.status_code in (200, 201):
            return AdoPublishOutcome(
                item_id=candidate.item_id,
                ok=True,
                key=f"AB#{work_item_id}",
                url=f"{connection.org_url()}/_workitems/edit/{work_item_id}",
                attempts=attempt,
            )
        if response.status_code == 429 or response.status_code >= 500:
            retry_after = response.headers.get("Retry-After")
            delay = float(retry_after) if retry_after else _BACKOFF_BASE_S * attempt
            last_error = f"HTTP {response.status_code} (transient)"
            await asyncio.sleep(delay)
            continue
        try:
            detail = response.json()
        except ValueError:
            detail = response.text[:300]
        return AdoPublishOutcome(
            item_id=candidate.item_id,
            ok=False,
            error=f"ADO rejected the work item update ({response.status_code}): {detail}",
            attempts=attempt,
        )

    return AdoPublishOutcome(
        item_id=candidate.item_id,
        ok=False,
        error=f"Gave up after {_MAX_ATTEMPTS} attempts — last error: {last_error}",
        attempts=_MAX_ATTEMPTS,
    )


async def add_comment(
    connection: AdoConnection,
    project_name: str,
    work_item_id: int,
    comment_text: str,
    transport: ConnectorTransport = _default_transport,
) -> None:
    """Flags a work item for reviewer attention (Issue 9.4) when its source
    requirement was removed — a comment, never an auto-close, so a human decides."""
    try:
        response = await transport.request(
            "POST",
            f"{connection.org_url()}/{project_name}/_apis/wit/workItems/{work_item_id}/comments",
            auth=connection.auth(),
            params={"api-version": "7.1-preview.3"},
            json={"text": comment_text},
            timeout=30,
        )
        response.raise_for_status()
    except httpx.HTTPError as exc:
        raise ConnectorError(f"Failed to comment on work item {work_item_id}: {exc}") from exc


@dataclass(frozen=True)
class RemoteWorkItemState:
    id: int
    title: str
    description: str
    status: str


async def fetch_work_item(
    connection: AdoConnection,
    work_item_id: int,
    transport: ConnectorTransport = _default_transport,
) -> RemoteWorkItemState:
    """Reads current title/description/state straight from ADO (Issue 9.5's drift
    check) — never cached, always the live remote state."""
    try:
        response = await transport.request(
            "GET",
            f"{connection.org_url()}/_apis/wit/workitems/{work_item_id}",
            auth=connection.auth(),
            params={"api-version": connection.api_version()},
            timeout=30,
        )
        response.raise_for_status()
    except httpx.HTTPError as exc:
        raise ConnectorError(f"Failed to fetch work item {work_item_id}: {exc}") from exc
    fields = response.json().get("fields", {})
    return RemoteWorkItemState(
        id=work_item_id,
        title=str(fields.get("System.Title", "")),
        description=str(fields.get("System.Description", "")),
        status=str(fields.get("System.State", "")),
    )


def build_candidate(item: DraftItem, mode: FormatMode, parent_item_id: str | None) -> AdoPublishCandidate:
    return AdoPublishCandidate(
        item_id=item.id,
        item_type=item.type.value,
        content=format_item(item, mode),
        parent_item_id=parent_item_id,
    )
