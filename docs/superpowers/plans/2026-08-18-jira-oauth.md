# Real per-user Jira OAuth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Jira's single-tenant, ops-configured env-var credentials with real per-workspace OAuth 3LO, following the exact pattern Issue #101 already built and proved for GitHub — no Jira URL for the user to type or store, tokens encrypted per-workspace, transparent refresh on expiry.

**Architecture:** New `JiraOAuthConnection` implementing the existing `JiraConnection` Protocol; a new `jira_oauth.py` router mirroring `github_oauth.py`'s start/callback shape; a new `resolve_jira_connection(session, workspace_id)` replacing all 4 existing `get_jira_connection()` call sites, falling back to the unchanged env-configured path; registry's `jira` entry gains `"OAUTH"`; frontend wizard's hardcoded GitHub-only OAuth branch generalized to read the tool key.

**Tech Stack:** FastAPI/SQLAlchemy (apps/api), Next.js/TypeScript (apps/web), Atlassian OAuth 2.0 3LO, existing `Connection`/`WizardSession` models and envelope encryption (`app/services/crypto.py`) — no schema changes.

---

## Task 1: Token exchange, refresh, and site-discovery functions

**Files:**

- Modify: `apps/api/app/services/connectors/jira_auth.py`
- Test: `apps/api/tests/services/test_jira_oauth.py` (new)

- [ ] **Step 1: Write the failing tests**

```python
"""Jira OAuth 3LO token exchange/refresh/site-discovery (fast-follow to
Issue #101) — mirrors test_github_oauth.py's service-level test shape."""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import httpx
import pytest

from app.core.config import settings
from app.services.connectors.jira_auth import (
    discover_accessible_jira_sites,
    exchange_oauth_code_for_tokens,
    refresh_jira_access_token,
)
from app.services.connectors.types import ConnectorError


class _FakeTokenResponse:
    status_code = 200

    def json(self) -> dict[str, object]:
        return {
            "access_token": "jira_access_token_value",
            "refresh_token": "jira_refresh_token_value",
            "expires_in": 3600,
        }

    def raise_for_status(self) -> None:
        pass


@pytest.mark.asyncio
async def test_exchange_oauth_code_for_tokens_returns_access_and_refresh_token() -> None:
    with (
        patch.object(settings, "jira_oauth_app_client_id", "test-client-id"),
        patch.object(settings, "jira_oauth_app_client_secret", "test-secret"),
        patch("httpx.AsyncClient.post", new=AsyncMock(return_value=_FakeTokenResponse())),
    ):
        tokens = await exchange_oauth_code_for_tokens("fake-code", "https://example.com/callback")
    assert tokens.access_token == "jira_access_token_value"
    assert tokens.refresh_token == "jira_refresh_token_value"
    assert tokens.expires_in == 3600


@pytest.mark.asyncio
async def test_exchange_oauth_code_for_tokens_raises_if_not_configured() -> None:
    with (
        patch.object(settings, "jira_oauth_app_client_id", ""),
        patch.object(settings, "jira_oauth_app_client_secret", ""),
    ):
        with pytest.raises(ConnectorError):
            await exchange_oauth_code_for_tokens("some-code", "https://example.com/callback")


@pytest.mark.asyncio
async def test_exchange_oauth_code_for_tokens_wraps_http_errors() -> None:
    fake_response = httpx.Response(
        status_code=400, request=httpx.Request("POST", "https://auth.atlassian.com/oauth/token")
    )
    with (
        patch.object(settings, "jira_oauth_app_client_id", "test-client-id"),
        patch.object(settings, "jira_oauth_app_client_secret", "test-secret"),
        patch(
            "httpx.AsyncClient.post",
            new=AsyncMock(side_effect=httpx.HTTPStatusError("bad request", request=fake_response.request, response=fake_response)),
        ),
    ):
        with pytest.raises(ConnectorError):
            await exchange_oauth_code_for_tokens("expired-code", "https://example.com/callback")


@pytest.mark.asyncio
async def test_refresh_jira_access_token_returns_rotated_tokens() -> None:
    with (
        patch.object(settings, "jira_oauth_app_client_id", "test-client-id"),
        patch.object(settings, "jira_oauth_app_client_secret", "test-secret"),
        patch("httpx.AsyncClient.post", new=AsyncMock(return_value=_FakeTokenResponse())),
    ):
        tokens = await refresh_jira_access_token("old-refresh-token")
    assert tokens.access_token == "jira_access_token_value"
    assert tokens.refresh_token == "jira_refresh_token_value"


class _FakeSitesResponse:
    status_code = 200

    def json(self) -> list[dict[str, object]]:
        return [
            {"id": "cloud-id-1", "url": "https://acme.atlassian.net", "name": "Acme", "scopes": ["read:jira-work"]},
        ]

    def raise_for_status(self) -> None:
        pass


@pytest.mark.asyncio
async def test_discover_accessible_jira_sites_returns_parsed_sites() -> None:
    with patch("httpx.AsyncClient.get", new=AsyncMock(return_value=_FakeSitesResponse())):
        sites = await discover_accessible_jira_sites("fake-access-token")
    assert len(sites) == 1
    assert sites[0].cloud_id == "cloud-id-1"
    assert sites[0].url == "https://acme.atlassian.net"


@pytest.mark.asyncio
async def test_discover_accessible_jira_sites_raises_on_empty_list() -> None:
    class _EmptyResponse:
        status_code = 200

        def json(self) -> list[dict[str, object]]:
            return []

        def raise_for_status(self) -> None:
            pass

    with patch("httpx.AsyncClient.get", new=AsyncMock(return_value=_EmptyResponse())):
        with pytest.raises(ConnectorError):
            await discover_accessible_jira_sites("fake-access-token")
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/api && uv run pytest tests/services/test_jira_oauth.py -v
```

Expected: `ModuleNotFoundError`/`ImportError` — the functions don't exist yet.

- [ ] **Step 3: Add `jira_oauth_app_client_id`/`jira_oauth_app_client_secret` to Settings**

In `apps/api/app/core/config.py`, add right after the existing `github_oauth_app_client_id`/`github_oauth_app_client_secret` fields:

```python
    # Atlassian OAuth App (fast-follow to Issue #101) — for per-workspace
    # delegated Jira connector auth, distinct from JIRA_BASE_URL/
    # ATLASSIAN_EMAIL/ATLASSIAN_API_TOKEN (the existing single-tenant
    # env-configured fallback, kept unchanged). Register at
    # https://developer.atlassian.com/console/myapps/ with OAuth 2.0 (3LO),
    # scopes read:jira-work + write:jira-work + offline_access, callback URL
    # {this API's own external URL}/connectors/jira/oauth/callback.
    jira_oauth_app_client_id: str = ""
    jira_oauth_app_client_secret: str = ""
    # This API's own externally-reachable base URL (Atlassian calls the Jira
    # OAuth redirect_uri directly, unlike GitHub's OAuth flow, whose
    # redirect_uri is configured once in the GitHub OAuth App's settings and
    # never sent by SpecMate at request time). specmate-api's Container App
    # ingress is currently internal-only — see Task 3's open infrastructure
    # question about whether ingress needs to become external, or the
    # callback should route through apps/web's proxy instead, before this
    # setting's production value can be finalized.
    api_base_url_external: str = "http://localhost:8000"
```

Add matching blank entries to `apps/api/.env.example` right after the existing `GITHUB_OAUTH_APP_CLIENT_ID`/`SECRET` block (`JIRA_OAUTH_APP_CLIENT_ID`, `JIRA_OAUTH_APP_CLIENT_SECRET`, `API_BASE_URL_EXTERNAL`), with a comment pointing at the Atlassian Developer Console and flagging the ingress question for `API_BASE_URL_EXTERNAL`.

- [ ] **Step 4: Add the token/site dataclasses and functions to `jira_auth.py`**

Add near the top of the file, after the existing imports (add `import time`, `import httpx` is already imported):

```python
from dataclasses import dataclass as _dataclass  # already imported as `dataclass` above; reuse it
```

(No new import needed — `dataclass` is already imported.) Add after the existing `CloudTokenConnection` class:

```python
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
    sites = [
        JiraSite(cloud_id=r["id"], url=r["url"], name=r["name"]) for r in response.json()
    ]
    if not sites:
        raise ConnectorError(
            "This Atlassian account has no accessible Jira site — grant access to at least one Jira Cloud site."
        )
    return sites
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd apps/api && uv run pytest tests/services/test_jira_oauth.py -v
```

- [ ] **Step 6: Full suite, typecheck, lint**

```bash
cd apps/api
uv run pytest -q
uv run mypy app
uv run ruff check .
```

- [ ] **Step 7: Commit**

```bash
git add app/core/config.py app/services/connectors/jira_auth.py .env.example tests/services/test_jira_oauth.py
git commit -m "Add Jira OAuth 3LO token exchange/refresh/site-discovery (fast-follow to #101)"
```

---

## Task 2: `JiraOAuthConnection` + `resolve_jira_connection`

**Files:**

- Modify: `apps/api/app/services/connectors/jira_auth.py`
- Test: `apps/api/tests/services/test_jira_connection_resolution.py` (new)

- [ ] **Step 1: Write the failing tests**

```python
"""Per-workspace Jira connection resolution (fast-follow to Issue #101) —
mirrors test_connection_resolution.py's GitHub-side test shape exactly."""
from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime, timedelta
from unittest.mock import patch

from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.core.config import settings
from app.models import Connection, Workspace
from app.services.connectors.jira_auth import (
    CloudTokenConnection,
    JiraOAuthConnection,
    resolve_jira_connection,
)
from app.services.crypto import encrypt_credentials

_TEST_DEK_B64 = "MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA="


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


async def _create_workspace_async() -> str:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            workspace = Workspace(name="Jira Resolution Test WS", createdAt=_now(), updatedAt=_now())
            session.add(workspace)
            await session.flush()
            workspace_id = workspace.id
            await session.commit()
            return workspace_id
    finally:
        await engine.dispose()


def _create_workspace() -> str:
    return asyncio.run(_create_workspace_async())


async def _cleanup_async(workspace_id: str) -> None:
    from sqlalchemy import delete

    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            await session.execute(delete(Connection).where(Connection.workspaceId == workspace_id))
            await session.execute(delete(Workspace).where(Workspace.id == workspace_id))
            await session.commit()
    finally:
        await engine.dispose()


def _cleanup(workspace_id: str) -> None:
    asyncio.run(_cleanup_async(workspace_id))


async def _add_connection_async(
    workspace_id: str, auth_method: str, tokens: dict[str, object] | None, cloud_id: str | None
) -> None:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            now = _now()
            with patch.object(settings, "connector_dek_b64", _TEST_DEK_B64):
                encrypted = encrypt_credentials(json.dumps(tokens)) if tokens else None
            session.add(
                Connection(
                    workspaceId=workspace_id,
                    toolKey="jira",
                    authMethod=auth_method,
                    encryptedCredentials=encrypted,
                    scope={"cloud_id": cloud_id} if cloud_id else None,
                    createdAt=now,
                    updatedAt=now,
                )
            )
            await session.commit()
    finally:
        await engine.dispose()


def _add_connection(
    workspace_id: str, auth_method: str, tokens: dict[str, object] | None = None, cloud_id: str | None = None
) -> None:
    asyncio.run(_add_connection_async(workspace_id, auth_method, tokens, cloud_id))


async def _resolve_async(workspace_id: str) -> object:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            return await resolve_jira_connection(session, workspace_id)
    finally:
        await engine.dispose()


def _resolve(workspace_id: str) -> object:
    return asyncio.run(_resolve_async(workspace_id))


def test_resolve_with_no_connection_row_falls_back_to_env_configured() -> None:
    workspace_id = _create_workspace()
    try:
        with (
            patch.object(settings, "jira_base_url", "https://example.atlassian.net"),
            patch.object(settings, "atlassian_email", "bot@example.com"),
            patch.object(settings, "atlassian_api_token", "env-token"),
        ):
            connection = _resolve(workspace_id)
        assert isinstance(connection, CloudTokenConnection)
        assert connection.url == "https://example.atlassian.net"
    finally:
        _cleanup(workspace_id)


def test_resolve_with_oauth_connection_returns_unexpired_token_without_refreshing() -> None:
    workspace_id = _create_workspace()
    try:
        future_expiry = (_now() + timedelta(hours=1)).timestamp()
        _add_connection(
            workspace_id,
            auth_method="OAUTH",
            tokens={"access_token": "fresh-token", "refresh_token": "refresh-1", "expires_at": future_expiry},
            cloud_id="cloud-id-abc",
        )
        with patch.object(settings, "connector_dek_b64", _TEST_DEK_B64):
            connection = _resolve(workspace_id)
        assert isinstance(connection, JiraOAuthConnection)
        assert connection.access_token == "fresh-token"
        assert connection.cloud_id == "cloud-id-abc"
    finally:
        _cleanup(workspace_id)


def test_resolve_with_expired_oauth_connection_refreshes_and_persists_rotated_tokens() -> None:
    from unittest.mock import AsyncMock

    workspace_id = _create_workspace()
    try:
        past_expiry = (_now() - timedelta(minutes=5)).timestamp()
        _add_connection(
            workspace_id,
            auth_method="OAUTH",
            tokens={"access_token": "stale-token", "refresh_token": "refresh-1", "expires_at": past_expiry},
            cloud_id="cloud-id-abc",
        )
        from app.services.connectors.jira_auth import JiraOAuthTokens

        fresh_tokens = JiraOAuthTokens(access_token="rotated-token", refresh_token="refresh-2", expires_in=3600)
        with (
            patch.object(settings, "connector_dek_b64", _TEST_DEK_B64),
            patch(
                "app.services.connectors.jira_auth.refresh_jira_access_token",
                new=AsyncMock(return_value=fresh_tokens),
            ),
        ):
            connection = _resolve(workspace_id)
        assert isinstance(connection, JiraOAuthConnection)
        assert connection.access_token == "rotated-token"

        # Persisted: a second resolve (without mocking refresh) must NOT need
        # to refresh again, proving the rotated tokens were actually written back.
        async def _get_connection_async() -> Connection:
            engine = create_async_engine(settings.database_url)
            try:
                async with AsyncSession(engine) as session:
                    from sqlalchemy import select

                    return (
                        await session.execute(
                            select(Connection).where(Connection.workspaceId == workspace_id, Connection.toolKey == "jira")
                        )
                    ).scalar_one()
            finally:
                await engine.dispose()

        row = asyncio.run(_get_connection_async())
        with patch.object(settings, "connector_dek_b64", _TEST_DEK_B64):
            from app.services.crypto import decrypt_credentials

            persisted = json.loads(decrypt_credentials(row.encryptedCredentials))
        assert persisted["access_token"] == "rotated-token"
        assert persisted["refresh_token"] == "refresh-2"
    finally:
        _cleanup(workspace_id)
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/api && uv run pytest tests/services/test_jira_connection_resolution.py -v
```

- [ ] **Step 3: Add `JiraOAuthConnection` and `resolve_jira_connection` to `jira_auth.py`**

Add after `JiraSite`/the token functions from Task 1:

```python
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
        tokens: dict[str, object] = json.loads(decrypt_credentials(row.encryptedCredentials))
        if float(tokens["expires_at"]) <= time.time():
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
        cloud_id = (row.scope or {}).get("cloud_id")
        assert isinstance(cloud_id, str)
        return JiraOAuthConnection(access_token=str(tokens["access_token"]), cloud_id=cloud_id)
    return get_jira_connection()
```

Add `import json` and `from datetime import datetime, UTC` to the top of `jira_auth.py` if not already present (check first — `time` is already imported for `time.time()` used elsewhere in the file's JWT code).

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/api && uv run pytest tests/services/test_jira_connection_resolution.py -v
```

- [ ] **Step 5: Full suite, typecheck, lint**

```bash
cd apps/api
uv run pytest -q
uv run mypy app
uv run ruff check .
```

- [ ] **Step 6: Commit**

```bash
git add app/services/connectors/jira_auth.py tests/services/test_jira_connection_resolution.py
git commit -m "Add JiraOAuthConnection + resolve_jira_connection with token refresh (fast-follow to #101)"
```

---

## Task 3: `jira_oauth.py` router (start/callback)

**Files:**

- Create: `apps/api/app/routers/jira_oauth.py`
- Modify: `apps/api/app/main.py`
- Test: `apps/api/tests/routers/test_jira_oauth.py` (new)

- [ ] **Step 1: Read `apps/api/app/routers/github_oauth.py` in full** (already read during design — re-read live before writing, since this task's job is to mirror it precisely for Jira's extra fields: `cloud_id` in `Connection.scope`, JSON-blob `encryptedCredentials` instead of a bare token string).

- [ ] **Step 2: Write the failing tests** — mirror `tests/routers/test_github_oauth.py`'s structure exactly (same `_now`/`_dispose_app_engine`/`_create_wizard_session_async`+sync-wrapper helper-function-splitting convention documented in that file), covering:
  - `test_start_oauth_redirects_to_atlassian_with_expected_params` — asserts redirect to `https://auth.atlassian.com/authorize`, `audience=api.atlassian.com`, correct `client_id`/`scope`/`state`.
  - `test_start_oauth_returns_503_when_not_configured`
  - `test_callback_with_valid_session_creates_encrypted_connection_and_advances_step` — mocks `exchange_oauth_code_for_tokens` and `discover_accessible_jira_sites` (returning one site), asserts `Connection.authMethod == "OAUTH"`, `Connection.scope == {"cloud_id": "cloud-id-abc"}`, and that the raw access/refresh token strings are NOT present in `Connection.encryptedCredentials` bytes (same non-tautological check `test_github_oauth.py` already does).
  - `test_callback_with_unknown_state_returns_404`
  - `test_callback_with_expired_session_returns_404` — also asserts no `Connection` row was created.
  - `test_callback_called_twice_updates_existing_connection_not_duplicate` — same TOCTOU-safe upsert proof as GitHub's.
  - `test_callback_called_concurrently_results_in_exactly_one_connection` — same `asyncio.gather` real-concurrency proof `test_github_oauth.py` has (Issue #106-era hardening pattern), confirming the `IntegrityError`-catch-and-retry path.
  - `test_callback_auto_selects_first_site_when_multiple_are_accessible` — mocks `discover_accessible_jira_sites` returning 2 sites, asserts `Connection.scope["cloud_id"]` matches `sites[0].cloud_id` (locks in the confirmed auto-select-first design decision).

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd apps/api && uv run pytest tests/routers/test_jira_oauth.py -v
```

- [ ] **Step 4: Write the router**

```python
"""Jira OAuth 3LO authorization-code flow for per-workspace connector auth
(fast-follow to Issue #101) — the wizard's Jira OAuth step. Mirrors
github_oauth.py's shape; the two real differences are (1) Jira access tokens
expire and need a stored refresh token, so encryptedCredentials holds a JSON
blob {access_token, refresh_token, expires_at} rather than a bare token
string, and (2) Jira has no fixed API host — the accessible-resources lookup
after token exchange discovers the cloudId gateway URL, stored in
Connection.scope rather than assumed from user input."""

from __future__ import annotations

import json
import time
from datetime import UTC, datetime
from typing import Annotated
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import RedirectResponse
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.db import get_db_session
from app.models import Connection, WizardSession
from app.services.connectors.jira_auth import (
    discover_accessible_jira_sites,
    exchange_oauth_code_for_tokens,
)
from app.services.connectors.types import ConnectorError
from app.services.crypto import encrypt_credentials

router = APIRouter()

_JIRA_OAUTH_SCOPES = "read:jira-work write:jira-work offline_access"


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _jira_redirect_uri() -> str:
    # Atlassian calls this URL directly (unlike GitHub, whose redirect_uri is
    # configured once in the GitHub OAuth App's settings and never sent by
    # SpecMate) — needs this API's own externally-reachable URL, added as
    # settings.api_base_url_external in Task 1 Step 3.
    return settings.api_base_url_external + "/connectors/jira/oauth/callback"


@router.get("/connectors/jira/oauth/start")
async def start_jira_oauth(wizard_session_id: str) -> RedirectResponse:
    if not settings.jira_oauth_app_client_id:
        raise HTTPException(status_code=503, detail="Jira OAuth App is not configured.")
    params = urlencode(
        {
            "audience": "api.atlassian.com",
            "client_id": settings.jira_oauth_app_client_id,
            "scope": _JIRA_OAUTH_SCOPES,
            "redirect_uri": _jira_redirect_uri(),
            "state": wizard_session_id,
            "response_type": "code",
            "prompt": "consent",
        }
    )
    return RedirectResponse(f"https://auth.atlassian.com/authorize?{params}")


@router.get("/connectors/jira/oauth/callback")
async def jira_oauth_callback(
    code: str,
    state: str,
    session: Annotated[AsyncSession, Depends(get_db_session)],
) -> RedirectResponse:
    wizard_session = await session.get(WizardSession, state)
    now = _now()
    if not wizard_session or wizard_session.expiresAt < now:
        raise HTTPException(status_code=404, detail="Wizard session not found or expired.")

    try:
        tokens = await exchange_oauth_code_for_tokens(code, _jira_redirect_uri())
        sites = await discover_accessible_jira_sites(tokens.access_token)
    except ConnectorError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    # Auto-select the first accessible site — most users have exactly one
    # Jira Cloud site; a proper multi-site picker is an explicit fast-follow
    # (confirmed with the user during design, not guessed at here).
    cloud_id = sites[0].cloud_id

    credentials_json = json.dumps(
        {
            "access_token": tokens.access_token,
            "refresh_token": tokens.refresh_token,
            "expires_at": time.time() + tokens.expires_in,
        }
    )
    encrypted = encrypt_credentials(credentials_json)
    scope = {"cloud_id": cloud_id, "cloud_url": sites[0].url}

    existing = (
        await session.execute(
            select(Connection).where(
                Connection.workspaceId == wizard_session.workspaceId,
                Connection.toolKey == "jira",
            )
        )
    ).scalar_one_or_none()
    if existing:
        existing.authMethod = "OAUTH"
        existing.encryptedCredentials = encrypted
        existing.scope = scope
        existing.updatedAt = now
        wizard_session.currentStep = "select_scope"
        await session.commit()
    else:
        session.add(
            Connection(
                workspaceId=wizard_session.workspaceId,
                toolKey="jira",
                authMethod="OAUTH",
                encryptedCredentials=encrypted,
                scope=scope,
                createdAt=now,
                updatedAt=now,
            )
        )
        wizard_session.currentStep = "select_scope"
        workspace_id = wizard_session.workspaceId
        try:
            await session.commit()
        except IntegrityError:
            await session.rollback()
            winner = (
                await session.execute(
                    select(Connection).where(
                        Connection.workspaceId == workspace_id,
                        Connection.toolKey == "jira",
                    )
                )
            ).scalar_one()
            winner.authMethod = "OAUTH"
            winner.encryptedCredentials = encrypted
            winner.scope = scope
            winner.updatedAt = now
            wizard_session = await session.get(WizardSession, state)
            assert wizard_session is not None
            wizard_session.currentStep = "select_scope"
            await session.commit()

    redirect_url = (
        f"{settings.web_base_url}/workspaces/{wizard_session.workspaceId}"
        f"/projects/{wizard_session.projectId}/connect/jira?oauth=success"
    )
    return RedirectResponse(redirect_url)
```

**`settings.api_base_url_external`** (used above) is added in Task 1 Step 3, alongside the OAuth app client ID/secret — see that step for the config addition. **Open infrastructure question, not resolved by this plan**: Atlassian calls the Jira OAuth `redirect_uri` directly, which needs this API's own externally-reachable URL. `specmate-api`'s Container App ingress is currently `external: false` (internal-only, confirmed during this plan's own research) — GitHub's OAuth flow never needed this, since GitHub's `redirect_uri` is configured once in the GitHub OAuth App's settings and never sent by SpecMate at request time. Before this task ships to production, confirm with the user whether to (a) make `specmate-api`'s ingress external, or (b) route the Jira OAuth callback through `apps/web`'s already-external ingress via a proxy route (mirroring how the web app already proxies other API calls) instead of hitting `specmate-api` directly. Do not silently flip ingress to external without that confirmation.

- [ ] **Step 5: Register the router in `apps/api/app/main.py`**

Add `jira_oauth` to the `from app.routers import (...)` list and `app.include_router(jira_oauth.router)` right after `app.include_router(github_oauth.router)`.

- [ ] **Step 6: Run tests to verify they pass, full suite, typecheck, lint**

```bash
cd apps/api
uv run pytest -q
uv run mypy app
uv run ruff check .
```

- [ ] **Step 7: Commit**

```bash
git add app/routers/jira_oauth.py app/main.py app/core/config.py .env.example tests/routers/test_jira_oauth.py
git commit -m "Add Jira OAuth start/callback router with Connection storage (fast-follow to #101)"
```

---

## Task 4: Wire `resolve_jira_connection` into publish/discovery/drift/flag-removed

**Files:**

- Modify: `apps/api/app/routers/publish.py`
- Modify: `apps/api/app/routers/connectors.py`
- Modify: `apps/api/app/routers/drift.py`
- Modify: `apps/api/app/routers/flag_removed.py`
- Modify: `apps/api/app/services/connectors/registry.py`
- Test: extend `apps/api/tests/routers/test_publish.py`, `test_drift.py`, `test_flag_removed.py`

- [ ] **Step 1: `publish.py` — mirror Task 6's GitHub change exactly**

Read `apps/api/app/routers/publish.py`'s current `PublishGateway.connection` field and all 4 `gateway.connection()` call sites (lines ~97, 108, 131, 348 as of this plan's writing — confirm exact line numbers live, they shift as the file changes). Change:

```python
async def _resolve_connection(session: AsyncSession, workspace_id: str) -> JiraConnection:
    return await resolve_jira_connection(session, workspace_id)


@dataclass
class PublishGateway:
    connection: Callable[[AsyncSession, str], Awaitable[JiraConnection]] = _resolve_connection
    ...
```

Update each of the 4 call sites from `gateway.connection()` to `await gateway.connection(session, workspace.id)` (or `project.workspaceId` at call sites before `workspace` is resolved — check each site's local variable names, matching Task 6's exact approach for GitHub).

- [ ] **Step 2: `connectors.py` — one-line change**

```python
if tool_key == "jira":
    from app.services.connectors.jira_auth import resolve_jira_connection

    return await resolve_jira_connection(session, workspace_id)
```

Replaces the existing `get_jira_connection()` branch (remove the now-unused `get_jira_connection` import from this function if it's not used elsewhere in the file).

- [ ] **Step 3: `drift.py`**

`check_drift` already does `if await session.get(Project, project_id) is None: raise HTTPException(...)` — change this to capture the row: `project = await session.get(Project, project_id); if project is None: raise ...`. Change the Jira branch inside the per-item loop from `get_jira_connection()` to `await resolve_jira_connection(session, project.workspaceId)`. **Do not touch the ADO/GitHub branches in this file** — out of scope for this plan (GitHub's branch here still uses the old `get_github_connection()`, a pre-existing gap from Issue #101's Task 6 that this plan does not fix — noted, not silently patched).

- [ ] **Step 4: `flag_removed.py`**

The function already does `project = await session.get(Project, item.projectId)` but _after_ the tool-dispatch block that calls `get_jira_connection()`. Move that `project` lookup (and its `assert project is not None`) to _before_ the `try:`/tool-dispatch block, then change the Jira branch to `await resolve_jira_connection(session, project.workspaceId)`. **Do not touch the ADO/GitHub branches** — same out-of-scope note as `drift.py`.

- [ ] **Step 5: `registry.py` — one-line change**

```python
"jira": ConnectorDefinition(
    tool_key="jira",
    display_name="Jira",
    auth_methods=["ENV_CONFIGURED", "OAUTH"],  # was ["ENV_CONFIGURED"]
    ...
),
```

- [ ] **Step 6: Write/extend tests**

- `test_publish.py`: add a test mirroring `test_publish_github.py`'s connection-resolution regression coverage — a workspace with a stored OAuth `Connection` uses it for a real (faked-gateway) publish call; a workspace with no `Connection` row keeps using the env-configured fallback unchanged (critical regression guard — every existing Jira-publishing workspace has no `Connection` row).
- `test_drift.py`, `test_flag_removed.py`: add one test each confirming a workspace with a stored Jira OAuth `Connection` calls `resolve_jira_connection` (mock it, assert called with the right `workspace_id`) rather than the old env-configured path.

- [ ] **Step 7: Full suite, typecheck, lint — regression is the critical check here**

```bash
cd apps/api
uv run pytest -q
uv run mypy app
uv run ruff check .
```

Expected: **zero regressions in the existing Jira publish/drift/flag-removed test suites** — this is the safety net proving env-configured workspaces are unaffected, mirroring Task 6's own emphasis for GitHub.

- [ ] **Step 8: Commit**

```bash
git add app/routers/publish.py app/routers/connectors.py app/routers/drift.py app/routers/flag_removed.py app/services/connectors/registry.py tests/
git commit -m "Wire per-workspace Jira Connection resolution into publish/drift/flag-removed (fast-follow to #101)"
```

---

## Task 5: Frontend — generalize the wizard's OAuth branch beyond GitHub

**Files:**

- Modify: `apps/web/src/app/workspaces/[workspaceId]/projects/[projectId]/connect/[toolKey]/steps/authenticate.tsx`
- Create: `apps/web/src/app/api/connectors/jira/oauth/start/route.ts` (or generalize the existing GitHub-specific one into `[toolKey]/oauth/start/route.ts` — decide during implementation which is less disruptive; leaning toward a parallel Jira-specific route matching the existing GitHub one's exact shape, since generalizing risks touching working GitHub OAuth code unnecessarily)
- Test: extend `authenticate.test.tsx`

- [ ] **Step 0: Resolve the apps/web test-runner environment issue first**

Before writing any test in this task, confirm `cd apps/web && npx vitest run` passes cleanly in whatever worktree/environment this task executes in. During this plan's own design phase, a `DATABASE_URL`-not-found error was hit in a fresh git worktree that did not reproduce in the main working tree, root cause not resolved (ruled out: file content/encoding mismatch, Node version mismatch, hardcoded paths in the generated Prisma client). Do not proceed with Task 5 until `apps/web`'s test suite is confirmed green in the actual execution environment — this is an environment-setup blocker, not part of the Jira OAuth feature itself.

- [ ] **Step 1: Read `authenticate.tsx` in full** (already summarized during design: currently hardcodes `/api/connectors/github/oauth/start` in its OAuth branch, with its own comment flagging this as needing generalization once a second OAuth connector exists — that day is now).

- [ ] **Step 2: Write the failing test**

Extend `authenticate.test.tsx` with a case asserting that for a connector definition with `tool_key: "jira"` and `auth_methods: ["ENV_CONFIGURED", "OAUTH"]`, the rendered OAuth button's `window.location.href` assignment targets `/api/connectors/jira/oauth/start?wizard_session_id=...` (not a hardcoded `/api/connectors/github/...` path) — mirrors the existing GitHub-specific test in the same file, parameterized by tool key instead of hardcoded.

- [ ] **Step 3: Generalize `authenticate.tsx`'s OAuth branch**

Change the hardcoded:

```tsx
window.location.href = `/api/connectors/github/oauth/start?wizard_session_id=${encodeURIComponent(wizardSessionId)}`;
```

to:

```tsx
window.location.href = `/api/connectors/${toolKey}/oauth/start?wizard_session_id=${encodeURIComponent(wizardSessionId)}`;
```

(`toolKey` is already a prop available in this component per its existing signature — confirm exact prop name during implementation.)

- [ ] **Step 4: Create the Jira OAuth start proxy route**

Mirror `apps/web/src/app/api/connectors/github/oauth/start/route.ts` exactly (307-redirect passthrough to the real API), swapping the path segment to `jira`.

- [ ] **Step 5: Run tests, typecheck, lint**

```bash
cd apps/web
npx vitest run
npx tsc --noEmit
npx eslint "src/app/workspaces/[workspaceId]/projects/[projectId]/connect/" "src/app/api/connectors/"
```

- [ ] **Step 6: Manual smoke test**

Start both apps locally (`uv run uvicorn app.main:app --reload` in `apps/api`, `pnpm dev` in `apps/web`), with `JIRA_OAUTH_APP_CLIENT_ID`/`SECRET` unset — confirm the wizard's Jira authenticate step falls back cleanly to the `ENV_CONFIGURED` health-check path (since `auth_methods` will only show `"OAUTH"` as available once real Atlassian app credentials exist — until then, this task's frontend change must not break the existing env-configured flow for Jira, which is the majority case until the user registers their Atlassian app).

- [ ] **Step 7: Commit**

```bash
git add "src/app/workspaces/[workspaceId]/projects/[projectId]/connect/[toolKey]/steps/authenticate.tsx" "src/app/api/connectors/jira/"
git commit -m "Generalize wizard OAuth branch beyond GitHub; add Jira OAuth start proxy route (fast-follow to #101)"
```

---

## Task 6: Full regression, documentation, close out

**Files:** none beyond `architecture.md`

- [ ] **Step 1: Full regression, both apps**

```bash
cd apps/api && uv run pytest -q && uv run mypy app && uv run ruff check .
cd ../web && npx vitest run && npx tsc --noEmit && npx eslint .
```

- [ ] **Step 2: Manual smoke test — app boots, `/connectors` reflects Jira's new OAUTH auth method**

```bash
cd apps/api && uv run uvicorn app.main:app --port 8010 &
sleep 3
curl -s http://localhost:8010/health
curl -s http://localhost:8010/connectors | python3 -m json.tool  # confirm jira.auth_methods includes "OAUTH"
kill %1 2>/dev/null
```

- [ ] **Step 3: Update `architecture.md`**

Add a paragraph to the existing "Guided connector setup wizard" section (or a new short subsection immediately after it) documenting: Jira now has real per-workspace OAuth 3LO alongside GitHub's (from Issue #101); the `cloudId`-gateway design (no user-facing URL field); refresh-token rotation handling; auto-select-first-site for multi-site accounts with a note that a proper picker is a fast-follow; ADO remains on app-only client-credentials auth, explicitly not touched by this work.

- [ ] **Step 4: Commit**

```bash
git add architecture.md
git commit -m "Document real per-user Jira OAuth in architecture.md (fast-follow to #101)"
```

- [ ] **Step 5: Do NOT close any GitHub issue** — this work has no tracking issue yet (it originated from a live production support conversation, not a filed issue). Before merging, confirm with the user whether to file a tracking issue retroactively for records, or merge directly without one.

---

## Explicitly out of scope

- ADO's upgrade from app-only client-credentials to per-user delegated OAuth — separate fast-follow, not started here (per user's explicit scoping decision).
- Jira Server/Data Center OAuth — this codebase has no Server/DC support at all (Cloud only).
- Multi-site Jira account UI (a proper site picker when `discover_accessible_jira_sites` returns >1 site) — auto-select-first for this pass, confirmed with the user; file as a follow-up issue after this ships.
- The pre-existing gap where `flag_removed.py`'s GitHub branch still calls the old `get_github_connection()` instead of `resolve_github_connection()` — noticed during this plan's own research, explicitly not fixed here (GitHub-specific, out of this Jira-focused plan's scope; flag to the user as a candidate for its own small fix).
- Deciding whether `specmate-api`'s Container App ingress needs to become external (currently `external: false`) to receive Atlassian's OAuth callback directly, vs. routing the callback through `apps/web`'s already-external ingress — Task 3 flags this as a real open infrastructure question, not resolved by this plan; needs explicit confirmation before Task 3 ships to production.

## Self-review notes

- **Spec coverage**: all 4 confirmed decisions from the design spec are covered — Jira-only/ADO-deferred (whole plan), manual Atlassian app registration (Task 1's config fields + inline comment), no-URL-input via cloudId gateway (Task 1's `discover_accessible_jira_sites` + Task 2's `JiraOAuthConnection.base_url()`), JSON-blob refresh-token storage in the existing `encryptedCredentials` column (Task 2).
- **Type consistency**: `JiraOAuthTokens`/`JiraSite` (Task 1) are the exact shapes `resolve_jira_connection` (Task 2) and `jira_oauth.py` (Task 3) consume — no divergent shape introduced downstream.
- **Regression safety**: Task 4 Step 7 explicitly calls out zero regressions in existing Jira publish/drift/flag-removed suites as the critical check, mirroring Issue #101 Task 6's own emphasis.
- **Known gap surfaced, not silently fixed**: `flag_removed.py`'s stale GitHub connection resolution, discovered during this plan's research — called out explicitly in Task 4 Step 3 and the out-of-scope list rather than opportunistically fixed (would be scope creep and an unreviewed change to GitHub's already-shipped OAuth path).
- **Genuinely unresolved infrastructure question flagged, not guessed at**: Task 3's `redirect_uri`/API-external-ingress question is called out explicitly as needing confirmation before that task ships, rather than the plan silently assuming an ingress change.
- **Environment blocker surfaced**: Task 5 Step 0 requires resolving the apps/web worktree test-runner issue found during this plan's own worktree setup, before any frontend test is written against it.
