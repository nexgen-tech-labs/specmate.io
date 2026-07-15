"""Jira connection auth abstraction (Issues 5.1/5.2/5.8, 10.2).

The publish/discovery/read layers depend on `JiraConnection`, never on a concrete
auth mechanism — Cloud API-token auth (single-tenant, env-configured) and Atlassian
Connect JWT (multi-tenant, per-install) both implement the same protocol. Server/DC
PAT auth is a future third implementation.

Deployment-mode differences to know for a future Server/DC implementation
(documented per Issue 5.8; none of this is built yet):
- Cloud: REST v3 (`/rest/api/3`), ADF rich-text bodies, basic auth = email+API token
  or OAuth 3LO Bearer via api.atlassian.com/ex/jira/{cloudId} gateway URLs.
- Server/DC: REST v2 only (`/rest/api/2`), plain-text/wiki-markup bodies (no ADF),
  PAT via Bearer header (DC 8.14+) or basic auth; no cloudId gateway; hierarchy
  uses the Epic Link custom field rather than the unified `parent` field.
"""

from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass
from typing import Protocol
from urllib.parse import parse_qs, urlsplit

import httpx
import jwt as pyjwt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models import AtlassianConnectInstall
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


def _query_string_hash(method: str, url: str) -> str:
    """Atlassian's non-standard QSH claim: sha256(METHOD&canonical_path&sorted_qs).
    Ties a Connect JWT to one exact request — the same canonicalization
    `@atlassian/atlassian-jwt` uses on the Node/web side (Issue 10.2), reimplemented
    here since no equivalent Python library exists. See
    https://developer.atlassian.com/cloud/jira/platform/understanding-jwt/#qsh"""
    parts = urlsplit(url)
    path = parts.path.rstrip("/") or "/"
    query_pairs = sorted(
        (k, v)
        for k, values in parse_qs(parts.query, keep_blank_values=True).items()
        for v in values
        if k.lower() != "jwt"
    )
    canonical_query = "&".join(f"{k}={v}" for k, v in query_pairs)
    canonical_request = f"{method.upper()}&{path}&{canonical_query}"
    return hashlib.sha256(canonical_request.encode("utf-8")).hexdigest()


class ConnectJwtAuth(httpx.Auth):
    """Signs each outgoing request with a fresh 2-Legged JWT (Issue 10.2) —
    Atlassian Connect's server-to-server auth: no OAuth token exchange, the app
    signs a short-lived JWT per request using the sharedSecret issued at install
    time. Unlike CloudTokenConnection's static Basic auth, this must re-sign per
    request (the QSH claim binds the token to one exact method+path+query), so
    it's an httpx.Auth subclass rather than a (user, pass) tuple."""

    def __init__(self, client_key: str, shared_secret: str) -> None:
        self._client_key = client_key
        self._shared_secret = shared_secret

    def auth_flow(self, request: httpx.Request):  # type: ignore[no-untyped-def]
        now = int(time.time())
        claims = {
            "iss": self._client_key,
            "iat": now,
            "exp": now + 180,  # short-lived by design — signed fresh per request
            "qsh": _query_string_hash(request.method, str(request.url)),
        }
        token = pyjwt.encode(claims, self._shared_secret, algorithm="HS256")
        request.headers["Authorization"] = f"JWT {token}"
        yield request


@dataclass(frozen=True)
class ConnectJwtConnection:
    """Atlassian Connect app-install auth (Issue 10.2) — multi-tenant: one
    instance per installed Jira Cloud site (clientKey + sharedSecret from that
    site's `installed` lifecycle callback), as opposed to CloudTokenConnection's
    single env-configured connection for the whole deployment."""

    client_key: str
    shared_secret: str
    url: str

    def base_url(self) -> str:
        return self.url

    def auth(self) -> httpx.Auth:
        return ConnectJwtAuth(self.client_key, self.shared_secret)

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


async def get_connect_connection_for_workspace(
    session: AsyncSession, workspace_id: str
) -> ConnectJwtConnection:
    """Resolves the ConnectJwtConnection for a workspace with a claimed
    Atlassian Connect install (Issue 10.2). NOT yet wired into publish.py's
    PublishGateway — that gateway is currently single-tenant (one
    env-configured CloudTokenConnection for the whole deployment, resolved
    with no workspace argument at all). Making publish per-workspace-aware is
    a real call-site change to Epic 5's gateway plumbing, intentionally left
    for when the per-workspace connection store (deferred since Issue 5.1) is
    built — this function exists so that work has a ready-made connection
    resolver to plug in, not to pre-empt that design decision."""
    result = await session.execute(
        select(AtlassianConnectInstall).where(
            AtlassianConnectInstall.workspaceId == workspace_id,
            AtlassianConnectInstall.uninstalledAt.is_(None),
        )
    )
    install = result.scalar_one_or_none()
    if install is None:
        raise ConnectorError(
            f"No claimed Atlassian Connect install found for workspace {workspace_id}."
        )
    return ConnectJwtConnection(
        client_key=install.clientKey, shared_secret=install.sharedSecret, url=install.baseUrl
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
