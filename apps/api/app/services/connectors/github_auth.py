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
from typing import TYPE_CHECKING, Protocol

import httpx

from app.core.config import settings
from app.services.connectors.types import ConnectorError

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

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


async def exchange_oauth_code_for_token(code: str) -> str:
    """GitHub OAuth authorization-code exchange (Issue #101's wizard OAuth step).

    Trades a short-lived `code` (from the /login/oauth/authorize redirect) for a
    per-workspace access token. The token is handed back to the caller to encrypt
    and persist (app/services/crypto.py) — this function never touches storage.
    """
    if not settings.github_oauth_app_client_id or not settings.github_oauth_app_client_secret:
        raise ConnectorError("GitHub OAuth App is not configured.")
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.post(
                "https://github.com/login/oauth/access_token",
                headers={"Accept": "application/json"},
                data={
                    "client_id": settings.github_oauth_app_client_id,
                    "client_secret": settings.github_oauth_app_client_secret,
                    "code": code,
                },
            )
            response.raise_for_status()
    except httpx.HTTPError as exc:
        # Covers both a non-2xx response (HTTPStatusError) and network-level
        # failures (ConnectError/TimeoutException/...) — callers only need to
        # catch ConnectorError, not every possible httpx exception type.
        raise ConnectorError(f"GitHub OAuth token exchange request failed: {exc}") from exc
    payload = response.json()
    token = payload.get("access_token")
    if not token:
        raise ConnectorError(
            f"GitHub OAuth token exchange failed: {payload.get('error', 'unknown error')}"
        )
    return str(token)


@dataclass(frozen=True)
class OAuthTokenConnection:
    """Satisfies the GitHubConnection Protocol using a per-workspace OAuth
    token (decrypted from Connection.encryptedCredentials at resolution time,
    never persisted in plaintext) instead of the single-tenant TokenConnection
    above."""

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


async def resolve_github_connection(
    session: "AsyncSession",
    workspace_id: str | None = None,
    *,
    organization_id: str | None = None,
) -> GitHubConnection:
    """Connection resolution (Issue #101, extended for org-level auth by the
    Onboarding Flow redesign): prefers a stored OAuth Connection for the given
    workspace OR organization (exactly one must be passed), falls back to the
    single-tenant env-configured connection unchanged when no workspace-scoped
    row exists — so GitHub publishing keeps working exactly as before for
    every workspace that hasn't gone through the OAuth wizard. Org-level
    lookups have no env-configured fallback — env config has no notion of
    "organization"."""
    from sqlalchemy import select

    from app.models import Connection
    from app.services.crypto import decrypt_credentials

    if (workspace_id is None) == (organization_id is None):
        raise ValueError("Pass exactly one of workspace_id or organization_id.")

    scope_column = Connection.workspaceId if workspace_id is not None else Connection.organizationId
    scope_id = workspace_id if workspace_id is not None else organization_id

    row = (
        await session.execute(
            select(Connection).where(scope_column == scope_id, Connection.toolKey == "github")
        )
    ).scalar_one_or_none()
    if row and row.authMethod == "OAUTH" and row.encryptedCredentials:
        token = decrypt_credentials(row.encryptedCredentials)
        return OAuthTokenConnection(token=token)
    if organization_id is not None:
        raise ConnectorError(
            f"No GitHub OAuth Connection for organization {organization_id} — authorize GitHub at the org level first."
        )
    return get_github_connection()


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
