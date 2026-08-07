# Guided connector setup wizard (Issue #101) — design

## Context

Issue #101 asks for a tool-agnostic wizard shell for connecting Jira/ADO/GitHub (and future tools), backed by a connector registry, with permission-mismatch handling and a real test-connection step. The issue frames this as a retrofit of three existing, working connector settings pages.

## Current state (confirmed by reading the code)

- **The existing "wizard" isn't a wizard**: all three settings pages (`.../settings/publishing{,-ado,-github}/page.tsx` + client components) collapse connect + discover + save-mapping into a single button/API call. There is no separate auth step (auth is invisible env-configured credentials), no test-connection step (discovery and mapping-persist happen in the same request), and no scope picker (users free-type a project key/repo name; a `GET /connectors/{tool}/projects` discovery-list endpoint exists per tool but is unused by the UI).
- **No per-workspace connection storage exists**: confirmed via schema — the only connection-adjacent model is `AtlassianConnectInstall` (Jira Connect app installs, not wired into publishing). All three tools' actual publish credentials are single-tenant env vars (`ATLASSIAN_EMAIL`/`ATLASSIAN_API_TOKEN`, `ADO_ORG_URL`/`ADO_PAT`, `GITHUB_TOKEN`).
- **No real user-facing OAuth exists for any tool**: Jira has none (Connect app JWT is server-to-server, not OAuth); ADO has app-only client-credentials OAuth (not delegated/per-user); GitHub has PAT-only. architecture.md repeatedly documents "OAuth flows + per-workspace connection store: deferred" across Issues 5.1/6.1/7.1/10.2.
- **No encryption-at-rest pattern exists anywhere in this repo** for secrets stored in Postgres — confirmed during earlier research this session (Issue #92). Credentials today are Key-Vault/env only, never per-row.
- **Discovery response shapes are structurally different per tool, not a common shape**: Jira nests full field-requiredness data per issue type; ADO only returns the required-fields subset; GitHub has no type-system concept at all (labels/milestones/file-tree instead). No shared `DiscoveryResult` type exists.
- **Capability differences are already real and load-bearing in the code, but scattered**: each tool's `*_publish.py` independently hardcodes its own hierarchy-order, parent-link strategy, and type-suggestion/publishable-set logic — the same underlying "capability" concept exists 3 times over, never as a single registry-attached object.
- **No permission-mismatch or connection-request concept exists anywhere** — confirmed via repo-wide grep. Fully net-new.

## Scope decisions (from clarifying questions)

1. **Auth model**: build real per-workspace OAuth + encrypted credential storage — but for **GitHub only** in this issue (most standard OAuth support, no external app-registration dependency blocking progress). Jira and ADO continue on existing single-tenant env-configured auth, registered as a supported `authMethod` on the same registry interface, so the wizard shell genuinely serves all three tools today even though only GitHub gets OAuth now. Jira OAuth 2.0 3LO (needs an Atlassian Developer account + app registration — external dependency) and ADO's upgrade to delegated per-user OAuth are explicit fast-follow issues using this issue's proven pattern.
2. **Permission-mismatch handling**: build as a generic, tool-agnostic "request setup help" flow rather than deferring — triggered by GitHub OAuth consent failure/denial, or by env-configured discovery returning zero accessible projects/repos for Jira/ADO. Generates a shareable link with tool-specific instructions, tracked via a `ConnectionRequest` model with status (`SENT`/`COMPLETED`/`EXPIRED`).
3. **Credential encryption**: envelope encryption via Azure Key Vault — a data-encryption key fetched from Key Vault once per process (cached), used for AES-GCM encrypt/decrypt of stored OAuth tokens. Reuses existing provisioned infrastructure (Key Vault is live per Issue #103's deployment) rather than introducing a new KMS dependency.
4. **Wizard resume state**: a `WizardSession` Postgres row (no background infra, no polling) — created when the wizard starts, updated as the user progresses, OAuth's `state` param carries the session id so the callback resumes into the right row.

## Design

### 1. Connector registry — `apps/api/app/services/connectors/registry.py` (new)

```python
@dataclass(frozen=True)
class ConnectorCapabilities:
    supports_native_hierarchy: bool
    type_system: Literal["NAMED_TYPES", "PUBLISHABLE_SET"]  # Jira/ADO vs GitHub
    parent_link_strategy: Literal["NATIVE_FIELD", "NATIVE_RELATION", "TASK_LIST_BACKFILL"]

@dataclass(frozen=True)
class ConnectorDefinition:
    tool_key: str
    display_name: str
    auth_methods: list[Literal["ENV_CONFIGURED", "OAUTH"]]
    scope_picker_type: Literal["PROJECT_KEY", "PROJECT_NAME", "REPO_FULL_NAME"]
    discovery_fn: Callable[..., Awaitable[DiscoveryResult]]
    capabilities: ConnectorCapabilities

CONNECTOR_REGISTRY: dict[str, ConnectorDefinition] = {
    "jira": ConnectorDefinition(auth_methods=["ENV_CONFIGURED"], capabilities=ConnectorCapabilities(supports_native_hierarchy=True, type_system="NAMED_TYPES", parent_link_strategy="NATIVE_FIELD"), ...),
    "ado": ConnectorDefinition(auth_methods=["ENV_CONFIGURED"], capabilities=ConnectorCapabilities(supports_native_hierarchy=True, type_system="NAMED_TYPES", parent_link_strategy="NATIVE_RELATION"), ...),
    "github": ConnectorDefinition(auth_methods=["ENV_CONFIGURED", "OAUTH"], capabilities=ConnectorCapabilities(supports_native_hierarchy=False, type_system="PUBLISHABLE_SET", parent_link_strategy="TASK_LIST_BACKFILL"), ...),
}
```

`GET /api/connectors` (new, apps/web proxying or apps/api direct) exposes this registry (minus the non-serializable `discovery_fn`) for the wizard shell to render the "Choose tool" step and drive per-step UI without tool-specific branches.

### 2. Shared discovery contract

```python
@dataclass
class ItemType:
    id: str
    name: str
    supports_children: bool
    fields: list[FieldRequirement]  # empty list if the tool doesn't expose this (ADO)

@dataclass
class ScopeOption:
    id: str
    label: str

@dataclass
class DiscoveryResult:
    scope_options: list[ScopeOption]       # discovered projects/repos, for the scope-picker step
    item_types: list[ItemType] | None      # None for GitHub (no type system)
    extras: dict[str, object]              # tool-specific: GitHub's labels/milestones/file-tree, ADO's area/iteration paths
```

Each tool's existing `discover_projects`/`discover_project_meta` (Jira, ADO) and `discover_repos`/`discover_repo_meta` (GitHub) gain a thin adapter wrapping their existing, unchanged discovery logic into this shape — the actual API calls to Jira/ADO/GitHub are not touched, only the response contract.

### 3. `Connection` model (new, per-workspace credential storage)

```prisma
model Connection {
  id                    String    @id @default(cuid())
  workspaceId           String
  toolKey               String
  authMethod            String    // "ENV_CONFIGURED" | "OAUTH"
  encryptedCredentials  Bytes?    // null for ENV_CONFIGURED (nothing to store)
  scope                 Json?     // e.g. { repoFullName: "org/repo" } once selected
  createdAt             DateTime  @default(now())
  lastHealthCheckAt     DateTime?

  workspace Workspace @relation(fields: [workspaceId], references: [id])

  @@unique([workspaceId, toolKey])
}
```

Envelope encryption (`apps/api/app/services/crypto.py`, new): fetches a data-encryption key from Azure Key Vault once per process (module-level cache), uses it for AES-GCM encrypt/decrypt of the OAuth token bytes before writing/after reading `encryptedCredentials`. Never sends the raw token to Key Vault itself — Key Vault only ever holds the one long-lived DEK.

### 4. GitHub OAuth (net-new, end-to-end for GitHub only)

- `GET /api/workspaces/{ws}/projects/{proj}/connectors/github/oauth/start`: redirects to GitHub's OAuth authorize URL, `state` param = the current `WizardSession.id`.
- `GET /api/connectors/github/oauth/callback`: exchanges the code for a token, encrypts + stores it as a `Connection` row, resumes the `WizardSession` at the next step.
- `github_auth.py` gains a new resolution path: `get_github_connection(workspace_id)` checks for a per-workspace `Connection` row first, falling back to the existing env-configured `TokenConnection` if none exists — so GitHub publishing keeps working unchanged for workspaces that never went through the OAuth wizard.

### 5. `WizardSession` (resume support)

```prisma
model WizardSession {
  id             String    @id @default(cuid())
  workspaceId    String
  projectId      String
  toolKey        String
  currentStep    String
  collectedState Json      @default("{}")
  createdAt      DateTime  @default(now())
  expiresAt      DateTime
}
```

On wizard load: check for an unexpired `WizardSession` matching `(workspaceId, projectId, toolKey)` — if found, resume at `currentStep` with `collectedState`; otherwise start fresh. Expires after a short TTL (e.g. 1 hour) to avoid indefinite stale sessions; no background sweep needed, just filtered out of the "resume" lookup once past `expiresAt`.

### 6. Wizard shell (`apps/web`, new)

A step-driven component (`Choose tool → Authenticate → Select scope → Review defaults → Test connection → Confirm`), reading the connector registry (via `GET /api/connectors`) to render each step generically:

- **Authenticate**: for `ENV_CONFIGURED` tools, a pass-through "connection is ready" confirmation (reusing the existing `GET /connectors/{tool}/health` check); for `OAUTH` tools, the real redirect flow.
- **Select scope**: renders `scope_options` from a discovery call as an actual picker (replacing today's free-text entry).
- **Review defaults**: shows `item_types`-derived type-mapping suggestions (reusing the existing `_DEFAULT_TYPE_SUGGESTIONS`-intersection logic, now fed by the shared `DiscoveryResult` shape instead of a bespoke per-tool dict).
- **Test connection**: calls the new non-persisting test endpoint (below), displays real sample data.
- **Confirm**: persists the `PublishMapping` (existing model, unchanged) with the reviewed defaults.

The three existing settings pages become thin entry points that launch this shell pre-scoped to their tool; the shell replaces their duplicated discover+map+save client logic, not their existence as routes.

### 7. Test-connection endpoint (new, distinct from mapping-save)

`POST /api/workspaces/{ws}/projects/{proj}/connectors/{tool}/test` — runs discovery via the registry's `discovery_fn` WITHOUT persisting a `PublishMapping`, returns the `DiscoveryResult` for display. The wizard's "Review defaults" step consumes this same response to seed type-mapping suggestions — one discovery call serving both moments, satisfying the AC directly. The existing mapping-save endpoints (`upsert_mapping` etc.) are unchanged for backward compatibility but are no longer the sole way to see discovery output.

### 8. Permission-mismatch / `ConnectionRequest` flow

```prisma
model ConnectionRequest {
  id              String    @id @default(cuid())
  workspaceId     String
  toolKey         String
  requestedByUserId String
  token           String    @unique
  status          String    @default("SENT") // SENT | COMPLETED | EXPIRED
  expiresAt       DateTime
  createdAt       DateTime  @default(now())
}
```

Triggered when: GitHub OAuth consent is denied/fails, or env-configured discovery for Jira/ADO returns zero accessible scope options. Generates `/connector-requests/{token}` — a lightweight, no-SpecMate-account-needed page showing tool-specific instructions (e.g. "ask your Jira admin to grant the SpecMate service account access to this project" or, for GitHub, a link the actual repo/org admin can use to complete OAuth authorization on SpecMate's behalf). The originating SpecMate admin sees the request's status (SENT/COMPLETED/EXPIRED) from the wizard or workspace settings.

## Testing

- Registry: capability lookup, auth-method filtering per tool.
- Discovery adapters: each tool's existing bespoke discovery response correctly maps to the new `DiscoveryResult` shape with no information loss (e.g. Jira's per-field requiredness data still present in `item_types[].fields`).
- `Connection` encryption: round-trip test (encrypt → store → read → decrypt → original value), using a real (test-mode) Key Vault DEK or a local-dev equivalent.
- GitHub OAuth: mocked token-exchange integration test, `Connection` row created correctly, `github_auth.py`'s new resolution path prefers it over env-configured fallback.
- `WizardSession`: interrupt-mid-flow-and-resume test (create session, advance state, simulate reload, confirm correct step/state restored); expiry test (session past `expiresAt` is not resumed).
- `ConnectionRequest`: full lifecycle (create → view via token → mark completed → status reflected to the requester).
- Wizard shell: per-step rendering tests, registry-driven (not tool-specific) rendering confirmed by testing all 3 tools through the same component tree.
- Full regression on both apps; live-verify GitHub OAuth against a real (test) GitHub OAuth App if credentials are available, otherwise mocked end-to-end with an explicit note that live verification is a follow-up manual step (matching this repo's established pattern for connector features that need real external accounts — e.g. Jira/ADO publishing were live-verified once real credentials existed).

## Out of scope

- Jira OAuth 2.0 3LO — needs external Atlassian Developer account + app registration, fast-follow issue.
- ADO's upgrade from app-only to delegated per-user OAuth — fast-follow issue, existing app-only OAuth continues working as-is.
- Monday.com/Linear connector definitions — the registry is built to support them, but no new connector tool is implemented in this issue.
- Any change to actual publish/hierarchy behavior — `ConnectorCapabilities` formalizes what the code already does, it doesn't change publish logic.
- A background job/scheduler for `WizardSession`/`ConnectionRequest` expiry sweeping — expired rows are simply excluded from lookups, never actively cleaned up (consistent with this repo's no-new-scheduler precedent).
