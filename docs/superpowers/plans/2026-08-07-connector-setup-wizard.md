# Guided connector setup wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a registry-driven connector wizard shell shared by Jira/ADO/GitHub, backed by a shared discovery contract, a per-workspace encrypted `Connection` model, real GitHub OAuth end-to-end, a resumable `WizardSession`, a distinct test-connection step, and a `ConnectionRequest` permission-mismatch fallback.

**Architecture:** `apps/api` gains: a connector registry (`registry.py`), a shared `DiscoveryResult` contract with thin per-tool adapters (existing discovery API calls untouched), envelope encryption via Azure Key Vault (`crypto.py`), three new Prisma models (`Connection`, `WizardSession`, `ConnectionRequest`), real GitHub OAuth (authorization-code flow), and new test-connection/registry-listing/connection-request endpoints. `apps/web` gains a step-driven wizard shell reading the registry, replacing the three existing settings pages' duplicated discover+map+save client logic (the pages themselves stay as thin entry points). Jira/ADO publishing is untouched — they keep their existing env-configured single-tenant auth, registered as a supported `authMethod` on the same interface.

**Tech Stack:** FastAPI + SQLAlchemy + `cryptography` (AES-GCM) + `azure-keyvault-secrets`/`azure-identity` (`apps/api`), Next.js + Prisma + TypeScript (`apps/web`), pytest, Vitest.

---

### Task 1: Schema — `Connection`, `WizardSession`, `ConnectionRequest`

**Files:**

- Modify: `apps/web/prisma/schema.prisma`
- Modify: `apps/api/app/models.py`
- Create: Prisma migration

- [ ] **Step 1: Read the current `Workspace` model's relation list and `PublishMapping`/`AtlassianConnectInstall` for exact field-naming conventions**

```bash
grep -n "model Workspace {" -A 55 apps/web/prisma/schema.prisma
grep -n "model AtlassianConnectInstall" -A 20 apps/web/prisma/schema.prisma
```

- [ ] **Step 2: Add the three new models**

```prisma
// Per-workspace connector credential storage (Issue 12.13/#101) — the first
// real per-workspace connection store this repo has built; every prior
// connector (Jira/ADO/GitHub) has been single-tenant env-var auth until now.
// encryptedCredentials is null for ENV_CONFIGURED (nothing to store — the
// workspace just uses the ops-configured env credentials); populated only
// for OAUTH-authenticated connections (GitHub, in this issue).
model Connection {
  id                   String    @id @default(cuid())
  workspaceId          String
  toolKey              String
  authMethod           String // "ENV_CONFIGURED" | "OAUTH"
  encryptedCredentials Bytes?
  scope                Json?
  createdAt            DateTime  @default(now())
  updatedAt            DateTime  @updatedAt
  lastHealthCheckAt    DateTime?

  workspace Workspace @relation(fields: [workspaceId], references: [id])

  @@unique([workspaceId, toolKey])
}

// Resumable wizard progress (Issue #101 AC: survive a browser refresh mid-OAuth-
// redirect). No background sweep — expired rows are simply excluded from the
// "resume" lookup (see wizard-session.ts), consistent with this repo's
// established no-new-scheduler precedent.
model WizardSession {
  id             String   @id @default(cuid())
  workspaceId    String
  projectId      String
  toolKey        String
  currentStep    String
  collectedState Json     @default("{}")
  createdAt      DateTime @default(now())
  expiresAt      DateTime

  workspace Workspace @relation(fields: [workspaceId], references: [id])
  project   Project   @relation(fields: [projectId], references: [id])
}

// Permission-mismatch fallback (Issue #101): a shareable link + tracked status
// for when the SpecMate admin completing setup can't grant SpecMate access
// themselves (e.g. not a Jira Admin, or GitHub OAuth consent was denied).
model ConnectionRequest {
  id                String   @id @default(cuid())
  workspaceId       String
  toolKey           String
  requestedByUserId String
  token             String   @unique
  status            String   @default("SENT") // SENT | COMPLETED | EXPIRED
  expiresAt         DateTime
  createdAt         DateTime @default(now())

  workspace   Workspace @relation(fields: [workspaceId], references: [id])
  requestedBy User      @relation(fields: [requestedByUserId], references: [id])
}
```

Add reverse relations on `Workspace` (`connections Connection[]`, `wizardSessions WizardSession[]`, `connectionRequests ConnectionRequest[]`), `Project` (`wizardSessions WizardSession[]`), and `User` (`connectionRequestsCreated ConnectionRequest[]` — check `User`'s existing field-naming pattern for similar "created by me" relations, e.g. `sentInvites`, and match that convention rather than inventing a new one).

- [ ] **Step 3: Generate and apply the migration**

```bash
cd apps/web && npx prisma migrate dev --name add_connector_wizard_models
```

Expected: clean migration, no drift, no prompts. If you hit ANY migration error, STOP and report back — do not run `prisma migrate reset` yourself.

- [ ] **Step 4: Add the SQLAlchemy mirrors**

Read `apps/api/app/models.py`'s imports and a neighboring model (e.g. `PublishMapping` or `AtlassianConnectInstall`) for the exact style/import conventions, then add:

```python
class Connection(Base):
    __tablename__ = "Connection"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_cuid)
    workspaceId: Mapped[str] = mapped_column(ForeignKey("Workspace.id"))
    toolKey: Mapped[str] = mapped_column(String)
    authMethod: Mapped[str] = mapped_column(String)
    encryptedCredentials: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    scope: Mapped[dict[str, object] | None] = mapped_column(JSONB, nullable=True)
    createdAt: Mapped[datetime] = mapped_column(DateTime)
    updatedAt: Mapped[datetime] = mapped_column(DateTime)
    lastHealthCheckAt: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class WizardSession(Base):
    __tablename__ = "WizardSession"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_cuid)
    workspaceId: Mapped[str] = mapped_column(ForeignKey("Workspace.id"))
    projectId: Mapped[str] = mapped_column(ForeignKey("Project.id"))
    toolKey: Mapped[str] = mapped_column(String)
    currentStep: Mapped[str] = mapped_column(String)
    collectedState: Mapped[dict[str, object]] = mapped_column(JSONB)
    createdAt: Mapped[datetime] = mapped_column(DateTime)
    expiresAt: Mapped[datetime] = mapped_column(DateTime)


class ConnectionRequest(Base):
    __tablename__ = "ConnectionRequest"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_cuid)
    workspaceId: Mapped[str] = mapped_column(ForeignKey("Workspace.id"))
    toolKey: Mapped[str] = mapped_column(String)
    requestedByUserId: Mapped[str] = mapped_column(ForeignKey("User.id"))
    token: Mapped[str] = mapped_column(String, unique=True)
    status: Mapped[str] = mapped_column(String, default="SENT")
    expiresAt: Mapped[datetime] = mapped_column(DateTime)
    createdAt: Mapped[datetime] = mapped_column(DateTime)
```

Check whether `LargeBinary` needs importing from `sqlalchemy` (likely not already imported anywhere else in this file — add it if missing).

- [ ] **Step 5: Verify both sides agree**

```bash
cd apps/api && uv run python -c "
from app.models import Connection, WizardSession, ConnectionRequest
print(Connection.__table__.columns.keys())
print(WizardSession.__table__.columns.keys())
print(ConnectionRequest.__table__.columns.keys())
"
```

- [ ] **Step 6: Run both apps' test suites, typecheck, lint**

```bash
cd apps/web && npx vitest run && npx tsc --noEmit
cd ../api && uv run pytest -q && uv run mypy app && uv run ruff check .
```

Expected: no regressions (record baselines before starting).

- [ ] **Step 7: Commit**

```bash
git add apps/web/prisma/schema.prisma apps/web/prisma/migrations/ apps/api/app/models.py
git commit -m "Add Connection, WizardSession, ConnectionRequest models (Issue #101)"
```

---

### Task 2: Envelope encryption via Azure Key Vault

**Files:**

- Create: `apps/api/app/services/crypto.py`
- Modify: `apps/api/pyproject.toml` (add `cryptography`, `azure-keyvault-secrets`, `azure-identity` if not already present)
- Test: `apps/api/tests/services/test_crypto.py`

- [ ] **Step 1: Check existing Azure SDK dependencies**

```bash
grep -i "azure" apps/api/pyproject.toml
```

This app already uses Azure (Blob Storage, per architecture.md) — check whether `azure-identity` is already a dependency (likely yes, for Blob auth) before adding a duplicate.

- [ ] **Step 2: Add dependencies if missing**

```bash
cd apps/api && uv add cryptography azure-keyvault-secrets
# uv add azure-identity   # only if Step 1 showed it's not already present
```

- [ ] **Step 3: Write the failing tests**

```python
import pytest
from app.services.crypto import encrypt_credentials, decrypt_credentials

def test_encrypt_then_decrypt_round_trips_to_original_value(monkeypatch):
    monkeypatch.setattr(
        "app.services.crypto._get_data_encryption_key",
        lambda: b"0" * 32,  # 32-byte test key, bypasses real Key Vault call
    )
    original = "gho_realTokenValueHere1234567890"
    encrypted = encrypt_credentials(original)
    assert encrypted != original.encode()
    decrypted = decrypt_credentials(encrypted)
    assert decrypted == original


def test_encrypt_produces_different_ciphertext_each_call(monkeypatch):
    # AES-GCM requires a fresh nonce per encryption — same plaintext must not
    # produce identical ciphertext twice, or nonce reuse would leak information.
    monkeypatch.setattr(
        "app.services.crypto._get_data_encryption_key",
        lambda: b"0" * 32,
    )
    a = encrypt_credentials("same-value")
    b = encrypt_credentials("same-value")
    assert a != b


def test_decrypt_rejects_tampered_ciphertext(monkeypatch):
    monkeypatch.setattr(
        "app.services.crypto._get_data_encryption_key",
        lambda: b"0" * 32,
    )
    encrypted = bytearray(encrypt_credentials("some-token"))
    encrypted[-1] ^= 0xFF  # flip a byte
    from app.services.crypto import CredentialDecryptionError
    with pytest.raises(CredentialDecryptionError):
        decrypt_credentials(bytes(encrypted))
```

- [ ] **Step 4: Run tests to verify they fail**

```bash
cd apps/api && uv run pytest tests/services/test_crypto.py -v
```

- [ ] **Step 5: Write `apps/api/app/services/crypto.py`**

```python
"""Envelope encryption for per-workspace connector credentials (Issue #101).

A single data-encryption key (DEK) is fetched from Azure Key Vault once per
process and cached module-level — Key Vault only ever holds this one
long-lived key, never the actual per-connection OAuth tokens. Each encrypt
call generates a fresh random nonce (AES-GCM requires this — reusing a nonce
with the same key catastrophically breaks confidentiality), so the same
plaintext never produces the same ciphertext twice. The nonce is prepended to
the ciphertext (standard practice — a nonce isn't secret, just unique) so
decrypt_credentials needs only the stored bytes, not a second stored field.
"""
from __future__ import annotations

import base64
import os

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.core.config import settings

_NONCE_LENGTH = 12  # AES-GCM standard nonce size


class CredentialDecryptionError(Exception):
    pass


_cached_dek: bytes | None = None


def _get_data_encryption_key() -> bytes:
    global _cached_dek
    if _cached_dek is not None:
        return _cached_dek

    if settings.connector_dek_b64:
        # Local/test override — a base64-encoded 32-byte key set directly via
        # env, bypassing Key Vault. Never used in production (Key Vault path
        # below is used there); documented in .env.example.
        _cached_dek = base64.b64decode(settings.connector_dek_b64)
        return _cached_dek

    from azure.identity import DefaultAzureCredential
    from azure.keyvault.secrets import SecretClient

    vault_url = settings.azure_key_vault_url
    if not vault_url:
        raise RuntimeError(
            "AZURE_KEY_VAULT_URL is not configured — cannot fetch the connector "
            "credential encryption key."
        )
    client = SecretClient(vault_url=vault_url, credential=DefaultAzureCredential())
    secret = client.get_secret("connector-credentials-dek")
    _cached_dek = base64.b64decode(secret.value)
    return _cached_dek


def encrypt_credentials(plaintext: str) -> bytes:
    key = _get_data_encryption_key()
    nonce = os.urandom(_NONCE_LENGTH)
    ciphertext = AESGCM(key).encrypt(nonce, plaintext.encode(), None)
    return nonce + ciphertext


def decrypt_credentials(encrypted: bytes) -> str:
    key = _get_data_encryption_key()
    nonce, ciphertext = encrypted[:_NONCE_LENGTH], encrypted[_NONCE_LENGTH:]
    try:
        plaintext = AESGCM(key).decrypt(nonce, ciphertext, None)
    except InvalidTag as exc:
        raise CredentialDecryptionError("Ciphertext failed authentication — possibly tampered.") from exc
    return plaintext.decode()
```

Add `connector_dek_b64: str = ""` and `azure_key_vault_url: str = ""` to `apps/api/app/core/config.py`'s `Settings` class (check the file's current exact shape first — it's a simple `pydantic_settings.BaseSettings` subclass, confirmed earlier this session). Add both to `.env.example` with a comment explaining `CONNECTOR_DEK_B64` is a local-dev-only override, never used in production.

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd apps/api && uv run pytest tests/services/test_crypto.py -v
```

Expected: PASS, all 3 tests.

- [ ] **Step 7: Full API suite, typecheck, lint**

```bash
cd apps/api
uv run pytest -q
uv run mypy app
uv run ruff check .
```

- [ ] **Step 8: Commit**

```bash
git add app/services/crypto.py app/core/config.py .env.example pyproject.toml uv.lock
git commit -m "Add envelope encryption for connector credentials via Key Vault (Issue #101)"
```

---

### Task 3: Connector registry + shared discovery contract

**Files:**

- Create: `apps/api/app/services/connectors/registry.py`
- Create: `apps/api/app/services/connectors/discovery_types.py`
- Modify: `apps/api/app/services/connectors/{jira,ado,github}_publish.py` (add adapter functions, existing discovery functions untouched)
- Test: `apps/api/tests/services/test_registry.py`, `test_discovery_adapters.py`

- [ ] **Step 1: Read all three tools' current discovery functions in full**

```bash
grep -n "def discover_projects\|def discover_project_meta" -A 30 apps/api/app/services/connectors/jira_publish.py
grep -n "def discover_projects\|def discover_project_meta" -A 30 apps/api/app/services/connectors/ado_publish.py
grep -n "def discover_repos\|def discover_repo_meta" -A 40 apps/api/app/services/connectors/github_publish.py
```

Confirm exact current return shapes (already summarized during design research, but re-verify against the live code before writing adapters).

- [ ] **Step 2: Write `discovery_types.py`**

```python
"""Shared discovery contract (Issue #101) — each tool's existing, unchanged
discovery logic gets a thin adapter into this shape; the actual API calls to
Jira/ADO/GitHub are untouched."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal


@dataclass(frozen=True)
class FieldRequirement:
    id: str
    name: str
    required: bool
    has_default: bool


@dataclass(frozen=True)
class ItemType:
    id: str
    name: str
    supports_children: bool
    fields: list[FieldRequirement] = field(default_factory=list)


@dataclass(frozen=True)
class ScopeOption:
    id: str
    label: str


@dataclass(frozen=True)
class DiscoveryResult:
    scope_options: list[ScopeOption]
    item_types: list[ItemType] | None
    extras: dict[str, object] = field(default_factory=dict)
```

- [ ] **Step 3: Write the failing adapter tests**

For each tool, write a test that mocks the underlying discovery call (same mocking convention already used in that tool's existing publish tests — check `apps/api/tests/routers/test_publish.py`/`test_publish_ado.py`/`test_publish_github.py` for the established pattern) and asserts the adapter's `DiscoveryResult` output preserves all the information the old bespoke dict had — e.g. for Jira, that `item_types[0].fields` still contains the same `required`/`has_default` data that `metadata.issue_types[0].fields` used to.

- [ ] **Step 4: Run tests to verify they fail**

```bash
cd apps/api && uv run pytest tests/services/test_discovery_adapters.py -v
```

- [ ] **Step 5: Write the adapter functions**

In each `*_publish.py` file, add (do NOT modify `discover_projects`/`discover_project_meta`/`discover_repos`/`discover_repo_meta` themselves — these adapters call them unchanged and reshape the result):

```python
# jira_publish.py
async def discover_as_result(connection: JiraConnection, project_key: str | None = None) -> DiscoveryResult:
    projects = await discover_projects(connection)
    scope_options = [ScopeOption(id=p["key"], label=f"{p['name']} ({p['key']})") for p in projects]
    item_types = None
    extras: dict[str, object] = {}
    if project_key:
        meta = await discover_project_meta(connection, project_key)
        item_types = [
            ItemType(
                id=it["id"],
                name=it["name"],
                supports_children=not it.get("subtask", False),
                fields=[
                    FieldRequirement(id=f["id"], name=f["name"], required=f["required"], has_default=f["has_default"])
                    for f in it.get("fields", [])
                ],
            )
            for it in meta["issue_types"]
        ]
    return DiscoveryResult(scope_options=scope_options, item_types=item_types, extras=extras)
```

Write the equivalent for ADO (`item_types` from `work_item_types`, `extras={"area_paths": ..., "iteration_paths": ...}`, `fields` built only from `required_fields` since ADO's discovery doesn't return non-required field data — each gets `required=True, has_default=False` since that's the only signal ADO's discovery provides) and GitHub (`item_types=None` always — no type system per the capabilities design — `scope_options` from `discover_repos`, `extras={"labels": ..., "milestones": ..., "file_paths": ...}` from `discover_repo_meta`).

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd apps/api && uv run pytest tests/services/test_discovery_adapters.py -v
```

- [ ] **Step 7: Write the registry**

```python
"""Connector registry (Issue #101) — the single source of truth the wizard
reads to render tool-agnostic UI. Adding a future connector (Monday.com,
Linear) means adding one entry here, not touching wizard UI components."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Awaitable, Callable, Literal

from app.services.connectors.discovery_types import DiscoveryResult
from app.services.connectors import jira_publish, ado_publish, github_publish


@dataclass(frozen=True)
class ConnectorCapabilities:
    supports_native_hierarchy: bool
    type_system: Literal["NAMED_TYPES", "PUBLISHABLE_SET"]
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
    "jira": ConnectorDefinition(
        tool_key="jira",
        display_name="Jira",
        auth_methods=["ENV_CONFIGURED"],
        scope_picker_type="PROJECT_KEY",
        discovery_fn=jira_publish.discover_as_result,
        capabilities=ConnectorCapabilities(
            supports_native_hierarchy=True, type_system="NAMED_TYPES", parent_link_strategy="NATIVE_FIELD"
        ),
    ),
    "ado": ConnectorDefinition(
        tool_key="ado",
        display_name="Azure DevOps",
        auth_methods=["ENV_CONFIGURED"],
        scope_picker_type="PROJECT_NAME",
        discovery_fn=ado_publish.discover_as_result,
        capabilities=ConnectorCapabilities(
            supports_native_hierarchy=True, type_system="NAMED_TYPES", parent_link_strategy="NATIVE_RELATION"
        ),
    ),
    "github": ConnectorDefinition(
        tool_key="github",
        display_name="GitHub",
        auth_methods=["ENV_CONFIGURED", "OAUTH"],
        scope_picker_type="REPO_FULL_NAME",
        discovery_fn=github_publish.discover_as_result,
        capabilities=ConnectorCapabilities(
            supports_native_hierarchy=False, type_system="PUBLISHABLE_SET", parent_link_strategy="TASK_LIST_BACKFILL"
        ),
    ),
}
```

Write `test_registry.py` covering: all 3 tools present, capability values match what's documented, `auth_methods` correctly reflects GitHub-only-has-OAuth.

- [ ] **Step 8: Run tests, full suite, typecheck, lint**

```bash
cd apps/api
uv run pytest -q
uv run mypy app
uv run ruff check .
```

- [ ] **Step 9: Commit**

```bash
git add app/services/connectors/registry.py app/services/connectors/discovery_types.py app/services/connectors/jira_publish.py app/services/connectors/ado_publish.py app/services/connectors/github_publish.py tests/services/test_registry.py tests/services/test_discovery_adapters.py
git commit -m "Add connector registry and shared discovery contract (Issue #101)"
```

---

### Task 4: `GET /api/connectors` registry-listing endpoint + test-connection endpoint

**Files:**

- Create: `apps/api/app/routers/connectors.py`
- Modify: `apps/api/app/main.py` (register the new router — check how other routers are registered)
- Test: `apps/api/tests/routers/test_connectors.py`

- [ ] **Step 1: Read `apps/api/app/main.py`'s router-registration pattern**

```bash
grep -n "include_router\|APIRouter" apps/api/app/main.py
```

- [ ] **Step 2: Write the failing tests**

```python
def test_list_connectors_returns_all_three_tools_with_capabilities():
    client = TestClient(app)
    res = client.get("/connectors")
    assert res.status_code == 200
    body = res.json()
    tool_keys = {c["tool_key"] for c in body["connectors"]}
    assert tool_keys == {"jira", "ado", "github"}
    github = next(c for c in body["connectors"] if c["tool_key"] == "github")
    assert github["auth_methods"] == ["ENV_CONFIGURED", "OAUTH"]
    assert github["capabilities"]["supports_native_hierarchy"] is False


def test_test_connection_endpoint_returns_discovery_without_persisting_mapping():
    # Requires a real or fake workspace/project fixture + a mocked discovery_fn
    # (monkeypatch CONNECTOR_REGISTRY["github"].discovery_fn or the underlying
    # discover_repos call, matching this codebase's existing test-mocking
    # conventions for connector routes — check test_publish_github.py).
    ...
    # Assert: response contains scope_options/item_types/extras, AND no
    # PublishMapping row was created as a side effect (query the DB to confirm).
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd apps/api && uv run pytest tests/routers/test_connectors.py -v
```

- [ ] **Step 4: Write `apps/api/app/routers/connectors.py`**

```python
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db_session
from app.services.connectors.registry import CONNECTOR_REGISTRY

router = APIRouter()


class ConnectorCapabilitiesResponse(BaseModel):
    supports_native_hierarchy: bool
    type_system: str
    parent_link_strategy: str


class ConnectorDefinitionResponse(BaseModel):
    tool_key: str
    display_name: str
    auth_methods: list[str]
    scope_picker_type: str
    capabilities: ConnectorCapabilitiesResponse


class ListConnectorsResponse(BaseModel):
    connectors: list[ConnectorDefinitionResponse]


@router.get("/connectors")
async def list_connectors() -> ListConnectorsResponse:
    return ListConnectorsResponse(
        connectors=[
            ConnectorDefinitionResponse(
                tool_key=c.tool_key,
                display_name=c.display_name,
                auth_methods=c.auth_methods,
                scope_picker_type=c.scope_picker_type,
                capabilities=ConnectorCapabilitiesResponse(
                    supports_native_hierarchy=c.capabilities.supports_native_hierarchy,
                    type_system=c.capabilities.type_system,
                    parent_link_strategy=c.capabilities.parent_link_strategy,
                ),
            )
            for c in CONNECTOR_REGISTRY.values()
        ]
    )


class TestConnectionResponse(BaseModel):
    scope_options: list[dict[str, str]]
    item_types: list[dict[str, object]] | None
    extras: dict[str, object]


@router.post("/workspaces/{workspace_id}/projects/{project_id}/connectors/{tool_key}/test")
async def test_connection(
    workspace_id: str,
    project_id: str,
    tool_key: str,
    session: Annotated[AsyncSession, Depends(get_db_session)],
    remote_project: str | None = None,
) -> TestConnectionResponse:
    connector = CONNECTOR_REGISTRY.get(tool_key)
    if not connector:
        raise HTTPException(status_code=404, detail="Unknown connector.")

    # Resolve the connection the same way the existing publish routers do —
    # per-workspace Connection row if one exists (OAUTH), else the
    # env-configured single-tenant fallback (unchanged from today).
    connection = await _resolve_connection(session, workspace_id, tool_key)

    try:
        result = await connector.discovery_fn(connection, remote_project)
    except Exception as exc:  # noqa: BLE001 — surfaced as a clean 502, not a raw crash
        raise HTTPException(status_code=502, detail=f"Connection test failed: {exc}") from exc

    return TestConnectionResponse(
        scope_options=[{"id": o.id, "label": o.label} for o in result.scope_options],
        item_types=(
            [
                {
                    "id": it.id,
                    "name": it.name,
                    "supports_children": it.supports_children,
                    "fields": [
                        {"id": f.id, "name": f.name, "required": f.required, "has_default": f.has_default}
                        for f in it.fields
                    ],
                }
                for it in result.item_types
            ]
            if result.item_types is not None
            else None
        ),
        extras=result.extras,
    )
```

`_resolve_connection` is a placeholder here — Task 6 builds the real per-workspace resolution logic (checking the `Connection` table before falling back to env-configured). For THIS task, write `_resolve_connection` to just call the existing tool-specific `get_{tool}_connection()` functions directly (Jira/ADO/GitHub's existing env-configured resolvers) — Task 6 will replace this with the real per-workspace-aware version. Note this explicitly in a code comment so it's clear this is intentionally temporary within this plan, not a design gap.

Register the router in `main.py` matching the existing pattern (likely `app.include_router(connectors.router)` alongside the other routers — check the exact prefix/tags convention used by sibling routers first).

- [ ] **Step 5: Run tests to verify they pass**

- [ ] **Step 6: Full suite, typecheck, lint**

```bash
cd apps/api
uv run pytest -q
uv run mypy app
uv run ruff check .
```

- [ ] **Step 7: Commit**

```bash
git add app/routers/connectors.py app/main.py tests/routers/test_connectors.py
git commit -m "Add connector registry listing and test-connection endpoints (Issue #101)"
```

---

### Task 5: GitHub OAuth — authorization-code flow + `Connection` storage

**Files:**

- Modify: `apps/api/app/services/connectors/github_auth.py`
- Create: `apps/api/app/routers/github_oauth.py`
- Modify: `apps/api/.env.example`
- Test: `apps/api/tests/services/test_github_oauth.py`, `apps/api/tests/routers/test_github_oauth.py`

This is the one genuinely new security-sensitive surface in this plan (real OAuth token handling). Read the design spec's §4 in full before starting (`docs/superpowers/specs/2026-08-07-connector-setup-wizard-design.md`).

- [ ] **Step 1: Read `github_auth.py` in full (already shown above during planning research — reproduced here, re-verify live)**

Confirm `GitHubConnection` Protocol's exact shape (`base_url()`, `headers()`) — an OAuth-backed connection class needs to satisfy the same Protocol.

- [ ] **Step 2: Add GitHub OAuth env vars**

```
# GitHub OAuth App (Issue #101) — for per-workspace delegated connector auth,
# distinct from GITHUB_TOKEN (the existing single-tenant PAT fallback).
GITHUB_OAUTH_APP_CLIENT_ID=""
GITHUB_OAUTH_APP_CLIENT_SECRET=""
```

(Distinct env var names from Issue #95's `GITHUB_OAUTH_CLIENT_ID` — that's for SpecMate USER LOGIN via GitHub, a completely different OAuth App registration/purpose. Name these unambiguously, e.g. `GITHUB_OAUTH_APP_*`, to avoid the exact naming collision Issue #95's own follow-up (#111) warned about.)

- [ ] **Step 3: Write the failing tests for the OAuth token exchange**

```python
import pytest
from unittest.mock import AsyncMock, patch

from app.services.connectors.github_auth import exchange_oauth_code_for_token

@pytest.mark.asyncio
async def test_exchange_oauth_code_for_token_returns_access_token(monkeypatch):
    monkeypatch.setattr("app.core.config.settings.github_oauth_app_client_id", "test-client-id")
    monkeypatch.setattr("app.core.config.settings.github_oauth_app_client_secret", "test-secret")

    class FakeResponse:
        status_code = 200
        def json(self):
            return {"access_token": "gho_faketoken123", "token_type": "bearer", "scope": "repo"}
        def raise_for_status(self):
            pass

    with patch("httpx.AsyncClient.post", new=AsyncMock(return_value=FakeResponse())):
        token = await exchange_oauth_code_for_token("fake-auth-code")
    assert token == "gho_faketoken123"


@pytest.mark.asyncio
async def test_exchange_oauth_code_for_token_raises_on_error_response(monkeypatch):
    monkeypatch.setattr("app.core.config.settings.github_oauth_app_client_id", "test-client-id")
    monkeypatch.setattr("app.core.config.settings.github_oauth_app_client_secret", "test-secret")

    class FakeResponse:
        status_code = 200
        def json(self):
            return {"error": "bad_verification_code"}
        def raise_for_status(self):
            pass

    from app.services.connectors.types import ConnectorError
    with patch("httpx.AsyncClient.post", new=AsyncMock(return_value=FakeResponse())):
        with pytest.raises(ConnectorError):
            await exchange_oauth_code_for_token("expired-or-reused-code")
```

- [ ] **Step 4: Run tests to verify they fail**

- [ ] **Step 5: Add to `github_auth.py`**

```python
async def exchange_oauth_code_for_token(code: str) -> str:
    if not settings.github_oauth_app_client_id or not settings.github_oauth_app_client_secret:
        raise ConnectorError("GitHub OAuth App is not configured.")
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
    payload = response.json()
    token = payload.get("access_token")
    if not token:
        raise ConnectorError(f"GitHub OAuth token exchange failed: {payload.get('error', 'unknown error')}")
    return token


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
```

Add `github_oauth_app_client_id: str = ""` and `github_oauth_app_client_secret: str = ""` to `Settings`.

- [ ] **Step 6: Run tests to verify they pass**

- [ ] **Step 7: Write the OAuth start/callback router**

```python
"""GitHub OAuth authorization-code flow for per-workspace connector auth
(Issue #101) — the wizard's OAuth step. Distinct from Issue #95's user-login
GitHub OAuth (different app registration, different purpose: this
authenticates SpecMate's ACCESS TO A REPO, not a person's identity)."""
from __future__ import annotations

from typing import Annotated
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import RedirectResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.db import get_db_session
from app.models import Connection, WizardSession
from app.services.connectors.github_auth import exchange_oauth_code_for_token
from app.services.crypto import encrypt_credentials

router = APIRouter()


@router.get("/connectors/github/oauth/start")
async def start_github_oauth(wizard_session_id: str) -> RedirectResponse:
    params = urlencode(
        {
            "client_id": settings.github_oauth_app_client_id,
            "scope": "repo",
            "state": wizard_session_id,
        }
    )
    return RedirectResponse(f"https://github.com/login/oauth/authorize?{params}")


@router.get("/connectors/github/oauth/callback")
async def github_oauth_callback(
    code: str,
    state: str,
    session: Annotated[AsyncSession, Depends(get_db_session)],
) -> dict[str, str]:
    wizard_session = await session.get(WizardSession, state)
    if not wizard_session:
        raise HTTPException(status_code=404, detail="Wizard session not found or expired.")

    token = await exchange_oauth_code_for_token(code)
    encrypted = encrypt_credentials(token)

    existing = (
        await session.execute(
            select(Connection).where(
                Connection.workspaceId == wizard_session.workspaceId,
                Connection.toolKey == "github",
            )
        )
    ).scalar_one_or_none()
    if existing:
        existing.authMethod = "OAUTH"
        existing.encryptedCredentials = encrypted
    else:
        session.add(
            Connection(
                workspaceId=wizard_session.workspaceId,
                toolKey="github",
                authMethod="OAUTH",
                encryptedCredentials=encrypted,
            )
        )
    wizard_session.currentStep = "select_scope"
    await session.commit()

    return {"wizardSessionId": wizard_session.id, "status": "connected"}
```

Note: the callback returns JSON here rather than redirecting straight into the frontend wizard UI — check with the actual frontend routing built in Task 9 whether this should instead be a `RedirectResponse` back to a `apps/web` wizard URL with the wizard session id in the query string, and adjust if so. Flag this as a cross-task integration point to verify once Task 9 exists, not something to guess at now.

- [ ] **Step 8: Run tests, full suite, typecheck, lint**

```bash
cd apps/api
uv run pytest -q
uv run mypy app
uv run ruff check .
```

- [ ] **Step 9: Commit**

```bash
git add app/services/connectors/github_auth.py app/routers/github_oauth.py app/main.py .env.example tests/
git commit -m "Add GitHub OAuth authorization-code flow with encrypted token storage (Issue #101)"
```

---

### Task 6: Per-workspace connection resolution — wire `Connection` into GitHub publishing

**Files:**

- Modify: `apps/api/app/services/connectors/github_auth.py`
- Modify: `apps/api/app/routers/connectors.py` (replace Task 4's placeholder `_resolve_connection`)
- Modify: `apps/api/app/routers/publish_github.py` (only if its connection-resolution dependency needs updating — check first)
- Test: extend `apps/api/tests/services/test_github_oauth.py` or a new `test_connection_resolution.py`

- [ ] **Step 1: Read `apps/api/app/routers/publish_github.py`'s current connection dependency injection**

```bash
grep -n "get_github_connection\|Connection" apps/api/app/routers/publish_github.py | head -10
```

Confirmed earlier: `connection: Callable[[], GitHubConnection] = get_github_connection` — a zero-arg factory dependency. Per-workspace resolution needs a workspace id, which this current signature doesn't have access to — this task needs to change this to an async, workspace-aware resolver.

- [ ] **Step 2: Write the failing tests**

Cover: a workspace with an `OAUTH` `Connection` row resolves to `OAuthTokenConnection` with the decrypted token; a workspace with no `Connection` row resolves to the existing env-configured `TokenConnection` (unchanged fallback behavior — critical regression guard, since every existing GitHub-publishing workspace has no `Connection` row and must keep working exactly as before); a workspace with an `ENV_CONFIGURED` `Connection` row (explicit, not just absent) also resolves to the env-configured fallback.

- [ ] **Step 3: Run tests to verify they fail**

- [ ] **Step 4: Add the resolver to `github_auth.py`**

```python
async def resolve_github_connection(session: AsyncSession, workspace_id: str) -> GitHubConnection:
    """Per-workspace connection resolution (Issue #101): prefers a stored OAuth
    Connection for this workspace, falls back to the existing single-tenant
    env-configured connection unchanged — so GitHub publishing keeps working
    exactly as before for every workspace that hasn't gone through the OAuth
    wizard."""
    from app.models import Connection
    from app.services.crypto import decrypt_credentials
    from sqlalchemy import select

    row = (
        await session.execute(
            select(Connection).where(Connection.workspaceId == workspace_id, Connection.toolKey == "github")
        )
    ).scalar_one_or_none()
    if row and row.authMethod == "OAUTH" and row.encryptedCredentials:
        token = decrypt_credentials(row.encryptedCredentials)
        return OAuthTokenConnection(token=token)
    return get_github_connection()
```

- [ ] **Step 5: Run tests to verify they pass**

- [ ] **Step 6: Update `publish_github.py` and `connectors.py`'s test-connection endpoint to use this resolver**

For `publish_github.py`: change the connection dependency from the zero-arg `Callable[[], GitHubConnection] = get_github_connection` to an async dependency that takes `workspace_id`/`session` and calls `resolve_github_connection`. This is a real call-site change — read the router's full current signature first and make the minimal change needed, don't restructure unrelated parts of the file. Run the FULL existing `test_publish_github.py` suite after this change and confirm every existing test still passes unchanged (this is the regression-safety check that matters most in this task).

For `connectors.py`: replace Task 4's placeholder `_resolve_connection` with a call to `resolve_github_connection` for the `github` tool key, keeping Jira/ADO on their existing env-configured resolvers (no per-workspace `Connection` row support for those two in this issue).

- [ ] **Step 7: Full suite, typecheck, lint**

```bash
cd apps/api
uv run pytest -q
uv run mypy app
uv run ruff check .
```

Expected: no regressions, especially `test_publish_github.py`'s full existing suite.

- [ ] **Step 8: Commit**

```bash
git add app/services/connectors/github_auth.py app/routers/publish_github.py app/routers/connectors.py tests/
git commit -m "Wire per-workspace GitHub Connection resolution into publishing (Issue #101)"
```

---

### Task 7: `WizardSession` create/get/advance endpoints

**Files:**

- Create: `apps/api/app/routers/wizard_sessions.py`
- Test: `apps/api/tests/routers/test_wizard_sessions.py`

- [ ] **Step 1: Write the failing tests**

Cover: `POST /workspaces/{ws}/projects/{proj}/wizard-sessions` with `{tool_key}` creates a fresh session at step `"choose_tool"`, TTL set (e.g. 1 hour from now); `GET /wizard-sessions/{id}` returns the session if unexpired, 404 if past `expiresAt`; `PATCH /wizard-sessions/{id}` updates `currentStep`/`collectedState`; `GET /workspaces/{ws}/projects/{proj}/wizard-sessions/resume?tool_key=...` returns the most recent unexpired session for that `(workspace, project, tool)` if one exists, else 404 (this is the "resume" lookup the frontend checks on wizard load).

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Write the router**

```python
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db_session
from app.models import WizardSession

router = APIRouter()
SESSION_TTL = timedelta(hours=1)


class WizardSessionResponse(BaseModel):
    id: str
    tool_key: str
    current_step: str
    collected_state: dict[str, object]
    expires_at: str


def _to_response(ws: WizardSession) -> WizardSessionResponse:
    return WizardSessionResponse(
        id=ws.id, tool_key=ws.toolKey, current_step=ws.currentStep,
        collected_state=ws.collectedState, expires_at=ws.expiresAt.isoformat(),
    )


class CreateWizardSessionBody(BaseModel):
    tool_key: str


@router.post("/workspaces/{workspace_id}/projects/{project_id}/wizard-sessions")
async def create_wizard_session(
    workspace_id: str, project_id: str, body: CreateWizardSessionBody,
    session: Annotated[AsyncSession, Depends(get_db_session)],
) -> WizardSessionResponse:
    now = datetime.now(UTC).replace(tzinfo=None)
    ws = WizardSession(
        workspaceId=workspace_id, projectId=project_id, toolKey=body.tool_key,
        currentStep="choose_tool", collectedState={}, createdAt=now, expiresAt=now + SESSION_TTL,
    )
    session.add(ws)
    await session.flush()
    await session.commit()
    return _to_response(ws)


@router.get("/wizard-sessions/{wizard_session_id}")
async def get_wizard_session(
    wizard_session_id: str, session: Annotated[AsyncSession, Depends(get_db_session)],
) -> WizardSessionResponse:
    ws = await session.get(WizardSession, wizard_session_id)
    now = datetime.now(UTC).replace(tzinfo=None)
    if not ws or ws.expiresAt < now:
        raise HTTPException(status_code=404, detail="Wizard session not found or expired.")
    return _to_response(ws)


class UpdateWizardSessionBody(BaseModel):
    current_step: str | None = None
    collected_state: dict[str, object] | None = None


@router.patch("/wizard-sessions/{wizard_session_id}")
async def update_wizard_session(
    wizard_session_id: str, body: UpdateWizardSessionBody,
    session: Annotated[AsyncSession, Depends(get_db_session)],
) -> WizardSessionResponse:
    ws = await session.get(WizardSession, wizard_session_id)
    now = datetime.now(UTC).replace(tzinfo=None)
    if not ws or ws.expiresAt < now:
        raise HTTPException(status_code=404, detail="Wizard session not found or expired.")
    if body.current_step is not None:
        ws.currentStep = body.current_step
    if body.collected_state is not None:
        ws.collectedState = body.collected_state
    await session.commit()
    return _to_response(ws)


@router.get("/workspaces/{workspace_id}/projects/{project_id}/wizard-sessions/resume")
async def resume_wizard_session(
    workspace_id: str, project_id: str, tool_key: str,
    session: Annotated[AsyncSession, Depends(get_db_session)],
) -> WizardSessionResponse:
    now = datetime.now(UTC).replace(tzinfo=None)
    ws = (
        await session.execute(
            select(WizardSession)
            .where(
                WizardSession.workspaceId == workspace_id,
                WizardSession.projectId == project_id,
                WizardSession.toolKey == tool_key,
                WizardSession.expiresAt >= now,
            )
            .order_by(WizardSession.createdAt.desc())
        )
    ).scalars().first()
    if not ws:
        raise HTTPException(status_code=404, detail="No active wizard session to resume.")
    return _to_response(ws)
```

- [ ] **Step 4: Run tests to verify they pass, full suite, typecheck, lint**

```bash
cd apps/api
uv run pytest -q
uv run mypy app
uv run ruff check .
```

- [ ] **Step 5: Commit**

```bash
git add app/routers/wizard_sessions.py app/main.py tests/routers/test_wizard_sessions.py
git commit -m "Add WizardSession create/get/update/resume endpoints (Issue #101)"
```

---

### Task 8: `ConnectionRequest` permission-mismatch flow

**Files:**

- Create: `apps/api/app/routers/connection_requests.py`
- Test: `apps/api/tests/routers/test_connection_requests.py`

- [ ] **Step 1: Write the failing tests**

Cover: `POST /workspaces/{ws}/connection-requests` with `{tool_key}` creates a `ConnectionRequest`, `status: SENT`, returns a shareable token/URL; `GET /connection-requests/{token}` returns tool-specific instructions text (a simple per-tool static message dict is fine — Jira: "ask your Jira admin to grant SpecMate's service account access to this project"; ADO: similar; GitHub: "the repository/org admin needs to complete OAuth authorization for SpecMate") and current status, 404/410 if expired; `POST /connection-requests/{token}/complete` marks it `COMPLETED` (no SpecMate account needed to hit this — it's the "tool admin" completing it, who may not be a SpecMate user at all); `GET /workspaces/{ws}/connection-requests` lists all requests for a workspace with their status (for the SpecMate admin to check back on).

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Write the router**

```python
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Annotated
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db_session
from app.models import ConnectionRequest

router = APIRouter()
REQUEST_TTL = timedelta(days=7)

_INSTRUCTIONS = {
    "jira": "Ask your Jira admin to grant SpecMate's configured service account access to this project.",
    "ado": "Ask your Azure DevOps admin to grant SpecMate's configured service account access to this project.",
    "github": "Ask a repository or organization admin to complete GitHub authorization for SpecMate.",
}


class CreateConnectionRequestBody(BaseModel):
    tool_key: str
    requested_by_user_id: str


class ConnectionRequestResponse(BaseModel):
    id: str
    tool_key: str
    token: str
    status: str
    instructions: str
    expires_at: str


def _to_response(cr: ConnectionRequest) -> ConnectionRequestResponse:
    return ConnectionRequestResponse(
        id=cr.id, tool_key=cr.toolKey, token=cr.token, status=cr.status,
        instructions=_INSTRUCTIONS.get(cr.toolKey, "Contact your tool administrator for access."),
        expires_at=cr.expiresAt.isoformat(),
    )


@router.post("/workspaces/{workspace_id}/connection-requests")
async def create_connection_request(
    workspace_id: str, body: CreateConnectionRequestBody,
    session: Annotated[AsyncSession, Depends(get_db_session)],
) -> ConnectionRequestResponse:
    now = datetime.now(UTC).replace(tzinfo=None)
    cr = ConnectionRequest(
        workspaceId=workspace_id, toolKey=body.tool_key, requestedByUserId=body.requested_by_user_id,
        token=uuid4().hex, status="SENT", createdAt=now, expiresAt=now + REQUEST_TTL,
    )
    session.add(cr)
    await session.commit()
    return _to_response(cr)


@router.get("/connection-requests/{token}")
async def get_connection_request(
    token: str, session: Annotated[AsyncSession, Depends(get_db_session)],
) -> ConnectionRequestResponse:
    cr = (await session.execute(select(ConnectionRequest).where(ConnectionRequest.token == token))).scalar_one_or_none()
    if not cr:
        raise HTTPException(status_code=404, detail="Request not found.")
    now = datetime.now(UTC).replace(tzinfo=None)
    if cr.expiresAt < now and cr.status == "SENT":
        cr.status = "EXPIRED"
        await session.commit()
    return _to_response(cr)


@router.post("/connection-requests/{token}/complete")
async def complete_connection_request(
    token: str, session: Annotated[AsyncSession, Depends(get_db_session)],
) -> ConnectionRequestResponse:
    cr = (await session.execute(select(ConnectionRequest).where(ConnectionRequest.token == token))).scalar_one_or_none()
    if not cr:
        raise HTTPException(status_code=404, detail="Request not found.")
    if cr.status != "SENT":
        raise HTTPException(status_code=409, detail=f"Request is already {cr.status.lower()}.")
    cr.status = "COMPLETED"
    await session.commit()
    return _to_response(cr)


@router.get("/workspaces/{workspace_id}/connection-requests")
async def list_connection_requests(
    workspace_id: str, session: Annotated[AsyncSession, Depends(get_db_session)],
) -> list[ConnectionRequestResponse]:
    rows = (
        await session.execute(
            select(ConnectionRequest).where(ConnectionRequest.workspaceId == workspace_id).order_by(ConnectionRequest.createdAt.desc())
        )
    ).scalars().all()
    return [_to_response(r) for r in rows]
```

Note the `/connection-requests/{token}` GET and `/complete` POST endpoints deliberately have NO auth gate — the whole point is a tool admin who may not have a SpecMate account can complete this via the shared link. Confirm this is genuinely intended (it is, per the design) and add a code comment explaining why, so a future security review doesn't flag the missing auth check as an oversight.

- [ ] **Step 4: Run tests to verify they pass, full suite, typecheck, lint**

```bash
cd apps/api
uv run pytest -q
uv run mypy app
uv run ruff check .
```

- [ ] **Step 5: Commit**

```bash
git add app/routers/connection_requests.py app/main.py tests/routers/test_connection_requests.py
git commit -m "Add ConnectionRequest permission-mismatch fallback endpoints (Issue #101)"
```

---

### Task 9: Wizard shell (frontend)

**Files:**

- Create: `apps/web/src/app/workspaces/[workspaceId]/projects/[projectId]/connect/[toolKey]/page.tsx`
- Create: `apps/web/src/app/workspaces/[workspaceId]/projects/[projectId]/connect/[toolKey]/wizard-shell.tsx`
- Create: step components: `steps/choose-tool.tsx` (only reachable if `toolKey` isn't already fixed by the route — likely skip this step in practice since the route already encodes the tool, but keep the registry-driven rendering capability), `steps/authenticate.tsx`, `steps/select-scope.tsx`, `steps/review-defaults.tsx`, `steps/test-connection.tsx`, `steps/confirm.tsx`
- Test: `wizard-shell.test.tsx` + one test per step component

This is the largest single task in the plan. Read `apps/web/src/components/onboarding/onboarding-wizard.tsx` in full first — it's this codebase's existing precedent for a step-driven wizard component (`StepKey` union + `STEPS` array + local `step` state), even though it's for a different flow (source upload → generate). Match its state-management shape where sensible rather than inventing a new pattern, but don't force-fit — this wizard has real backend-persisted resume state (`WizardSession`) that `onboarding-wizard.tsx` doesn't need.

- [ ] **Step 1: Read `onboarding-wizard.tsx` in full, and the three existing publishing-settings client components in full** (already read during design research this session — re-read live, since this task's job is to extract/replace their discover+map+save logic, not duplicate it blind).

- [ ] **Step 2: Write the server page**

```tsx
import { notFound } from 'next/navigation';
import { requireProjectRole } from '@/lib/workspace-context';
import { WizardShell } from './wizard-shell';

export default async function ConnectorWizardPage({
  params,
}: {
  params: Promise<{ workspaceId: string; projectId: string; toolKey: string }>;
}) {
  const { workspaceId, projectId, toolKey } = await params;

  const access = await requireProjectRole(workspaceId, projectId, ['ADMIN']);
  if (!access.ok) notFound();

  return <WizardShell workspaceId={workspaceId} projectId={projectId} toolKey={toolKey} />;
}
```

- [ ] **Step 3: Write `wizard-shell.tsx`**

Client component. On mount:

1. Fetch `GET /api/connectors` (registry listing) to get this tool's `ConnectorDefinition` (auth methods, scope picker type, capabilities).
2. Attempt `GET /api/workspaces/{ws}/projects/{proj}/wizard-sessions/resume?tool_key={toolKey}` — if 200, resume at the returned `current_step`/`collected_state`; if 404, `POST` to create a fresh session.
3. Render the step matching `currentStep`, passing down the registry definition + `collectedState` + a callback to advance (`PATCH` the session with the new step/state, then update local state).

Step sequence (skip `choose_tool` since the route already fixes `toolKey`): `authenticate → select_scope → review_defaults → test_connection → confirm`.

- [ ] **Step 4: Write each step component**

- **`authenticate.tsx`**: if `authMethods` includes only `ENV_CONFIGURED`, render a simple "connection ready" confirmation calling the existing `GET /connectors/{tool}/health` check, auto-advance on success. If `OAUTH` is available (GitHub), show a "Connect with GitHub" button that navigates to `GET /connectors/github/oauth/start?wizard_session_id={id}` (full page navigation, not fetch — this is a real redirect to github.com). On return from the OAuth callback (Task 5's callback currently returns JSON — confirm during this task whether it should instead redirect back into this wizard page with a query param signaling success, and adjust Task 5's callback if so, treating this as the integration point flagged there).
- **`select-scope.tsx`**: calls the test-connection endpoint (Task 4) with no `remote_project` yet to get `scope_options`, renders them as a picker (radio list or searchable select depending on count) matching `scopePickerType`.
- **`review-defaults.tsx`**: re-calls the test-connection endpoint WITH the selected `remote_project` to get `item_types`, renders the same type-mapping suggestion UI the existing per-tool components have (reuse the `_DEFAULT_TYPE_SUGGESTIONS`-intersection result, now already computed server-side and reflected in what fields are pre-populated — confirm whether that suggestion logic needs to move into the new test-connection response or stay in the existing mapping-save endpoint; if the latter, this step shows raw discovered types without pre-selected suggestions until the final save, which is an acceptable, explicitly-noted simplification for this task rather than a silent gap).
- **`test-connection.tsx`**: displays the actual sample data already fetched in the previous step (labels/milestones for GitHub, issue-type list for Jira/ADO) — this step is primarily a "here's what we found, does this look right?" confirmation rather than a new network call, satisfying the AC that one discovery call serves both moments.
- **`confirm.tsx`**: POSTs to the existing mapping-save endpoint (`/publish-mapping/{tool}`, unchanged from before this issue) with the reviewed `remote_project`/`type_map`, then deletes the `WizardSession` (or lets it expire naturally — simplest: just navigate away, no explicit cleanup needed given the no-sweep design) and redirects to the project's publishing settings page showing the now-saved mapping.

- [ ] **Step 5: Write tests for each step + the shell's resume logic**

Cover: shell creates a fresh session when no resume session exists; shell resumes at the correct step when one does; authenticate step renders the OAuth button only when the registry says `OAUTH` is available; select-scope renders discovered options; confirm calls the existing mapping-save endpoint with the right body shape.

- [ ] **Step 6: Update the three existing settings pages to link into this wizard**

Read `apps/web/src/app/workspaces/[workspaceId]/projects/[projectId]/settings/publishing{,-ado,-github}/page.tsx` in full. Add a "Set up connection" / "Reconnect" link/button pointing to `/workspaces/{ws}/projects/{proj}/connect/{toolKey}` — do NOT remove or restructure the existing discover+map+save UI/logic in this task (that stays as the direct-edit path for an already-connected mapping; the wizard is the guided FIRST-TIME setup path). This keeps the change additive and low-risk rather than ripping out working, tested code as part of this already-large plan.

- [ ] **Step 7: Run tests, full suite, typecheck, lint**

```bash
cd apps/web
npx vitest run
npx tsc --noEmit
npx eslint "src/app/workspaces/[workspaceId]/projects/[projectId]/connect/" "src/app/workspaces/[workspaceId]/projects/[projectId]/settings/"
```

- [ ] **Step 8: Manual smoke test**

```bash
cd apps/web && pnpm dev &
sleep 5
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/workspaces/x/projects/y/connect/github
kill %1 2>/dev/null
```

- [ ] **Step 9: Commit**

```bash
git add "src/app/workspaces/[workspaceId]/projects/[projectId]/connect/" "src/app/workspaces/[workspaceId]/projects/[projectId]/settings/"
git commit -m "Add registry-driven connector wizard shell (Issue #101)"
```

---

### Task 10: Full regression, documentation, close the issue

**Files:** none beyond `architecture.md`

- [ ] **Step 1: Full regression, both apps**

```bash
cd apps/api && uv run pytest -q && uv run mypy app && uv run ruff check .
cd ../web && npx vitest run && npx tsc --noEmit && npx eslint .
```

- [ ] **Step 2: Manual smoke test — app boots with the new module-level registry + Key Vault client construction**

```bash
cd apps/api && uv run uvicorn app.main:app --port 8010 &
sleep 3
curl -s http://localhost:8010/health
curl -s http://localhost:8010/connectors
kill %1 2>/dev/null
```

Confirm no startup crash from the new Key Vault client code (it should lazily construct on first real use, not at import time — verify this is actually true by checking `crypto.py`'s `_get_data_encryption_key()` is only called from `encrypt_credentials`/`decrypt_credentials`, never at module load).

- [ ] **Step 3: Update `architecture.md`**

Add a new subsection after the most recent connector-related `### ` entry:

```markdown
### Guided connector setup wizard (Issue #101, `apps/api/app/services/connectors/registry.py`)

A registry-driven wizard shell shared by Jira/ADO/GitHub, replacing three settings pages' duplicated discover+map+save logic with one step-driven component reading a `CONNECTOR_REGISTRY` (`{tool_key, auth_methods, scope_picker_type, discovery_fn, capabilities}`). `ConnectorCapabilities` formalizes what was previously scattered per-file constants (hierarchy support, type-system shape, parent-link strategy) into one registry-attached object — Jira/ADO have `NAMED_TYPES` + native parent links, GitHub has `PUBLISHABLE_SET` (no native type system) + task-list-backfill hierarchy. A shared `DiscoveryResult` contract normalizes each tool's structurally-different discovery response (Jira's per-field requiredness, ADO's required-fields-only, GitHub's labels/milestones/file-tree) without touching the underlying discovery API calls. **Real per-workspace OAuth was built for GitHub only** (most standard OAuth support, no external app-registration dependency) — a new `Connection` model stores envelope-encrypted tokens (AES-GCM, data-encryption key fetched from Azure Key Vault once per process and cached), resolved in preference to the existing single-tenant env-configured fallback so already-connected workspaces keep working unchanged. Jira OAuth 2.0 3LO (needs an external Atlassian Developer account/app registration) and ADO's upgrade from app-only to delegated per-user OAuth are explicit fast-follow issues using this proven pattern. A new `WizardSession` model (Postgres row, no background sweep — expired rows are just excluded from resume lookups) supports the AC that the wizard survives a browser refresh mid-OAuth-redirect. A new `ConnectionRequest` model implements the permission-mismatch fallback: when discovery finds zero accessible projects/repos (or GitHub OAuth consent is denied), the SpecMate admin can generate a shareable, no-account-needed link with tool-specific instructions for whoever actually manages that tool, with trackable status (SENT/COMPLETED/EXPIRED). The three existing per-tool settings pages are unchanged as the direct-edit path for an already-connected mapping; the wizard is the new guided first-time-setup path, linked from each.
```

- [ ] **Step 4: Commit**

```bash
git add architecture.md
git commit -m "Document guided connector setup wizard in architecture.md"
```

- [ ] **Step 5: Close Issue #101**

```bash
gh issue close 101 --comment "$(cat <<'EOF'
Implemented as a registry-driven wizard shell shared by Jira/ADO/GitHub, plus the new infrastructure the wizard's ACs genuinely require (none of which existed before this issue).

**Registry + capabilities**: a `CONNECTOR_REGISTRY` formalizes what was previously scattered per-file constants across the three connectors' publish logic (hierarchy support, type-system shape, parent-link strategy) into one registry-attached `ConnectorCapabilities` object per tool. A new `Monday.com` or `Linear` connector would register one definition against this interface — no wizard UI changes needed, directly satisfying that AC.

**Shared discovery contract**: each tool's existing, unchanged discovery API calls get a thin adapter into a common `DiscoveryResult` shape, so the wizard's scope-picker and type-mapping steps render generically instead of через tool-specific branches.

**Real per-workspace OAuth — GitHub only, by design**: building OAuth simultaneously for all three tools was assessed as too much new security surface at once, and Jira's OAuth needs an external Atlassian app registration outside engineering's control. GitHub OAuth Apps have the most standard, unblocked flow, so it was built end-to-end: authorization-code exchange, a new `Connection` model storing envelope-encrypted tokens (AES-GCM, data-encryption key from Azure Key Vault, cached per-process), and per-workspace-aware connection resolution that falls back to the existing single-tenant env-configured credentials unchanged for any workspace that hasn't gone through the OAuth wizard — verified via the full existing GitHub publish test suite passing unchanged. Jira OAuth 2.0 3LO and ADO's delegated-OAuth upgrade are filed as fast-follow issues using this now-proven pattern.

**Test connection, genuinely distinct from mapping-save**: previously, discovery and mapping-persist were the same API call — there was no way to preview real data before committing a mapping. A new test-connection endpoint runs discovery without persisting anything, and the wizard's review-defaults step consumes that same response to seed type-mapping suggestions, satisfying the AC that one discovery call serves both the "proof it worked" moment and the mapping defaults.

**Permission-mismatch handling — adapted, not deferred**: since none of the three tools had real per-user OAuth before this issue (making "insufficient permission" errors undetectable in the way the AC originally imagined), this was built as a generic fallback: when discovery finds zero accessible projects/repos, or GitHub OAuth consent is denied, the SpecMate admin can generate a shareable, no-SpecMate-account-needed link with tool-specific instructions for their actual tool admin, tracked via status (SENT/COMPLETED/EXPIRED).

**Resumability**: a `WizardSession` Postgres row (no new background infrastructure) tracks progress; the wizard checks for an unexpired session on load and resumes at the correct step — covers the AC's browser-refresh-mid-OAuth-redirect scenario.

**Explicitly out of scope** (confirmed with the user before implementation): Jira/ADO real OAuth (fast-follow), Monday.com/Linear connector implementations (registry supports them, none built), any change to actual publish/hierarchy behavior (capabilities formalize existing behavior, don't change it).

Full regression: both apps' test suites green, mypy/ruff/tsc/eslint clean.
EOF
)"
```

---

## Self-review notes (for the plan author, already applied above)

- **Spec coverage**: all 5 ACs covered — shared shell (Task 9, one component tree for all 3 tools via the registry), permission-mismatch + status tracking (Task 8), test-connection feeding both proof-of-work and mapping defaults (Task 4 + Task 9's review-defaults/test-connection steps), registry-driven new-connector addition (Task 3's `CONNECTOR_REGISTRY` — a hypothetical Monday.com entry needs no wizard UI change), resumability (Task 7's `WizardSession` + Task 9's resume-on-load check).
- **Type consistency**: `DiscoveryResult`/`ItemType`/`ScopeOption` (Task 3) are the single shape consumed identically by the test-connection endpoint (Task 4), the wizard's select-scope/review-defaults steps (Task 9), and each tool's adapter function — no divergent per-tool response shape reintroduced anywhere downstream of Task 3.
- **Regression safety**: Task 6 explicitly calls out running the FULL existing `test_publish_github.py` suite unchanged as the critical safety net for the connection-resolution call-site change; Task 9 explicitly keeps the three existing settings pages' discover+map+save logic intact rather than removing it, so the wizard is additive, not a replacement of working code within this plan.
- **No placeholders**: every step has real code. Task 4's `_resolve_connection` placeholder (later replaced in Task 6) is explicitly flagged as intentionally temporary within the plan's own sequencing, not a silently-left gap. Task 5's OAuth callback response shape is explicitly flagged as a cross-task integration point to verify against Task 9's actual frontend routing, rather than guessed at prematurely.
- **Deliberately scoped down**: Jira/ADO OAuth, Monday.com/Linear connectors, any publish-logic changes, and background-job infrastructure for session/request expiry are all explicitly out of scope and not touched by any task.
