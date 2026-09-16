"""GitHub App auth (Issue 10.3, GitHub Marketplace listing) — mirrors
jira_auth.py's Atlassian Connect shape: an installable app any GitHub org/user
admin can add without a prior SpecMate account, a claim step links the
install to a workspace afterward. Genuinely different from Jira Connect's
JWT, though: GitHub App JWTs are RS256 (asymmetric, signed with a private key
generated once at App registration — never sent anywhere), and they're not
used directly against the Issues API. Instead the JWT authenticates ONE call
(`POST /app/installations/{id}/access_tokens`) that mints a short-lived
(1 hour) installation access token, which IS what goes on every subsequent
API request. That token is minted on demand and cached in memory (never
persisted — a fresh mint costs one cheap API call and avoids storing a
sensitive short-lived secret at all).
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import TYPE_CHECKING

import httpx
import jwt as pyjwt

from app.core.config import settings
from app.services.connectors.github_auth import _DEFAULT_BASE_URL
from app.services.connectors.types import ConnectorError

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

# Installation tokens expire in 1 hour; refresh a little early to avoid a
# request racing against the exact expiry instant.
_TOKEN_REFRESH_MARGIN_SECONDS = 60


def _app_jwt() -> str:
    if not (settings.github_app_id and settings.github_app_private_key):
        raise ConnectorError("GitHub App is not configured — set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY.")
    now = int(time.time())
    claims = {
        "iat": now - 60,  # backdated by 60s: tolerates minor clock drift between SpecMate and GitHub
        "exp": now + 570,  # GitHub caps App JWTs at 10 minutes; stay comfortably under
        "iss": settings.github_app_id,
    }
    return pyjwt.encode(claims, settings.github_app_private_key, algorithm="RS256")


async def mint_installation_token(installation_id: int) -> tuple[str, float]:
    """Exchanges the App's own JWT for a short-lived installation access
    token. Returns (token, expires_at_epoch_seconds). Raises ConnectorError
    on any failure — an invalid/suspended installation, a misconfigured App,
    or a network error all surface the same way to callers."""
    token = _app_jwt()
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.post(
                f"{_DEFAULT_BASE_URL}/app/installations/{installation_id}/access_tokens",
                headers={
                    "Authorization": f"Bearer {token}",
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
            )
    except httpx.HTTPError as exc:
        raise ConnectorError(f"GitHub App installation token request failed: {exc}") from exc
    if response.status_code != 201:
        raise ConnectorError(
            f"GitHub App installation token request failed: {response.status_code} {response.text}"
        )
    payload = response.json()
    access_token = payload.get("token")
    expires_at_str = payload.get("expires_at")
    if not access_token or not expires_at_str:
        raise ConnectorError("GitHub App installation token response was malformed.")
    # GitHub returns an ISO-8601 UTC timestamp like "2026-01-01T12:00:00Z" —
    # avoid a datetime dependency for one field, just parse epoch via time.
    import calendar
    from datetime import UTC, datetime

    expires_at_dt = datetime.strptime(expires_at_str, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)
    return str(access_token), calendar.timegm(expires_at_dt.utctimetuple())


class _InstallationTokenCache:
    """Process-local cache of minted installation tokens, keyed by
    installation_id — avoids re-minting a fresh token on every single
    request within its ~1hr validity window. Not persisted: a cold start
    (new revision, restart) just mints again, which is cheap and safe."""

    def __init__(self) -> None:
        self._tokens: dict[int, tuple[str, float]] = {}

    async def get(self, installation_id: int) -> str:
        cached = self._tokens.get(installation_id)
        if cached and cached[1] - _TOKEN_REFRESH_MARGIN_SECONDS > time.time():
            return cached[0]
        token, expires_at = await mint_installation_token(installation_id)
        self._tokens[installation_id] = (token, expires_at)
        return token


_installation_token_cache = _InstallationTokenCache()


@dataclass(frozen=True)
class InstallationTokenConnection:
    """Satisfies the GitHubConnection Protocol using a per-installation
    access token, transparently minted/cached by installation_id. Unlike
    TokenConnection/OAuthTokenConnection (a static Bearer token known at
    construction time), this connection's headers() call must be async to
    mint-or-reuse the token — but GitHubConnection.headers() is sync, so the
    token is resolved once by the caller (resolve_github_app_connection) and
    passed in frozen, same as every other connection type. A caller that
    holds this connection across more than ~55 minutes should re-resolve it;
    publish/discovery flows are all short-lived single-request-response
    cycles, so this is not a practical concern today."""

    token: str
    installation_id: int
    base_url_: str = _DEFAULT_BASE_URL

    def base_url(self) -> str:
        return self.base_url_

    def headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }

    def repos_discovery_url(self) -> str:
        return f"{self.base_url()}/installation/repositories"


async def resolve_installation_connection(installation_id: int) -> InstallationTokenConnection:
    token = await _installation_token_cache.get(installation_id)
    return InstallationTokenConnection(token=token, installation_id=installation_id)


async def get_claimed_installation_id(session: "AsyncSession", workspace_id: str) -> int | None:
    """Looks up the claimed, active GitHubAppInstall for a workspace, if any.
    Returns None (not an error) when no claimed install exists — callers
    treat that as "fall through to the next auth method", same as
    resolve_jira_connection/resolve_ado_connection's Connect-install checks."""
    from sqlalchemy import select

    from app.models import GitHubAppInstall

    result = await session.execute(
        select(GitHubAppInstall.installationId).where(
            GitHubAppInstall.workspaceId == workspace_id,
            GitHubAppInstall.uninstalledAt.is_(None),
            GitHubAppInstall.suspendedAt.is_(None),
        )
    )
    row = result.scalar_one_or_none()
    return int(row) if row is not None else None
