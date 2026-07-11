"""Azure DevOps backlog connector (Issue #15) — read-only pull of a project's work
items as ReferenceItems via WIQL + batch work-item fetch. Auth: PAT (shared with
Epic 6's publishing connector later)."""

from __future__ import annotations

import re

import httpx

from app.core.config import settings
from app.services.connectors.types import ConnectorError, ReferenceItemData

_API_VERSION = "7.1"
_BATCH_SIZE = 200
_TAG_RE = re.compile(r"<[^>]+>")


def _strip_html(html: str) -> str:
    """ADO descriptions are HTML fragments — flatten to plain text."""
    return _TAG_RE.sub(" ", html).replace("&nbsp;", " ").strip()


def _work_item_to_reference_item(item: dict[str, object]) -> ReferenceItemData:
    fields = item.get("fields") or {}
    assert isinstance(fields, dict)
    item_id = str(item.get("id", ""))
    return ReferenceItemData(
        external_key=item_id,
        title=str(fields.get("System.Title") or ""),
        description=_strip_html(str(fields.get("System.Description") or "")),
        item_type=str(fields.get("System.WorkItemType") or ""),
        state=str(fields.get("System.State") or ""),
        url=str(item.get("url")) if item.get("url") else None,
    )


async def fetch_ado_work_items(project: str) -> list[ReferenceItemData]:
    if not (settings.ado_org_url and settings.ado_pat):
        raise ConnectorError("ADO connector is not configured — set ADO_ORG_URL and ADO_PAT.")

    auth = ("", settings.ado_pat)
    items: list[ReferenceItemData] = []

    async with httpx.AsyncClient(auth=auth, timeout=30) as client:
        try:
            wiql_response = await client.post(
                f"{settings.ado_org_url}/{project}/_apis/wit/wiql",
                params={"api-version": _API_VERSION},
                json={
                    "query": "Select [System.Id] From WorkItems "
                    "Where [System.TeamProject] = @project Order By [System.Id]"
                },
            )
            wiql_response.raise_for_status()
        except httpx.HTTPError as exc:
            raise ConnectorError(f"ADO WIQL request failed: {exc}") from exc

        ids = [str(ref["id"]) for ref in wiql_response.json().get("workItems", [])]

        for start in range(0, len(ids), _BATCH_SIZE):
            batch = ids[start : start + _BATCH_SIZE]
            try:
                response = await client.get(
                    f"{settings.ado_org_url}/_apis/wit/workitems",
                    params={
                        "ids": ",".join(batch),
                        "fields": "System.Title,System.Description,System.WorkItemType,System.State",
                        "api-version": _API_VERSION,
                    },
                )
                response.raise_for_status()
            except httpx.HTTPError as exc:
                raise ConnectorError(f"ADO work-item fetch failed: {exc}") from exc

            for item in response.json().get("value", []):
                items.append(_work_item_to_reference_item(item))

    return items
