"""GitHub Issues backlog connector (Issue #16) — read-only pull of a repo's issues
as ReferenceItems. Auth: token (shared with Epic 7's publishing connector later).
Pull requests share GitHub's issues endpoint and are filtered out."""

from __future__ import annotations

import httpx

from app.core.config import settings
from app.services.connectors.types import ConnectorError, ReferenceItemData

_PAGE_SIZE = 100


def _issue_to_reference_item(issue: dict[str, object]) -> ReferenceItemData:
    labels = issue.get("labels")
    label_names = [
        str(label.get("name", ""))
        for label in (labels if isinstance(labels, list) else [])
        if isinstance(label, dict)
    ]
    return ReferenceItemData(
        external_key=str(issue.get("number", "")),
        title=str(issue.get("title") or ""),
        description=str(issue.get("body") or ""),
        item_type=", ".join(name for name in label_names if name) or "issue",
        state=str(issue.get("state") or ""),
        url=str(issue.get("html_url")) if issue.get("html_url") else None,
    )


async def fetch_github_issues(repo: str) -> list[ReferenceItemData]:
    """repo: "owner/name"."""
    if not settings.github_token:
        raise ConnectorError("GitHub connector is not configured — set GITHUB_TOKEN.")

    headers = {
        "Authorization": f"Bearer {settings.github_token}",
        "Accept": "application/vnd.github+json",
    }
    items: list[ReferenceItemData] = []
    page = 1

    async with httpx.AsyncClient(headers=headers, timeout=30) as client:
        while True:
            try:
                response = await client.get(
                    f"https://api.github.com/repos/{repo}/issues",
                    params={"state": "all", "per_page": _PAGE_SIZE, "page": page},
                )
                response.raise_for_status()
            except httpx.HTTPError as exc:
                raise ConnectorError(f"GitHub API request failed: {exc}") from exc

            batch = response.json()
            for issue in batch:
                if "pull_request" in issue:
                    continue
                items.append(_issue_to_reference_item(issue))

            if len(batch) < _PAGE_SIZE:
                break
            page += 1

    return items
