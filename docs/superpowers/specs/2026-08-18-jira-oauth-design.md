# Real per-user Jira OAuth — design

Fast-follow to Issue #101 (guided connector setup wizard), which built real per-workspace OAuth for GitHub only and explicitly deferred Jira/ADO. This closes the Jira half of that deferral. ADO stays on its existing app-only client-credentials auth — filed separately, not touched here.

## Context

Today, connecting Jira requires an ops engineer to manually set `JIRA_BASE_URL`/`ATLASSIAN_EMAIL`/`ATLASSIAN_API_TOKEN` as Container Apps secrets — single-tenant, shared across every workspace, and requires editing Azure config by hand (as happened live in this session: a malformed `JIRA_BASE_URL` secret broke every workspace's Jira connection at once, since there's only one). A workspace admin should instead connect their own Jira account through the wizard UI, the same way GitHub's OAuth step already works, storing the resulting credential per-workspace.

## Decisions (confirmed with the user)

1. **Jira only, ADO stays a fast-follow** — matches Issue #101's original scoping rationale: don't grow into a 3-tool project at once.
2. **Atlassian Developer Console app registration is a manual step the user does separately** — this codebase reads the resulting client ID/secret via env config, same pattern as GitHub's `GITHUB_OAUTH_APP_CLIENT_ID`/`SECRET`. Not built by this work.
3. **No Jira URL input at all.** Jira Cloud OAuth 3LO authenticates through a `cloudId`-keyed gateway (`https://api.atlassian.com/ex/jira/{cloudId}/...`), discovered via Atlassian's `accessible-resources` API after token exchange — not the org's own `*.atlassian.net` domain. This directly satisfies "don't make the user type/store a URL."
4. **Refresh token storage**: encrypt `{access_token, refresh_token, expires_at}` as JSON into the existing `Connection.encryptedCredentials` column — no schema change. `cloud_id`/`cloud_url` go into the existing `Connection.scope` JSON column — also no schema change.

## Why Jira OAuth is structurally different from GitHub's (already built)

|                         | GitHub (built)            | Jira (this work)                                                                             |
| ----------------------- | ------------------------- | -------------------------------------------------------------------------------------------- |
| Token lifetime          | Does not expire           | ~1 hour; refresh token required                                                              |
| Refresh token           | N/A                       | Rotates on every use — an unrefreshed one goes stale                                         |
| API base URL            | `api.github.com` (fixed)  | `api.atlassian.com/ex/jira/{cloudId}` — `cloudId` is per-grant, discovered post-auth         |
| Credential shape stored | Bare token string         | JSON blob (access + refresh + expiry)                                                        |
| Scope-picker step       | Repo full name, free text | Site (`cloudId`) picker if the user granted access to >1 Jira site — otherwise auto-selected |

## Design

### `JiraOAuthConnection` — `apps/api/app/services/connectors/jira_auth.py`

```python
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
        return _BearerAuth(self.access_token)

    def api_version(self) -> str:
        return "3"


class _BearerAuth(httpx.Auth):
    def __init__(self, token: str) -> None:
        self._token = token

    def auth_flow(self, request: httpx.Request):
        request.headers["Authorization"] = f"Bearer {self._token}"
        yield request
```

Static (not self-refreshing like ADO's `_OAuthBearerAuth`) — refresh happens explicitly in `resolve_jira_connection()` _before_ constructing this object, since a rotated refresh token must be written back to the DB, which an `httpx.Auth.auth_flow()` generator can't cleanly do mid-request.

### Token exchange + refresh — new functions in `jira_auth.py`

```python
async def exchange_oauth_code_for_tokens(code: str, redirect_uri: str) -> JiraOAuthTokens:
    """POST https://auth.atlassian.com/oauth/token, grant_type=authorization_code.
    Returns {access_token, refresh_token, expires_in}."""

async def refresh_jira_access_token(refresh_token: str) -> JiraOAuthTokens:
    """POST https://auth.atlassian.com/oauth/token, grant_type=refresh_token.
    Atlassian rotates the refresh token on every use — callers MUST persist
    the new refresh_token, not just the new access_token, or the next refresh
    attempt fails with an invalidated token."""

async def discover_accessible_jira_sites(access_token: str) -> list[JiraSite]:
    """GET https://api.atlassian.com/oauth/token/accessible-resources.
    Returns [{id (=cloudId), url, name, scopes}, ...] — the Jira sites this
    grant covers. Wizard auto-selects if len == 1, else the wizard's
    select-scope step lists them for the user to pick."""
```

`JiraOAuthTokens` / `JiraSite`: small frozen dataclasses, same shape convention as `discovery_types.py`'s existing dataclasses.

### `resolve_jira_connection(session, workspace_id)` — replaces `get_jira_connection()` at all 4 call sites

```python
async def resolve_jira_connection(session: AsyncSession, workspace_id: str) -> JiraConnection:
    row = (await session.execute(
        select(Connection).where(Connection.workspaceId == workspace_id, Connection.toolKey == "jira")
    )).scalar_one_or_none()
    if row and row.authMethod == "OAUTH" and row.encryptedCredentials:
        tokens = json.loads(decrypt_credentials(row.encryptedCredentials))
        if _is_expired(tokens["expires_at"]):
            fresh = await refresh_jira_access_token(tokens["refresh_token"])
            tokens = {"access_token": fresh.access_token, "refresh_token": fresh.refresh_token,
                      "expires_at": fresh.expires_at}
            row.encryptedCredentials = encrypt_credentials(json.dumps(tokens))
            row.updatedAt = _now()
            await session.commit()
        cloud_id = (row.scope or {}).get("cloud_id")
        return JiraOAuthConnection(access_token=tokens["access_token"], cloud_id=cloud_id)
    return get_jira_connection()  # existing env-configured fallback, unchanged
```

Call sites updated (all 4 already have `session` in scope; `workspace_id` resolved the same way Task 6 did for GitHub — via `project.workspaceId` where only `project_id` is directly available):

- `apps/api/app/routers/publish.py` — `PublishGateway.connection` becomes async + session/workspace-aware, mirroring `GitHubPublishGateway`'s Task 6 change exactly.
- `apps/api/app/routers/connectors.py` — `_resolve_connection()`'s Jira branch calls `resolve_jira_connection` instead of `get_jira_connection()`.
- `apps/api/app/routers/drift.py`, `apps/api/app/routers/flag_removed.py` — inline `get_jira_connection()` calls replaced with `await resolve_jira_connection(session, workspace_id)`, `workspace_id` resolved from the already-in-scope `project_id`.

### New router `apps/api/app/routers/jira_oauth.py` — mirrors `github_oauth.py` exactly

- `GET /connectors/jira/oauth/start?wizard_session_id=X` → redirects to `https://auth.atlassian.com/authorize` with `audience=api.atlassian.com`, `client_id`, `scope` (read/write Jira scopes + `offline_access` for the refresh token), `redirect_uri`, `state=wizard_session_id`, `response_type=code`, `prompt=consent`.
- `GET /connectors/jira/oauth/callback?code=...&state=...` → looks up `WizardSession` by `state` (404 if missing/expired, same as GitHub's), exchanges the code, discovers accessible sites, auto-selects if exactly one site (stores `cloud_id`/`cloud_url` in `Connection.scope`, advances wizard step to `select_scope` if 1 site or a new intermediate step if >1 — see open question below), encrypts `{access_token, refresh_token, expires_at}`, upserts the `Connection` row with the same TOCTOU-safe catch-`IntegrityError`-and-retry-as-update pattern `github_oauth.py` already uses, redirects into the wizard UI.

### Registry — one-line change

```python
"jira": ConnectorDefinition(
    ...,
    auth_methods=["ENV_CONFIGURED", "OAUTH"],  # was ["ENV_CONFIGURED"]
    ...,
),
```

### Config — `apps/api/app/core/config.py`, `.env.example`

```python
jira_oauth_app_client_id: str = ""
jira_oauth_app_client_secret: str = ""
```

Named with the same `_APP_` infix discipline Issue #101 established for GitHub (`GITHUB_OAUTH_APP_CLIENT_ID`, distinct from Issue #95's unrelated `GITHUB_OAUTH_CLIENT_ID` used for SpecMate user login) — though Jira has no naming-collision risk today, keeping the convention consistent.

### Frontend — `apps/web`'s `authenticate.tsx` wizard step

Currently hardcodes the OAuth branch to GitHub only (`/api/connectors/github/oauth/start`) — flagged in that file's own comment as needing generalization once a second OAuth connector exists. This work generalizes it: read the OAuth start URL from the tool key (`/api/connectors/{toolKey}/oauth/start`) instead of a hardcoded GitHub path. Needs a matching `apps/web` proxy route `GET /api/connectors/jira/oauth/start` (redirect-passthrough, mirrors the existing GitHub one).

## Multi-site accounts (confirmed with the user)

If `discover_accessible_jira_sites` returns more than one site (a user with access to multiple Jira Cloud instances), the callback auto-selects `sites[0]` and proceeds — no new wizard step in this pass. Most users have exactly one Jira Cloud site. A proper site-picker for multi-site accounts is an explicit fast-follow, filed as a separate issue once this ships, not guessed at here.

## Files touched

```
apps/api/app/services/connectors/jira_auth.py     # +JiraOAuthConnection, +_BearerAuth, +exchange/refresh/discover fns, +resolve_jira_connection
apps/api/app/routers/jira_oauth.py                 # new — mirrors github_oauth.py
apps/api/app/routers/publish.py                    # PublishGateway.connection -> async/session-aware (mirrors Task 6)
apps/api/app/routers/connectors.py                 # _resolve_connection's jira branch
apps/api/app/routers/drift.py                       # get_jira_connection() -> resolve_jira_connection(session, workspace_id)
apps/api/app/routers/flag_removed.py                 # same
apps/api/app/services/connectors/registry.py         # jira auth_methods += "OAUTH"
apps/api/app/core/config.py                          # +jira_oauth_app_client_id/secret
apps/api/.env.example                                 # documented, blank
apps/api/app/main.py                                   # register jira_oauth router
apps/web/.../connect/[toolKey]/steps/authenticate.tsx   # generalize hardcoded GitHub OAuth path
apps/web/src/app/api/connectors/[toolKey]/oauth/start/route.ts  # new (or generalize the existing github-specific one)
architecture.md                                         # document the Jira OAuth addition
Tests: unit tests for token exchange/refresh (mirroring test_github_oauth.py's service-level tests),
       router tests for start/callback (mirroring test_github_oauth.py's router-level tests),
       resolve_jira_connection tests (mirroring test_connection_resolution.py),
       regression: full existing Jira publish/drift/flag-removed test suites must pass unchanged.
```

## Explicitly out of scope

- ADO OAuth upgrade (separate fast-follow, per user decision).
- Jira Server/Data Center OAuth (this codebase has no Server/DC support at all yet — Cloud only, per the existing `jira_auth.py` module docstring).
- Multi-site Jira account UI (see open question — likely auto-select-first for this pass).
- Any change to actual publish/discovery/hierarchy logic — this is purely a connection-resolution/auth change, `JiraConnection` Protocol methods are unchanged, so `jira_publish.py`'s existing logic needs zero modification.
