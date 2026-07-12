"""Jira connection auth abstraction (Issues 5.1/5.8).

The publish/discovery/read layers depend on `JiraConnection`, never on a concrete
auth mechanism — Cloud API-token auth today; OAuth 2.0 (3LO) and Server/DC PAT
auth implement the same protocol later without touching call sites.

Deployment-mode differences to know for a future Server/DC implementation
(documented per Issue 5.8; none of this is built yet):
- Cloud: REST v3 (`/rest/api/3`), ADF rich-text bodies, basic auth = email+API token
  or OAuth 3LO Bearer via api.atlassian.com/ex/jira/{cloudId} gateway URLs.
- Server/DC: REST v2 only (`/rest/api/2`), plain-text/wiki-markup bodies (no ADF),
  PAT via Bearer header (DC 8.14+) or basic auth; no cloudId gateway; hierarchy
  uses the Epic Link custom field rather than the unified `parent` field.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

import httpx

from app.core.config import settings
from app.services.connectors.types import ConnectorError


class JiraConnection(Protocol):
    """What every Jira auth mechanism must provide."""

    def base_url(self) -> str: ...
    def auth(self) -> httpx.Auth | tuple[str, str]: ...
    def api_version(self) -> str: ...


@dataclass(frozen=True)
class CloudTokenConnection:
    """Jira Cloud via Atlassian email + API token — the single connection object
    shared by the read-only backlog sync (Issue 2.8) and publishing (Epic 5).
    Credentials are env-configured/single-tenant until the per-workspace
    connection store + OAuth flow exist (see architecture.md)."""

    email: str
    token: str
    url: str

    def base_url(self) -> str:
        return self.url

    def auth(self) -> tuple[str, str]:
        return (self.email, self.token)

    def api_version(self) -> str:
        return "3"


def get_jira_connection() -> CloudTokenConnection:
    if not (settings.jira_base_url and settings.atlassian_email and settings.atlassian_api_token):
        raise ConnectorError(
            "Jira connection is not configured — set JIRA_BASE_URL, ATLASSIAN_EMAIL, "
            "and ATLASSIAN_API_TOKEN."
        )
    return CloudTokenConnection(
        email=settings.atlassian_email,
        token=settings.atlassian_api_token,
        url=settings.jira_base_url,
    )


async def check_connection_health(connection: JiraConnection) -> dict[str, object]:
    """Verifies the connection still authenticates (Issue 5.1's health check) —
    surfaced by the UI as a reconnect prompt when not ok."""
    try:
        async with httpx.AsyncClient(auth=connection.auth(), timeout=15) as client:
            response = await client.get(
                f"{connection.base_url()}/rest/api/{connection.api_version()}/myself"
            )
        if response.status_code == 200:
            payload = response.json()
            return {"ok": True, "account": payload.get("displayName") or payload.get("emailAddress")}
        return {"ok": False, "status": response.status_code, "reason": "Authentication rejected."}
    except httpx.HTTPError as exc:
        return {"ok": False, "reason": f"Jira unreachable: {exc}"}
