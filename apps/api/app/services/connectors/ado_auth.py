"""Azure DevOps connection auth abstraction (Issues 6.1/6.8).

Mirrors jira_auth.py's shape: publish/discovery/read layers depend on
`AdoConnection`, never on a concrete auth mechanism. Two implementations exist:
PAT auth (ADO_PAT, shared with the read connector, Issue 2.9) and OAuth via the
Microsoft identity platform (app-only client-credentials grant, using an Azure AD
app registration — AZURE_AD_CLIENT_ID/SECRET/TENANT_ID). `get_ado_connection()`
prefers OAuth when all three Azure AD settings are present, else falls back to PAT.

App-only (client-credentials) OAuth, not delegated/user OAuth: this connector is a
single ops-configured connection shared across the workspace (same trust model as
the PAT today), not a per-user "sign in with Microsoft" flow. The Azure AD app
must be granted the "Azure DevOps" API permission
(499b84ac-1321-427f-aa17-267ca6975798/.default) with admin consent, and the
service principal must be added as a member of the ADO organization.

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

import time
from dataclasses import dataclass, field
from typing import Protocol

import httpx

from app.core.config import settings
from app.services.connectors.types import ConnectorError

# Azure DevOps' resource ID in the Microsoft identity platform — the ".default"
# scope requests whatever API permissions are configured on the Azure AD app.
_ADO_RESOURCE_SCOPE = "499b84ac-1321-427f-aa17-267ca6975798/.default"


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
