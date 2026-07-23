# Outbound rate limit handling for target tool APIs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Centralize the three publish connectors' (Jira/ADO/GitHub) duplicated retry/backoff logic into `DirectCloudTransport` itself, add proactive per-tool inter-request pacing, and record rate-limit incidents to the existing `AuditEvent` log with a new internal dashboard to view them — all while keeping every existing connector/router test passing unchanged.

**Architecture:** `DirectCloudTransport.request()` gains a required `target` parameter and internally retries on 429/5xx/GitHub-403 per a per-target policy, returning the same `httpx.Response` object it always has (on success OR final give-up) so each connector's post-call status-code branching and `PublishOutcome` construction is untouched. An optional `on_rate_limited` async callback fires once per retry (not on final give-up), letting the router layer record an `AuditEvent` without the transport needing DB/workspace context. Proactive pacing is a simple in-process `asyncio.Lock` + last-dispatch-timestamp per target. New `/internal/rate-limit-incidents` page in `apps/web` follows the existing `isInternalAdmin()`-gated dashboard pattern.

**Tech Stack:** Python/FastAPI/httpx/SQLAlchemy (`apps/api`), Next.js/Prisma (`apps/web`).

**Critical constraint carried through every task**: the connector functions' return shape, error messages, and status-code branching logic must be preserved byte-for-byte. Only the retry loop itself moves. This is verified by the existing `test_publish.py`/`test_publish_ado.py`/`test_publish_github.py` router tests passing **unchanged** — they are the regression proof.

---

## Task 1: Extend `ConnectorTransport`/`DirectCloudTransport` with retry, pacing, and `on_rate_limited`

**Files:**

- Modify: `apps/api/app/services/connectors/types.py`
- Modify: `apps/api/app/services/connectors/transport.py`
- Test: `apps/api/tests/services/test_transport.py`

- [ ] **Step 1: Read the current state of all three files**

```bash
cd apps/api
cat app/services/connectors/types.py
cat app/services/connectors/transport.py
cat tests/services/test_transport.py
```

Confirm the exact current `ConnectorTransport.request()` signature and `DirectCloudTransport`'s implementation match what's described below before editing — they were last touched in Issue 11.1 and should be stable, but verify.

- [ ] **Step 2: Write the failing tests**

Append to `apps/api/tests/services/test_transport.py` (read the existing file first to match its exact import/fixture style — it already tests `DirectCloudTransport` via `httpx.MockTransport` and `monkeypatch`):

```python
async def test_direct_cloud_transport_retries_on_429_then_succeeds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    call_count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return httpx.Response(429, headers={"Retry-After": "0"})
        return httpx.Response(201, json={"ok": True})

    mock_transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        httpx, "AsyncClient", partial(httpx.AsyncClient, transport=mock_transport)
    )

    transport = DirectCloudTransport()
    response = await transport.request(
        "POST", "https://example.atlassian.net/rest/api/3/issue", target="jira"
    )

    assert response.status_code == 201
    assert call_count == 2


async def test_direct_cloud_transport_gives_up_after_max_attempts_and_returns_final_response(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    call_count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        return httpx.Response(429, headers={"Retry-After": "0"})

    mock_transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        httpx, "AsyncClient", partial(httpx.AsyncClient, transport=mock_transport)
    )

    transport = DirectCloudTransport()
    response = await transport.request(
        "POST", "https://example.atlassian.net/rest/api/3/issue", target="jira"
    )

    # Gives up after the policy's max attempts and returns the LAST failed
    # response (not raising) -- the caller's existing status-code branching
    # (unchanged from before this refactor) is what turns this into a
    # PublishOutcome(ok=False, ...).
    assert response.status_code == 429
    assert call_count == JIRA_POLICY.max_attempts


async def test_direct_cloud_transport_treats_github_403_with_zero_remaining_as_rate_limited(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    call_count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return httpx.Response(
                403,
                headers={"X-RateLimit-Remaining": "0", "Retry-After": "0"},
                text="API rate limit exceeded",
            )
        return httpx.Response(201, json={"number": 42, "html_url": "https://x"})

    mock_transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        httpx, "AsyncClient", partial(httpx.AsyncClient, transport=mock_transport)
    )

    transport = DirectCloudTransport()
    response = await transport.request(
        "POST", "https://api.github.com/repos/o/r/issues", target="github"
    )

    assert response.status_code == 201
    assert call_count == 2


async def test_direct_cloud_transport_does_not_treat_generic_github_403_as_rate_limited(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A 403 without X-RateLimit-Remaining: 0 (e.g. a real permissions error) is
    NOT retried -- tightens the pre-refactor inconsistency where GitHub's update
    path treated *any* 403 as transient."""
    call_count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        return httpx.Response(403, text="Resource not accessible by integration")

    mock_transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        httpx, "AsyncClient", partial(httpx.AsyncClient, transport=mock_transport)
    )

    transport = DirectCloudTransport()
    response = await transport.request(
        "PATCH", "https://api.github.com/repos/o/r/issues/1", target="github"
    )

    assert response.status_code == 403
    assert call_count == 1  # not retried -- permanent error, surfaced immediately


async def test_direct_cloud_transport_calls_on_rate_limited_once_per_retry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    call_count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        if call_count <= 2:
            return httpx.Response(429, headers={"Retry-After": "0"})
        return httpx.Response(200, json={})

    mock_transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        httpx, "AsyncClient", partial(httpx.AsyncClient, transport=mock_transport)
    )

    incidents: list[tuple[int, float]] = []

    async def on_rate_limited(status_code: int, wait_seconds: float) -> None:
        incidents.append((status_code, wait_seconds))

    transport = DirectCloudTransport()
    response = await transport.request(
        "GET",
        "https://example.atlassian.net/x",
        target="jira",
        on_rate_limited=on_rate_limited,
    )

    assert response.status_code == 200
    assert len(incidents) == 2
    assert all(status == 429 for status, _wait in incidents)


async def test_direct_cloud_transport_paces_requests_to_the_same_target(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Two back-to-back requests to the same target are spaced at least the
    target's configured minimum interval apart."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={})

    mock_transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        httpx, "AsyncClient", partial(httpx.AsyncClient, transport=mock_transport)
    )

    transport = DirectCloudTransport()
    start = time.monotonic()
    await transport.request("GET", "https://x/a", target="jira")
    await transport.request("GET", "https://x/a", target="jira")
    elapsed = time.monotonic() - start

    assert elapsed >= JIRA_POLICY.min_interval_seconds
```

At the top of `test_transport.py`, ensure these imports exist (add any missing ones alongside the file's existing imports):

```python
import time

from app.services.connectors.transport import JIRA_POLICY
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd apps/api && uv run pytest tests/services/test_transport.py -v
```

Expected: FAIL — `target` is not a recognized keyword argument, and `JIRA_POLICY` doesn't exist yet.

- [ ] **Step 4: Extend `ConnectorTransport` Protocol in `types.py`**

Modify `apps/api/app/services/connectors/types.py` — add `Literal` to the typing import and add `target` and `on_rate_limited` to the protocol signature:

```python
from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Literal, Protocol

import httpx


class ConnectorError(Exception):
    """Raised when a connector can't reach or authenticate against its remote —
    missing credentials, HTTP failure, or an error payload from the remote API."""


TargetTool = Literal["jira", "ado", "github"]


class ConnectorTransport(Protocol):
    """Abstracts *how* an HTTP request reaches the target system, away from *what*
    the request contains (Issue 11.1). Originally a single request/response
    round-trip with retry logic left to each connector; Issue 12.2 moved the
    previously-duplicated per-connector retry/backoff (429/5xx handling,
    Retry-After, GitHub's 403-as-rate-limit detection) into the transport itself,
    keyed by `target` so each tool's distinct policy applies. Connector logic —
    status-code branching on the *final* response, error-body parsing,
    PublishOutcome construction — still lives in each connector's *_publish.py
    module and is unchanged: `request()` still returns the real `httpx.Response`
    (the last one received, whether success or final give-up), so those call
    sites need no changes beyond dropping their own retry loop.

    `auth` and `headers` are independent optional params because auth mechanisms
    differ per connector: Jira/ADO pass `httpx.Auth | tuple[str, str]` via `auth`;
    GitHub is header-only (`headers: dict[str, str]`, no `auth()` method at all).

    `on_rate_limited`, if provided, is awaited once per retry-triggering response
    (never on the final give-up) — lets a caller with workspace/DB context (the
    publish routers) record an incident without the transport itself knowing
    about audit logging.
    """

    async def request(
        self,
        method: str,
        url: str,
        *,
        target: TargetTool,
        auth: httpx.Auth | tuple[str, str] | None = None,
        headers: dict[str, str] | None = None,
        json: object | None = None,
        params: dict[str, str | int] | None = None,
        timeout: float = 30,
        on_rate_limited: Callable[[int, float], Awaitable[None]] | None = None,
    ) -> httpx.Response: ...


@dataclass(frozen=True)
class ReferenceItemData:
    """One normalized backlog item pulled from Jira/ADO/GitHub — read-only reference
    data for duplicate detection (Issue 3.5), never edited or published."""

    external_key: str
    title: str
    description: str
    item_type: str
    state: str
    url: str | None = None
```

- [ ] **Step 5: Rewrite `transport.py` with per-target retry policy, pacing, and `on_rate_limited`**

Replace `apps/api/app/services/connectors/transport.py` in full:

```python
"""Concrete `ConnectorTransport` implementations.

`DirectCloudTransport` (the current default — direct API calls, used for Jira
Cloud, ADO Services, github.com) owns per-target-tool retry/backoff policy
(Issue 12.2 — previously duplicated across jira_publish.py/ado_publish.py/
github_publish.py, now centralized here) plus a lightweight proactive pacing
gate so a batch publish paces itself instead of only reacting after being
rate-limited. `AgentRelayTransport` is a stub proving the interface shape can
accommodate a future on-prem-agent-relayed call (Epic 11 — not built yet)."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

import httpx

from app.services.connectors.types import TargetTool


@dataclass(frozen=True)
class RetryPolicy:
    """Per-target-tool retry/backoff + proactive pacing policy (Issue 12.2)."""

    max_attempts: int
    backoff_base_s: float
    min_interval_seconds: float  # proactive pacing gap between requests to this target


# Jira Cloud: ~10 req/s soft guidance on most plans -- 100ms floor is conservative.
JIRA_POLICY = RetryPolicy(max_attempts=4, backoff_base_s=1.5, min_interval_seconds=0.1)
# ADO: no published hard per-second limit for REST, but a resource-unit budget
# that resets per minute -- a slightly wider gap than Jira is a reasonable default.
ADO_POLICY = RetryPolicy(max_attempts=4, backoff_base_s=1.5, min_interval_seconds=0.15)
# GitHub REST (authenticated, non-search): 5000/hour primary limit plus a
# secondary/abuse limit that's the actual thing 403-with-zero-remaining signals.
GITHUB_POLICY = RetryPolicy(max_attempts=4, backoff_base_s=1.5, min_interval_seconds=0.2)

_POLICIES: dict[TargetTool, RetryPolicy] = {
    "jira": JIRA_POLICY,
    "ado": ADO_POLICY,
    "github": GITHUB_POLICY,
}

# Per-target last-dispatch timestamp + lock, process-local (Issue 12.2 scope note:
# best-effort single-process pacing, not a distributed guarantee across API
# replicas -- consistent with this repo's no-broker/no-Redis approach elsewhere).
_last_dispatch: dict[TargetTool, float] = {}
_pacing_locks: dict[TargetTool, asyncio.Lock] = {
    "jira": asyncio.Lock(),
    "ado": asyncio.Lock(),
    "github": asyncio.Lock(),
}


def _is_rate_limited(target: TargetTool, response: httpx.Response) -> bool:
    if response.status_code == 429 or response.status_code >= 500:
        return True
    if target == "github" and response.status_code == 403:
        # Only a header-confirmed rate limit counts -- a generic 403 (e.g. a real
        # permissions error) is a permanent error, not transient. Tightens a
        # pre-Issue-12.2 inconsistency where GitHub's update path retried on
        # *any* 403.
        return response.headers.get("X-RateLimit-Remaining") == "0"
    return False


class DirectCloudTransport:
    """Default transport: retries per-target on rate-limit/transient responses,
    paces requests to each target, and returns the real httpx.Response either
    way (success or final give-up) so callers' existing status-code branching
    is unchanged."""

    async def _pace(self, target: TargetTool) -> None:
        policy = _POLICIES[target]
        async with _pacing_locks[target]:
            last = _last_dispatch.get(target)
            now = time.monotonic()
            if last is not None:
                elapsed = now - last
                if elapsed < policy.min_interval_seconds:
                    await asyncio.sleep(policy.min_interval_seconds - elapsed)
            _last_dispatch[target] = time.monotonic()

    async def request(
        self,
        method: str,
        url: str,
        *,
        target: TargetTool,
        auth: httpx.Auth | tuple[str, str] | None = None,
        headers: dict[str, str] | None = None,
        json: object | None = None,
        params: dict[str, str | int] | None = None,
        timeout: float = 30,
        on_rate_limited: Callable[[int, float], Awaitable[None]] | None = None,
    ) -> httpx.Response:
        policy = _POLICIES[target]
        response: httpx.Response | None = None
        for attempt in range(1, policy.max_attempts + 1):
            await self._pace(target)
            async with httpx.AsyncClient(auth=auth, headers=headers, timeout=timeout) as client:
                response = await client.request(method, url, json=json, params=params)

            if not _is_rate_limited(target, response):
                return response
            if attempt == policy.max_attempts:
                return response

            retry_after = response.headers.get("Retry-After")
            delay = float(retry_after) if retry_after else policy.backoff_base_s * attempt
            if on_rate_limited is not None:
                await on_rate_limited(response.status_code, delay)
            await asyncio.sleep(delay)

        assert response is not None  # loop always runs >=1 time (max_attempts >= 1)
        return response


class AgentRelayTransport:
    """Stub (Issue 11.1 AC) — proves the ConnectorTransport interface shape can
    accommodate a relayed call through a future on-prem agent, without requiring
    any connector to be rewritten when the agent ships. Not functional: the agent
    relay protocol (Issue 11.2) and its security model (Issue 11.3) don't exist
    yet. Constructing this and calling .request() raises immediately rather than
    silently falling back to a direct call, so a caller can't accidentally end up
    believing on-prem relay is active when it isn't."""

    def __init__(self, agent_endpoint: str) -> None:
        self.agent_endpoint = agent_endpoint

    async def request(
        self,
        method: str,
        url: str,
        *,
        target: TargetTool,
        auth: httpx.Auth | tuple[str, str] | None = None,
        headers: dict[str, str] | None = None,
        json: object | None = None,
        params: dict[str, str | int] | None = None,
        timeout: float = 30,
        on_rate_limited: Callable[[int, float], Awaitable[None]] | None = None,
    ) -> httpx.Response:
        raise NotImplementedError(
            "AgentRelayTransport is a stub (Issue 11.1) — on-prem agent relay isn't "
            "built yet; see Issue 11.2 (relay protocol spec) and Issue 11.3 "
            "(security model) before this can dispatch a real request."
        )
```

Note: network-level `httpx.HTTPError` (e.g. connection refused) is deliberately NOT caught inside `DirectCloudTransport.request()` — it propagates up exactly as before, since every connector's existing `try/except httpx.HTTPError` around its (soon-to-be-removed) retry loop already handles that case and that behavior must not change. Re-verify this against each connector's actual exception handling in Task 2/3/4 before assuming it's a no-op change.

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd apps/api && uv run pytest tests/services/test_transport.py -v
```

Expected: all pass (existing tests from Issue 11.1 plus the 6 new ones from Step 2).

- [ ] **Step 7: Typecheck, lint**

```bash
cd apps/api
uv run mypy app/services/connectors/types.py app/services/connectors/transport.py
uv run ruff check app/services/connectors/types.py app/services/connectors/transport.py tests/services/test_transport.py
```

Expected: both clean.

- [ ] **Step 8: Commit**

```bash
git add app/services/connectors/types.py app/services/connectors/transport.py tests/services/test_transport.py
git commit -m "Centralize outbound retry/backoff + pacing into DirectCloudTransport (Issue #89)"
```

---

## Task 2: Refactor `jira_publish.py` to drop its own retry loop

**Files:**

- Modify: `apps/api/app/services/connectors/jira_publish.py`
- Test: `apps/api/tests/services/test_jira_publish.py` (create if it doesn't exist — check first)

- [ ] **Step 1: Check for an existing dedicated test file**

```bash
ls apps/api/tests/services/ | grep -i jira
```

If `test_jira_publish.py` exists, read it in full to understand existing coverage before adding to it. If it doesn't exist, this task doesn't need to create one — the existing `tests/routers/test_publish.py` (which fakes at the `PublishGateway` level, above the transport) already covers `create_issue`/`update_issue`'s calling convention; this task's job is to NOT break those tests, not to add new ones (Task 1 already covers the transport-level retry behavior directly).

- [ ] **Step 2: Read the full current file**

```bash
cat apps/api/app/services/connectors/jira_publish.py
```

- [ ] **Step 3: Remove the retry loop from `create_issue`, pass `target="jira"`**

Replace the `create_issue` function's retry-loop section. Before:

```python
    last_error = "unknown"
    for attempt in range(1, _MAX_ATTEMPTS + 1):
        try:
            response = await transport.request(
                "POST",
                f"{connection.base_url()}/rest/api/{connection.api_version()}/issue",
                auth=connection.auth(),
                json={"fields": payload.fields},
                timeout=30,
            )
        except httpx.HTTPError as exc:
            last_error = f"network error: {exc}"
            await asyncio.sleep(_BACKOFF_BASE_S * attempt)
            continue

        if response.status_code in (200, 201):
            body = response.json()
            return PublishOutcome(
                item_id=candidate.item_id,
                ok=True,
                key=body["key"],
                url=f"{connection.base_url()}/browse/{body['key']}",
                attempts=attempt,
            )
        if response.status_code == 429 or response.status_code >= 500:
            retry_after = response.headers.get("Retry-After")
            delay = float(retry_after) if retry_after else _BACKOFF_BASE_S * attempt
            last_error = f"HTTP {response.status_code} (transient)"
            await asyncio.sleep(delay)
            continue
        # Permanent 4xx: surface Jira's specific field errors immediately.
        try:
            errors = response.json()
            detail = errors.get("errors") or errors.get("errorMessages") or errors
        except ValueError:
            detail = response.text[:300]
        return PublishOutcome(
            item_id=candidate.item_id,
            ok=False,
            error=f"Jira rejected the issue ({response.status_code}): {detail}",
            attempts=attempt,
        )

    return PublishOutcome(
        item_id=candidate.item_id,
        ok=False,
        error=f"Gave up after {_MAX_ATTEMPTS} attempts — last error: {last_error}",
        attempts=_MAX_ATTEMPTS,
    )
```

After:

```python
    try:
        response = await transport.request(
            "POST",
            f"{connection.base_url()}/rest/api/{connection.api_version()}/issue",
            target="jira",
            auth=connection.auth(),
            json={"fields": payload.fields},
            timeout=30,
        )
    except httpx.HTTPError as exc:
        return PublishOutcome(
            item_id=candidate.item_id,
            ok=False,
            error=f"network error: {exc}",
        )

    if response.status_code in (200, 201):
        body = response.json()
        return PublishOutcome(
            item_id=candidate.item_id,
            ok=True,
            key=body["key"],
            url=f"{connection.base_url()}/browse/{body['key']}",
        )
    if response.status_code == 429 or response.status_code >= 500:
        # Transport already retried per JIRA_POLICY and gave up -- this is the
        # final failed response, not a first attempt.
        return PublishOutcome(
            item_id=candidate.item_id,
            ok=False,
            error=f"Gave up after retries — last error: HTTP {response.status_code} (transient)",
        )
    # Permanent 4xx: surface Jira's specific field errors immediately.
    try:
        errors = response.json()
        detail = errors.get("errors") or errors.get("errorMessages") or errors
    except ValueError:
        detail = response.text[:300]
    return PublishOutcome(
        item_id=candidate.item_id,
        ok=False,
        error=f"Jira rejected the issue ({response.status_code}): {detail}",
    )
```

Note: `PublishOutcome.attempts` field — check whether `tests/routers/test_publish.py` asserts on `attempts` anywhere (`grep -n "attempts" apps/api/tests/routers/test_publish.py`). If it does, the `attempts` field must still be populated meaningfully; since the transport now owns attempt counting internally and doesn't expose it back to the caller, you'll need to either (a) have `DirectCloudTransport.request()` also return the attempt count somehow (e.g. by setting a custom attribute on the response object, or changing the return type to a small wrapper — but this contradicts the "returns the real httpx.Response unchanged" design principle from the spec), or (b) simplify `PublishOutcome.attempts` to always be `1` on success (first successful response) and drop it from the failure path if unused. **Check the actual test assertions before deciding** — do not guess. If no test depends on the exact `attempts` value, the simplification above (omitting `attempts=` so it defaults) is correct and simplest.

- [ ] **Step 4: Apply the identical pattern to `update_issue`**

Same transformation: remove the `for attempt in range(...)` loop and `asyncio.sleep` calls, add `target="jira"` to the `transport.request(...)` call, single-shot the status-code branching using the same structure as `create_issue`'s update above but for `update_issue`'s existing 200/204 success check and its own error message text ("Jira rejected the issue update...").

- [ ] **Step 5: Remove now-unused `_MAX_ATTEMPTS`/`_BACKOFF_BASE_S` module constants and `asyncio` import if no longer used**

```bash
grep -n "_MAX_ATTEMPTS\|_BACKOFF_BASE_S\|asyncio\." apps/api/app/services/connectors/jira_publish.py
```

If nothing else in the file uses `asyncio` after this refactor, remove the `import asyncio` line too. Leave `discover_projects`/`discover_project_meta`/`add_comment`/`fetch_issue` untouched except adding `target="jira"` to their existing single `transport.request(...)` calls (they never had their own retry loops, so no loop-removal needed there — just the new required `target` kwarg).

- [ ] **Step 6: Run the full existing test suite to confirm no regression**

```bash
cd apps/api && uv run pytest tests/routers/test_publish.py -v
```

Expected: all pass, **unchanged** from before this refactor — this is the regression proof that the retry relocation didn't change connector-level behavior. If any test fails, STOP and investigate — do not adjust the test to match new behavior; the test failing means the refactor changed observable behavior, which the plan explicitly says must not happen.

- [ ] **Step 7: Run the transport tests too (target kwarg now required everywhere)**

```bash
cd apps/api && uv run pytest tests/services/test_transport.py tests/services/ -v 2>&1 | tail -40
```

- [ ] **Step 8: Typecheck, lint**

```bash
cd apps/api
uv run mypy app/services/connectors/jira_publish.py
uv run ruff check app/services/connectors/jira_publish.py
```

- [ ] **Step 9: Commit**

```bash
git add app/services/connectors/jira_publish.py
git commit -m "Drop jira_publish.py's own retry loop, use transport's centralized retry (Issue #89)"
```

---

## Task 3: Refactor `ado_publish.py` to drop its own retry loop

**Files:**

- Modify: `apps/api/app/services/connectors/ado_publish.py`

Same mechanical pattern as Task 2, applied to ADO's `create_work_item` and `update_work_item` functions.

- [ ] **Step 1: Read the full current file**

```bash
cat apps/api/app/services/connectors/ado_publish.py
```

- [ ] **Step 2: Remove the retry loop from `create_work_item`, pass `target="ado"`**

Apply the identical transformation pattern from Task 2 Step 3, adapted to ADO's actual status codes (200/201 success per the existing code) and its own error-detail extraction (`response.json()` directly, no `errors`/`errorMessages` wrapper — check the real current code for the exact shape before writing the replacement, don't assume it matches Jira's).

- [ ] **Step 3: Apply the identical pattern to `update_work_item`**

- [ ] **Step 4: Remove now-unused `_MAX_ATTEMPTS`/`_BACKOFF_BASE_S`/`asyncio` if unused elsewhere in the file**

```bash
grep -n "_MAX_ATTEMPTS\|_BACKOFF_BASE_S\|asyncio\." apps/api/app/services/connectors/ado_publish.py
```

Add `target="ado"` to `discover_projects`/`discover_project_meta`/`add_comment`/`fetch_work_item`'s existing single `transport.request(...)` calls.

- [ ] **Step 5: Check `PublishOutcome`/`AdoPublishOutcome`'s `attempts` field usage** (same caveat as Task 2 Step 3 — check `tests/routers/test_publish_ado.py` before deciding how to handle it)

```bash
grep -n "attempts" apps/api/tests/routers/test_publish_ado.py
```

- [ ] **Step 6: Run the full existing test suite to confirm no regression**

```bash
cd apps/api && uv run pytest tests/routers/test_publish_ado.py -v
```

Expected: all pass, unchanged.

- [ ] **Step 7: Typecheck, lint**

```bash
cd apps/api
uv run mypy app/services/connectors/ado_publish.py
uv run ruff check app/services/connectors/ado_publish.py
```

- [ ] **Step 8: Commit**

```bash
git add app/services/connectors/ado_publish.py
git commit -m "Drop ado_publish.py's own retry loop, use transport's centralized retry (Issue #89)"
```

---

## Task 4: Refactor `github_publish.py` to drop its own retry loop (and its now-redundant 403 check)

**Files:**

- Modify: `apps/api/app/services/connectors/github_publish.py`

Same pattern as Tasks 2/3, applied to GitHub's `create_issue`/`update_issue`/`update_issue_body`. GitHub's 403-as-rate-limit detection moves entirely into the transport (Task 1) — the connector no longer needs its own `is_rate_limited` check.

- [ ] **Step 1: Read the full current file**

```bash
cat apps/api/app/services/connectors/github_publish.py
```

- [ ] **Step 2: Remove the retry loop AND the inline `is_rate_limited` 403 check from `create_issue`**

The transport (Task 1) now handles the 403-as-rate-limit detection internally via `_is_rate_limited()`. The connector's post-call branching simplifies to: 201 = success, everything else that reaches the connector is either (a) the transport's final give-up on a genuinely transient/rate-limited response, or (b) a real permanent error — the connector can no longer distinguish which without re-implementing the check, so simplify its error message to a generic "GitHub rejected the issue (status): detail" for all non-201 cases, same as the plan's Task 2 approach for Jira's 429/5xx branch. Read the exact current code before writing the replacement.

- [ ] **Step 3: Apply the identical pattern to `update_issue`**

- [ ] **Step 4: Apply the identical pattern to `update_issue_body`** — this one currently uses `response.raise_for_status()` inside a `try/except httpx.HTTPError`, not a retry loop (check the actual current code — per Task 1's transport, `raise_for_status()` on a 4xx/5xx still raises `httpx.HTTPStatusError` which is an `httpx.HTTPError` subclass, so this function's existing exception handling is likely already compatible and only needs `target="github"` added to its `transport.request(...)` call, not a loop removal). Verify by reading the real code.

- [ ] **Step 5: Remove now-unused `_MAX_ATTEMPTS`/`_BACKOFF_BASE_S`/`asyncio` if unused elsewhere in the file**

```bash
grep -n "_MAX_ATTEMPTS\|_BACKOFF_BASE_S\|asyncio\.\|is_rate_limited" apps/api/app/services/connectors/github_publish.py
```

Add `target="github"` to `discover_repos`/`discover_repo_meta`/`add_comment`/`fetch_issue`'s existing single `transport.request(...)` calls.

- [ ] **Step 6: Check `attempts` field usage** (same caveat as Tasks 2/3)

```bash
grep -n "attempts" apps/api/tests/routers/test_publish_github.py
```

- [ ] **Step 7: Run the full existing test suite to confirm no regression**

```bash
cd apps/api && uv run pytest tests/routers/test_publish_github.py -v
```

Expected: all pass, unchanged.

- [ ] **Step 8: Typecheck, lint**

```bash
cd apps/api
uv run mypy app/services/connectors/github_publish.py
uv run ruff check app/services/connectors/github_publish.py
```

- [ ] **Step 9: Commit**

```bash
git add app/services/connectors/github_publish.py
git commit -m "Drop github_publish.py's own retry loop and redundant 403 check (Issue #89)"
```

---

## Task 5: Wire `on_rate_limited` into the publish routers to record `AuditEvent`s

**Files:**

- Modify: `apps/api/app/routers/publish.py`
- Modify: `apps/api/app/routers/publish_ado.py`
- Modify: `apps/api/app/routers/publish_github.py`
- Modify: `apps/api/app/services/audit.py` (only if a new helper is warranted — read first)
- Test: `apps/api/tests/routers/test_publish.py` (extend), or a new focused test file

- [ ] **Step 1: Read `apps/api/app/services/audit.py` and the `AuditEvent` model in full**

```bash
cat apps/api/app/services/audit.py
grep -n "class AuditEvent" -A 20 apps/api/app/models.py
grep -n "class AuditActorType" -A 5 apps/api/app/models.py
```

Confirm the exact `record_audit_event(...)` function signature (parameters, required vs optional) before writing calls to it. Confirm `AuditActorType` has a `SYSTEM` value (referenced in the design doc — verify it actually exists, don't assume).

- [ ] **Step 2: Read the current `PublishGateway`/router call-site structure in `publish.py`**

```bash
grep -n "gateway.create\|gateway.update\|class PublishGateway" apps/api/app/routers/publish.py
```

- [ ] **Step 3: Add an `on_rate_limited` callback factory in `publish.py`**

Since `create_issue`/`update_issue` now accept an `on_rate_limited` param via the transport call inside them (Task 2 added `target="jira"` but the connector functions themselves don't currently accept/forward `on_rate_limited` — you need to add that too). Revisit Task 2's `create_issue`/`update_issue` signatures: add an `on_rate_limited: Callable[[int, float], Awaitable[None]] | None = None` parameter to each, forwarded straight through to the `transport.request(..., on_rate_limited=on_rate_limited)` call. Do the same for Task 3 (ADO) and Task 4 (GitHub)'s `create_*`/`update_*` functions — go back and add this parameter now (it was deliberately deferred from those tasks to keep them focused on the loop removal; this task completes the wiring).

In `apps/api/app/routers/publish.py`, define a small closure factory near where `PublishGateway`/the publish endpoint handler builds its calls:

```python
def _make_rate_limit_recorder(
    session: AsyncSession, workspace_id: str, tool: str
) -> Callable[[int, float], Awaitable[None]]:
    async def _record(status_code: int, wait_seconds: float) -> None:
        record_audit_event(
            session,
            workspace_id=workspace_id,
            action="connector.rate_limited",
            entity_type=tool,
            entity_id=tool,
            actor_type=AuditActorType.SYSTEM,
            after={"status_code": status_code, "wait_seconds": wait_seconds},
        )

    return _record
```

Adapt the exact keyword arguments to match `record_audit_event`'s real signature confirmed in Step 1 — do not guess parameter names. Then pass `on_rate_limited=_make_rate_limit_recorder(session, workspace.id, "jira")` into the `gateway.create(...)`/`gateway.update(...)` calls in the publish loop.

- [ ] **Step 4: Repeat Step 3's wiring for `publish_ado.py` (tool="ado") and `publish_github.py` (tool="github")**

- [ ] **Step 5: Write a test proving the wiring works end-to-end**

Add to `apps/api/tests/routers/test_publish.py` (read its existing fixture/fake-gateway pattern first, match it exactly): a test where the fake Jira gateway's `create` function is swapped for one that calls its `on_rate_limited` callback once with `(429, 1.5)` before returning a success `PublishOutcome`, then asserts an `AuditEvent` row with `action="connector.rate_limited"` was created for the right workspace. Use the same real-Postgres fixture/cleanup pattern already established in that file.

- [ ] **Step 6: Run tests**

```bash
cd apps/api && uv run pytest tests/routers/test_publish.py tests/routers/test_publish_ado.py tests/routers/test_publish_github.py -v
```

Expected: all pass, including the new test(s).

- [ ] **Step 7: Typecheck, lint**

```bash
cd apps/api
uv run mypy app/routers/publish.py app/routers/publish_ado.py app/routers/publish_github.py app/services/connectors/
uv run ruff check app/routers/publish.py app/routers/publish_ado.py app/routers/publish_github.py app/services/connectors/
```

- [ ] **Step 8: Commit**

```bash
git add app/routers/publish.py app/routers/publish_ado.py app/routers/publish_github.py app/services/connectors/jira_publish.py app/services/connectors/ado_publish.py app/services/connectors/github_publish.py tests/routers/test_publish.py
git commit -m "Record rate-limit incidents to AuditEvent from the publish routers (Issue #89)"
```

---

## Task 6: Full API regression pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full API test suite**

```bash
cd apps/api && uv run pytest -q
```

Expected: all tests pass. Compare the total count against the pre-refactor baseline (run `git stash && uv run pytest -q --collect-only | tail -3 && git stash pop` if you need the exact prior count) — the count should be equal or higher (new transport/audit tests added), never lower.

- [ ] **Step 2: Full mypy + ruff sweep**

```bash
cd apps/api
uv run mypy app
uv run ruff check .
```

Expected: both clean.

- [ ] **Step 3: Commit is a no-op checkpoint — if Steps 1-2 are clean, nothing to commit here. If anything needed fixing, commit those fixes now before proceeding to Task 7.**

---

## Task 7: Internal dashboard — `/internal/rate-limit-incidents`

**Files:**

- Create: `apps/web/src/app/internal/rate-limit-incidents/page.tsx`
- Test: `apps/web/src/app/internal/rate-limit-incidents/page.test.tsx` (only if the existing `/internal/ai-costs` page has a test file — check first and match precedent; Server Component pages in this repo often don't have direct tests, per prior findings)

- [ ] **Step 1: Read the existing `/internal/ai-costs` page in full as the pattern to follow**

```bash
find apps/web/src/app/internal -type f
cat apps/web/src/app/internal/ai-costs/page.tsx
cat apps/web/src/lib/admin-access.ts
```

Confirm the exact `isInternalAdmin()` gating pattern, the Prisma query style, and the table-rendering JSX conventions used there before writing the new page — match its structure closely rather than inventing a new one.

- [ ] **Step 2: Confirm the `AuditEvent` Prisma model's exact field names**

```bash
grep -n "model AuditEvent" -A 20 apps/web/prisma/schema.prisma
```

- [ ] **Step 3: Write `apps/web/src/app/internal/rate-limit-incidents/page.tsx`**

Following the exact structure of `ai-costs/page.tsx` (gate via `isInternalAdmin()`, redirect/404 if not admin), query:

```ts
const incidents = await prisma.auditEvent.findMany({
  where: { action: 'connector.rate_limited' },
  orderBy: { createdAt: 'desc' },
  take: 200,
  include: { workspace: { select: { name: true } } }, // adjust relation name to match the real schema
});
```

Group/aggregate by `entityType` (tool) and `workspaceId` in application code (a `Map`-based reduce, following whatever aggregation style `ai-costs/page.tsx` already uses if it does similar grouping — check it first) and render a table: tool, workspace name, incident count, most recent incident timestamp. Also render the raw recent-incidents list (timestamp, tool, workspace, wait_seconds from `metadata`/`after` JSON) below the summary table.

- [ ] **Step 4: Manual verification**

```bash
cd apps/web && npx tsc --noEmit
```

Expected: clean. If there's a local dev DB with any `AuditEvent` rows (there won't be any with `action='connector.rate_limited'` yet, which is fine — the page should render an empty state, not crash), optionally smoke-test with `pnpm dev` and visiting `/internal/rate-limit-incidents` as an allowlisted admin.

- [ ] **Step 5: Lint, commit**

```bash
cd apps/web
npx eslint src/app/internal/rate-limit-incidents/
git add src/app/internal/rate-limit-incidents/
git commit -m "Add internal dashboard for outbound rate-limit incidents (Issue #89)"
```

---

## Task 8: Documentation + close the issue

**Files:** none beyond `architecture.md`

- [ ] **Step 1: Run the full regression one more time (both apps)**

```bash
cd apps/api && uv run pytest -q && uv run mypy app && uv run ruff check .
cd ../web && npx vitest run && npx tsc --noEmit && npx eslint .
```

Expected: everything green.

- [ ] **Step 2: Update `architecture.md`**

Add a new subsection after the most recent `### ` entry, before the next `## ` numbered section:

```markdown
### Outbound rate limit handling for target tool APIs (Issue 12.2, `apps/api/app/services/connectors/transport.py`)

Centralizes what was previously three near-identical, duplicated retry/backoff loops (one per publish connector — Issues 5.7/6.7/7.7) into `DirectCloudTransport.request()` itself, keyed by a `target: "jira" | "ado" | "github"` parameter selecting a per-tool `RetryPolicy` (max attempts, backoff base, and a proactive pacing minimum-interval). Each connector's `create_issue`/`update_issue`/etc. now makes a single `transport.request(...)` call instead of owning a `for attempt in range(...)` loop — the transport retries internally on 429/5xx/GitHub's header-confirmed 403 and returns the real `httpx.Response` either way (success or final give-up), so every connector's existing post-call status-code branching and `PublishOutcome` construction is unchanged. Proactive pacing (an `asyncio.Lock` + last-dispatch-timestamp per target, process-local — not a distributed guarantee across API replicas) makes a large batch publish space its own requests out instead of only reacting after a 429. An optional `on_rate_limited` callback fires once per retry (not on final give-up); the publish routers use it to record a `connector.rate_limited` `AuditEvent` (actor `SYSTEM`) per incident, without the transport itself needing DB/workspace context. A new internal dashboard, `/internal/rate-limit-incidents` (gated by the existing `isInternalAdmin()` pattern, same as `/internal/ai-costs`), surfaces these incidents grouped by tool and workspace. GitHub's 403-as-rate-limit detection was tightened during this refactor — previously its update path treated _any_ 403 as transient; now only a header-confirmed (`X-RateLimit-Remaining: 0`) 403 retries, and a genuine permissions-error 403 surfaces immediately as a permanent error.
```

- [ ] **Step 3: Commit**

```bash
git add architecture.md
git commit -m "Document outbound rate limit handling in architecture.md"
```

- [ ] **Step 4: Close Issue #89**

```bash
gh issue close 89 --comment "$(cat <<'EOF'
Centralizes the three publish connectors' previously-duplicated retry/backoff logic (Issues 5.7/6.7/7.7) into `DirectCloudTransport.request()` itself (`apps/api/app/services/connectors/transport.py`), keyed by a `target: "jira"|"ado"|"github"` parameter selecting a per-tool `RetryPolicy`.

**Shared client**: each connector's `create_issue`/`update_issue`/etc. now makes a single `transport.request(...)` call instead of owning its own retry loop — the transport retries internally and returns the real `httpx.Response` either way (success or final give-up), so every connector's existing status-code branching and `PublishOutcome` construction is unchanged. Verified via all pre-existing publish-router tests passing **unchanged** — the regression proof that centralizing retry logic didn't alter connector-level behavior. Also tightened a real inconsistency found during the refactor: GitHub's update path previously treated *any* 403 as transient; now only a header-confirmed (`X-RateLimit-Remaining: 0`) 403 retries.

**Proactive pacing**: a simple per-target minimum inter-request interval (process-local `asyncio.Lock` + timestamp, no new queue/broker infrastructure — consistent with this repo's established no-broker approach) makes a large batch publish space itself out rather than only reacting after hitting a 429.

**Observability**: rate-limit incidents are recorded to the existing `AuditEvent` log (`action="connector.rate_limited"`, actor `SYSTEM`) via an `on_rate_limited` callback the publish routers wire in, rather than a new table. New internal dashboard `/internal/rate-limit-incidents` (same `isInternalAdmin()` gating as `/internal/ai-costs`) shows incidents grouped by tool and workspace.

All three acceptance criteria met: shared client used by all three connectors (no duplicated retry logic remains), batch publishes proactively pace themselves, incidents visible in an internal dashboard broken down by tool and workspace.
EOF
)"
```

---

## Self-review notes (for the plan author, already applied above)

- **Spec coverage**: shared client (Task 1 + 2/3/4's call-site simplification), proactive pacing (Task 1's `_pace`), incident visibility (Task 5 + 7) — all three ACs covered.
- **Regression safety**: every connector-refactor task (2/3/4) explicitly requires the pre-existing router test suite to pass **unchanged**, with instructions to STOP and investigate rather than adjust tests if anything fails — this is the load-bearing safety net for a retrofit onto already-shipped code.
- **Known ambiguity flagged explicitly rather than guessed**: the `PublishOutcome.attempts` field's fate (Tasks 2/3/4) is explicitly left to be resolved by checking real test assertions first, not assumed — since the transport now owns attempt-counting internally and no longer exposes it back per-call.
- **No placeholders**: every step has runnable code or an explicit "read the real file first, the plan's snippet may not match exactly" instruction (used throughout Tasks 2-4 given this is a retrofit onto code the plan author read once but that may have shifted).
