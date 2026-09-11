"""Azure DevOps connection auth abstraction (Issues 6.1/6.8/10.4).

Mirrors jira_auth.py's shape: publish/discovery/read layers depend on
`AdoConnection`, never on a concrete auth mechanism. Three implementations
exist: PAT auth (ADO_PAT, shared with the read connector, Issue 2.9), app-only
OAuth via the Microsoft identity platform (client-credentials grant, using an
Azure AD app registration — AZURE_AD_CLIENT_ID/SECRET/TENANT_ID), and
per-workspace delegated OAuth (authorization_code grant, same Azure AD app,
Issue 10.4 — the "Connect your ADO account" wizard step, mirroring Jira/
GitHub's per-workspace connector auth). `get_ado_connection()` prefers
app-only OAuth when all three Azure AD settings are present, else falls back
to PAT; `resolve_ado_connection()` additionally checks for a per-workspace/
per-org delegated Connection row first, same as resolve_jira_connection.

App-only (client-credentials) OAuth is a single ops-configured connection
shared across the workspace (same trust model as the PAT today), not a
per-user "sign in with Microsoft" flow — the Azure AD app must be granted the
"Azure DevOps" API permission (499b84ac-1321-427f-aa17-267ca6975798/.default)
with admin consent, and the service principal must be added as a member of
the ADO organization. Delegated OAuth (this module's exchange/refresh
functions) instead requests specific vso.* scopes and a normal user consents
via a browser redirect — the SAME Azure AD app registration handles both grant
types, just with different scope/response_type parameters; no second app
registration is needed. This is deliberately NOT the legacy
app.vssps.visualstudio.com OAuth app (its own separate registration, JWT
client-assertion token exchange, being deprecated by Microsoft in 2026) —
Microsoft Entra delegated OAuth is the documented forward-compatible path and
fits this product's B2B/organizational-account audience (Entra OAuth doesn't
yet support personal Microsoft accounts, which isn't a concern here).

Deployment-mode differences for a future Azure DevOps *Server* (on-prem)
implementation (Issue 6.8; none of this is built yet):
- Services (dev.azure.com): REST API versioned via `api-version` query param
  (this connector targets 7.1), OAuth via login.microsoftonline.com or PAT via
  Basic auth (empty username + PAT as password).
- Server: on-prem URL instead of dev.azure.com, typically Windows/NTLM or basic
  auth (no Microsoft identity platform OAuth), older REST API versions capped
  around 6.0-7.0 depending on the Server release, and area/iteration path
  behavior can differ slightly across on-prem collection configurations.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Protocol

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.services.connectors.types import ConnectorError

# Azure DevOps' resource ID in the Microsoft identity platform. The ".default"
# scope (app-only) requests whatever API permissions are configured on the
# Azure AD app; delegated OAuth instead requests specific vso.* scopes below.
_ADO_RESOURCE_ID = "499b84ac-1321-427f-aa17-267ca6975798"
_ADO_RESOURCE_SCOPE = f"{_ADO_RESOURCE_ID}/.default"
ADO_DELEGATED_SCOPES = f"{_ADO_RESOURCE_ID}/vso.work_write offline_access"


class AdoConnection(Protocol):
    def org_url(self) -> str: ...
    def auth(self) -> httpx.Auth | tuple[str, str]: ...
    def api_version(self) -> str: ...


@dataclass(frozen=True)
class PatConnection:
    """Personal Access Token auth — Basic auth with an empty username, PAT as the
    password (Azure DevOps' documented PAT scheme). Shared by the read-only
    backlog sync (Issue 2.9) and publishing (Epic 6)."""

    pat: str
    url: str

    def org_url(self) -> str:
        return self.url

    def auth(self) -> tuple[str, str]:
        return ("", self.pat)

    def api_version(self) -> str:
        return "7.1"


class _OAuthBearerAuth(httpx.Auth):
    """Fetches and caches an app-only access token via the client-credentials
    grant, refreshing shortly before expiry. One instance per OAuthConnection."""

    def __init__(self, client_id: str, client_secret: str, tenant_id: str) -> None:
        self._client_id = client_id
        self._client_secret = client_secret
        self._token_url = f"https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token"
        self._token: str | None = None
        self._expires_at: float = 0.0

    def _fetch_token(self) -> str:
        response = httpx.post(
            self._token_url,
            data={
                "grant_type": "client_credentials",
                "client_id": self._client_id,
                "client_secret": self._client_secret,
                "scope": _ADO_RESOURCE_SCOPE,
            },
            timeout=15,
        )
        if response.status_code != 200:
            raise ConnectorError(
                f"Azure AD token request failed ({response.status_code}): {response.text}"
            )
        body = response.json()
        self._token = str(body["access_token"])
        self._expires_at = time.time() + int(body.get("expires_in", 3600)) - 60
        return self._token

    def _valid_token(self) -> str:
        if self._token is None or time.time() >= self._expires_at:
            return self._fetch_token()
        return self._token

    def auth_flow(self, request: httpx.Request):  # type: ignore[no-untyped-def]
        request.headers["Authorization"] = f"Bearer {self._valid_token()}"
        yield request


@dataclass(frozen=True)
class OAuthConnection:
    """App-only OAuth via the Microsoft identity platform (client-credentials
    grant). See module docstring for the required Azure AD app configuration."""

    url: str
    _bearer: _OAuthBearerAuth = field(repr=False, compare=False)

    def org_url(self) -> str:
        return self.url

    def auth(self) -> httpx.Auth:
        return self._bearer

    def api_version(self) -> str:
        return "7.1"


def get_ado_connection() -> PatConnection | OAuthConnection:
    if not settings.ado_org_url:
        raise ConnectorError("ADO connection is not configured — set ADO_ORG_URL.")
    if settings.azure_ad_client_id and settings.azure_ad_client_secret and settings.azure_ad_tenant_id:
        bearer = _OAuthBearerAuth(
            client_id=settings.azure_ad_client_id,
            client_secret=settings.azure_ad_client_secret,
            tenant_id=settings.azure_ad_tenant_id,
        )
        return OAuthConnection(url=settings.ado_org_url, _bearer=bearer)
    if not settings.ado_pat:
        raise ConnectorError(
            "ADO connection is not configured — set either AZURE_AD_CLIENT_ID/SECRET/TENANT_ID "
            "(OAuth) or ADO_PAT."
        )
    return PatConnection(pat=settings.ado_pat, url=settings.ado_org_url)


@dataclass(frozen=True)
class AdoOAuthTokens:
    access_token: str
    refresh_token: str
    expires_in: int


def _entra_token_url() -> str:
    return f"https://login.microsoftonline.com/{settings.azure_ad_tenant_id}/oauth2/v2.0/token"


async def exchange_ado_oauth_code_for_tokens(code: str, redirect_uri: str) -> AdoOAuthTokens:
    """Delegated authorization_code exchange (Issue 10.4) — the per-workspace
    "Connect your ADO account" wizard step. Same Azure AD app/tenant as the
    app-only client-credentials flow above, different grant type and scopes
    (vso.* delegated scopes instead of .default)."""
    if not (settings.azure_ad_client_id and settings.azure_ad_client_secret and settings.azure_ad_tenant_id):
        raise ConnectorError("Azure AD app (AZURE_AD_CLIENT_ID/SECRET/TENANT_ID) is not configured.")
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.post(
                _entra_token_url(),
                data={
                    "grant_type": "authorization_code",
                    "client_id": settings.azure_ad_client_id,
                    "client_secret": settings.azure_ad_client_secret,
                    "code": code,
                    "redirect_uri": redirect_uri,
                    "scope": ADO_DELEGATED_SCOPES,
                },
            )
    except httpx.HTTPError as exc:
        raise ConnectorError(f"Azure DevOps OAuth token exchange request failed: {exc}") from exc
    if response.status_code != 200:
        raise ConnectorError(
            f"Azure DevOps OAuth token exchange request failed: {response.status_code} {response.text}"
        )
    payload = response.json()
    access_token = payload.get("access_token")
    refresh_token = payload.get("refresh_token")
    if not access_token or not refresh_token:
        raise ConnectorError(
            "Azure DevOps OAuth token exchange failed: "
            f"{payload.get('error_description', payload.get('error', 'unknown error'))}"
        )
    return AdoOAuthTokens(
        access_token=str(access_token),
        refresh_token=str(refresh_token),
        expires_in=int(payload.get("expires_in", 3600)),
    )


async def refresh_ado_access_token(refresh_token: str) -> AdoOAuthTokens:
    """Microsoft Entra rotates the refresh token on every use, same as
    Atlassian's — callers MUST persist the returned refresh_token."""
    if not (settings.azure_ad_client_id and settings.azure_ad_client_secret and settings.azure_ad_tenant_id):
        raise ConnectorError("Azure AD app (AZURE_AD_CLIENT_ID/SECRET/TENANT_ID) is not configured.")
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.post(
                _entra_token_url(),
                data={
                    "grant_type": "refresh_token",
                    "client_id": settings.azure_ad_client_id,
                    "client_secret": settings.azure_ad_client_secret,
                    "refresh_token": refresh_token,
                    "scope": ADO_DELEGATED_SCOPES,
                },
            )
    except httpx.HTTPError as exc:
        raise ConnectorError(f"Azure DevOps OAuth token refresh request failed: {exc}") from exc
    if response.status_code != 200:
        raise ConnectorError(
            f"Azure DevOps OAuth token refresh request failed: {response.status_code} {response.text}"
        )
    payload = response.json()
    access_token = payload.get("access_token")
    new_refresh_token = payload.get("refresh_token")
    if not access_token or not new_refresh_token:
        raise ConnectorError(
            "Azure DevOps OAuth token refresh failed: "
            f"{payload.get('error_description', payload.get('error', 'unknown error'))}"
        )
    return AdoOAuthTokens(
        access_token=str(access_token),
        refresh_token=str(new_refresh_token),
        expires_in=int(payload.get("expires_in", 3600)),
    )


class _AdoDelegatedBearerAuth(httpx.Auth):
    """Static Bearer auth for a delegated token — unlike _OAuthBearerAuth's
    self-refreshing app-only token, refresh here happens explicitly in
    resolve_ado_connection() before this class is constructed, since a
    rotated refresh token must be written back to the DB (same reasoning as
    Jira's _JiraBearerAuth)."""

    def __init__(self, token: str) -> None:
        self._token = token

    def auth_flow(self, request: httpx.Request):  # type: ignore[no-untyped-def]
        request.headers["Authorization"] = f"Bearer {self._token}"
        yield request


@dataclass(frozen=True)
class DelegatedOAuthConnection:
    """Satisfies the AdoConnection Protocol using a per-workspace delegated
    OAuth access token (Issue 10.4), resolved/refreshed by
    resolve_ado_connection — as opposed to OAuthConnection's single
    env-configured app-only connection for the whole deployment."""

    access_token: str
    url: str

    def org_url(self) -> str:
        return self.url

    def auth(self) -> httpx.Auth:
        return _AdoDelegatedBearerAuth(self.access_token)

    def api_version(self) -> str:
        return "7.1"


async def resolve_ado_connection(
    session: AsyncSession,
    workspace_id: str | None = None,
    *,
    organization_id: str | None = None,
) -> AdoConnection:
    """Per-workspace/per-org delegated Connection resolution (Issue 10.4),
    mirroring resolve_jira_connection exactly: prefers a stored OAUTH
    Connection for the given workspace OR organization (exactly one must be
    passed), transparently refreshing an expired access token (persisting the
    rotated refresh token), falls back to the single-tenant
    env-configured/app-only connection when no workspace-scoped row exists.
    Org-level lookups have no env-configured fallback."""
    from app.models import Connection
    from app.services.crypto import decrypt_credentials, encrypt_credentials

    if (workspace_id is None) == (organization_id is None):
        raise ValueError("Pass exactly one of workspace_id or organization_id.")

    scope_id = workspace_id if workspace_id is not None else organization_id
    scope_column = Connection.workspaceId if workspace_id is not None else Connection.organizationId

    row = (
        await session.execute(
            select(Connection).where(scope_column == scope_id, Connection.toolKey == "ado")
        )
    ).scalar_one_or_none()
    if row and row.authMethod == "OAUTH" and row.encryptedCredentials:
        org_url = (row.scope or {}).get("org_url") if row.scope else None
        if not isinstance(org_url, str):
            scope_label = "workspace" if workspace_id is not None else "organization"
            raise ConnectorError(
                f"ADO Connection for {scope_label} {scope_id} has no org_url in scope — reconnect required."
            )
        tokens: dict[str, object] = json.loads(decrypt_credentials(row.encryptedCredentials))
        if float(tokens["expires_at"]) <= time.time():  # type: ignore[arg-type]
            try:
                fresh = await refresh_ado_access_token(str(tokens["refresh_token"]))
            except ConnectorError:
                # Same concurrent-refresh race as Jira's resolver: Entra
                # rotates the refresh token on every use, so two concurrent
                # requests can both see an expired token and both attempt to
                # refresh with the same (now-stale-after-the-first-succeeds)
                # refresh token. Re-read the row before treating this as a
                # genuine failure.
                await session.refresh(row)
                if row.encryptedCredentials:
                    retried_tokens: dict[str, object] = json.loads(
                        decrypt_credentials(row.encryptedCredentials)
                    )
                    if float(retried_tokens["expires_at"]) > time.time():  # type: ignore[arg-type]
                        return DelegatedOAuthConnection(
                            access_token=str(retried_tokens["access_token"]), url=org_url
                        )
                raise
            expires_at = time.time() + fresh.expires_in
            tokens = {
                "access_token": fresh.access_token,
                "refresh_token": fresh.refresh_token,
                "expires_at": expires_at,
            }
            row.encryptedCredentials = encrypt_credentials(json.dumps(tokens))
            row.updatedAt = datetime.now(UTC).replace(tzinfo=None)
            await session.commit()
        return DelegatedOAuthConnection(access_token=str(tokens["access_token"]), url=org_url)
    if organization_id is not None:
        raise ConnectorError(
            f"No ADO OAuth Connection for organization {organization_id} — authorize Azure DevOps at "
            "the org level first."
        )
    return get_ado_connection()


async def check_connection_health(connection: AdoConnection) -> dict[str, object]:
    """Issue 6.1's health check — surfaced by the UI as a reconnect prompt when
    the PAT/OAuth token has expired or lacks the required scopes."""
    try:
        async with httpx.AsyncClient(auth=connection.auth(), timeout=15) as client:
            response = await client.get(
                f"{connection.org_url()}/_apis/projects",
                params={"api-version": connection.api_version(), "$top": 1},
            )
        if response.status_code == 200:
            return {"ok": True}
        if response.status_code in (401, 203):  # 203 = ADO's "not authenticated" redirect signal
            return {"ok": False, "reason": "Credentials are invalid or expired — reconnect required."}
        return {"ok": False, "status": response.status_code, "reason": "Unexpected response."}
    except ConnectorError as exc:
        return {"ok": False, "reason": str(exc)}
    except httpx.HTTPError as exc:
        return {"ok": False, "reason": f"Azure DevOps unreachable: {exc}"}
