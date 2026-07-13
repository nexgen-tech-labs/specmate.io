"""GitHub connection auth abstraction (Issues 7.1/7.8).

Mirrors jira_auth.py/ado_auth.py's shape. `TokenConnection` (GITHUB_TOKEN, already
configured and shared with the read connector, Issue 2.10) is implemented today.
A GitHub App installation flow (preferred for org-level, granular repo permissions
per Issue 7.1) is deferred — it needs a registered GitHub App (App ID + private
key) and an installation flow, a manual setup step like Jira's OAuth deferral.

Issue 7.8 (GHES readiness): `base_url` is already a first-class field on the
connection rather than a hardcoded api.github.com constant, so a GitHub Enterprise
Server connection is a matter of constructing a TokenConnection with a different
base_url + a GHES-compatible auth mechanism — no interface change needed. Known
github.com vs GHES differences: GHES uses `https://{host}/api/v3` (not
`api.github.com`), GraphQL is at `https://{host}/api/graphql`, and GHES trails
github.com on API version/feature availability (e.g. newer GraphQL fields land on
github.com first).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

import httpx

from app.core.config import settings
from app.services.connectors.types import ConnectorError

_DEFAULT_BASE_URL = "https://api.github.com"


class GitHubConnection(Protocol):
    def base_url(self) -> str: ...
    def headers(self) -> dict[str, str]: ...


@dataclass(frozen=True)
class TokenConnection:
    token: str
    base_url_: str = _DEFAULT_BASE_URL

    def base_url(self) -> str:
        return self.base_url_

    def headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }


def get_github_connection() -> TokenConnection:
    if not settings.github_token:
        raise ConnectorError("GitHub connection is not configured — set GITHUB_TOKEN.")
    return TokenConnection(token=settings.github_token)


async def check_connection_health(connection: GitHubConnection) -> dict[str, object]:
    """Issue 7.1's health check."""
    try:
        async with httpx.AsyncClient(headers=connection.headers(), timeout=15) as client:
            response = await client.get(f"{connection.base_url()}/user")
        if response.status_code == 200:
            payload = response.json()
            return {"ok": True, "account": payload.get("login")}
        if response.status_code == 401:
            return {"ok": False, "reason": "Token is invalid or expired — reconnect required."}
        return {"ok": False, "status": response.status_code, "reason": "Unexpected response."}
    except httpx.HTTPError as exc:
        return {"ok": False, "reason": f"GitHub unreachable: {exc}"}
