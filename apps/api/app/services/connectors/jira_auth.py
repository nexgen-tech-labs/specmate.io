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
import json
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Protocol, cast
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


@dataclass(frozen=True)
class JiraOAuthTokens:
    access_token: str
    refresh_token: str
    expires_in: int


@dataclass(frozen=True)
class JiraSite:
    cloud_id: str
    url: str
    name: str


_ATLASSIAN_TOKEN_URL = "https://auth.atlassian.com/oauth/token"
_ATLASSIAN_ACCESSIBLE_RESOURCES_URL = "https://api.atlassian.com/oauth/token/accessible-resources"


async def exchange_oauth_code_for_tokens(code: str, redirect_uri: str) -> JiraOAuthTokens:
    """Jira OAuth 3LO authorization-code exchange (fast-follow to Issue #101's
    wizard OAuth step). Mirrors github_auth.py's exchange_oauth_code_for_token,
    but Jira returns a refresh_token too (access tokens expire in ~1 hour)."""
    if not settings.jira_oauth_app_client_id or not settings.jira_oauth_app_client_secret:
        raise ConnectorError("Jira OAuth App is not configured.")
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.post(
                _ATLASSIAN_TOKEN_URL,
                headers={"Accept": "application/json"},
                json={
                    "grant_type": "authorization_code",
                    "client_id": settings.jira_oauth_app_client_id,
                    "client_secret": settings.jira_oauth_app_client_secret,
                    "code": code,
                    "redirect_uri": redirect_uri,
                },
            )
            response.raise_for_status()
    except httpx.HTTPError as exc:
        raise ConnectorError(f"Jira OAuth token exchange request failed: {exc}") from exc
    payload = response.json()
    access_token = payload.get("access_token")
    refresh_token = payload.get("refresh_token")
    if not access_token or not refresh_token:
        raise ConnectorError(
            f"Jira OAuth token exchange failed: {payload.get('error_description', payload.get('error', 'unknown error'))}"
        )
    return JiraOAuthTokens(
        access_token=str(access_token),
        refresh_token=str(refresh_token),
        expires_in=int(payload.get("expires_in", 3600)),
    )


async def refresh_jira_access_token(refresh_token: str) -> JiraOAuthTokens:
    """Atlassian rotates the refresh token on every use — callers MUST persist
    the returned refresh_token (not reuse the old one), or the next refresh
    attempt fails with an invalidated token."""
    if not settings.jira_oauth_app_client_id or not settings.jira_oauth_app_client_secret:
        raise ConnectorError("Jira OAuth App is not configured.")
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.post(
                _ATLASSIAN_TOKEN_URL,
                headers={"Accept": "application/json"},
                json={
                    "grant_type": "refresh_token",
                    "client_id": settings.jira_oauth_app_client_id,
                    "client_secret": settings.jira_oauth_app_client_secret,
                    "refresh_token": refresh_token,
                },
            )
            response.raise_for_status()
    except httpx.HTTPError as exc:
        raise ConnectorError(f"Jira OAuth token refresh request failed: {exc}") from exc
    payload = response.json()
    access_token = payload.get("access_token")
    new_refresh_token = payload.get("refresh_token")
    if not access_token or not new_refresh_token:
        raise ConnectorError(
            f"Jira OAuth token refresh failed: {payload.get('error_description', payload.get('error', 'unknown error'))}"
        )
    return JiraOAuthTokens(
        access_token=str(access_token),
        refresh_token=str(new_refresh_token),
        expires_in=int(payload.get("expires_in", 3600)),
    )


async def discover_accessible_jira_sites(access_token: str) -> list[JiraSite]:
    """GET accessible-resources — the Jira Cloud sites this OAuth grant
    covers. Empty list means the user completed OAuth consent but the grant
    somehow covers no Jira site (e.g. they only have Confluence access) —
    treated as a configuration error, not a valid zero-site state."""
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.get(
                _ATLASSIAN_ACCESSIBLE_RESOURCES_URL,
                headers={"Authorization": f"Bearer {access_token}", "Accept": "application/json"},
            )
            response.raise_for_status()
    except httpx.HTTPError as exc:
        raise ConnectorError(f"Jira accessible-resources lookup failed: {exc}") from exc
    try:
        sites = [
            JiraSite(cloud_id=r["id"], url=r["url"], name=r["name"]) for r in response.json()
        ]
    except (KeyError, TypeError) as exc:
        raise ConnectorError(f"Jira accessible-resources response was malformed: {exc}") from exc
    if not sites:
        raise ConnectorError(
            "This Atlassian account has no accessible Jira site — grant access to at least one Jira Cloud site."
        )
    return sites


class _JiraBearerAuth(httpx.Auth):
    """Static Bearer auth — unlike ADO's self-refreshing _OAuthBearerAuth,
    refresh happens explicitly in resolve_jira_connection() before this class
    is even constructed, since a rotated refresh token must be written back
    to the DB, which an httpx.Auth.auth_flow() generator can't cleanly do
    mid-request."""

    def __init__(self, token: str) -> None:
        self._token = token

    def auth_flow(self, request: httpx.Request):  # type: ignore[no-untyped-def]
        request.headers["Authorization"] = f"Bearer {self._token}"
        yield request


@dataclass(frozen=True)
class JiraOAuthConnection:
    """Satisfies the JiraConnection Protocol using a per-workspace OAuth 3LO
    access token + the cloudId gateway (decrypted/refreshed at resolution
    time via resolve_jira_connection — never persisted in plaintext), instead
    of CloudTokenConnection's env-configured email+API-token basic auth."""

    access_token: str
    cloud_id: str

    def base_url(self) -> str:
        return f"https://api.atlassian.com/ex/jira/{self.cloud_id}"

    def auth(self) -> httpx.Auth:
        return _JiraBearerAuth(self.access_token)

    def api_version(self) -> str:
        return "3"


async def resolve_jira_connection(session: AsyncSession, workspace_id: str) -> JiraConnection:
    """Per-workspace connection resolution (fast-follow to Issue #101):
    prefers a stored OAuth Connection for this workspace, transparently
    refreshing an expired access token (persisting the rotated refresh
    token — Atlassian invalidates the old one on every refresh), falls back
    to the existing single-tenant env-configured connection unchanged."""
    from app.models import Connection
    from app.services.crypto import decrypt_credentials, encrypt_credentials

    row = (
        await session.execute(
            select(Connection).where(Connection.workspaceId == workspace_id, Connection.toolKey == "jira")
        )
    ).scalar_one_or_none()
    if row and row.authMethod == "OAUTH" and row.encryptedCredentials:
        cloud_id = (row.scope or {}).get("cloud_id")
        assert isinstance(cloud_id, str)
        tokens: dict[str, object] = json.loads(decrypt_credentials(row.encryptedCredentials))
        if float(cast(str, tokens["expires_at"])) <= time.time():
            fresh = await refresh_jira_access_token(str(tokens["refresh_token"]))
            expires_at = time.time() + fresh.expires_in
            tokens = {
                "access_token": fresh.access_token,
                "refresh_token": fresh.refresh_token,
                "expires_at": expires_at,
            }
            row.encryptedCredentials = encrypt_credentials(json.dumps(tokens))
            row.updatedAt = datetime.now(UTC).replace(tzinfo=None)
            await session.commit()
        return JiraOAuthConnection(access_token=str(tokens["access_token"]), cloud_id=cloud_id)
    return get_jira_connection()


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
