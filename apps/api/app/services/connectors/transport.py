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


def _parse_retry_after_seconds(retry_after: str | None, fallback: float) -> float:
    """Parse a `Retry-After` header value. RFC 9110 permits either a delay in
    seconds (e.g. "120") or an HTTP-date (e.g. "Wed, 21 Oct 2026 07:28:00 GMT").
    We only handle the delay-seconds form; any other form (including an
    HTTP-date, which some gateways/CDNs in front of Jira/ADO/GitHub could
    plausibly send) falls back to the computed backoff rather than crashing
    the retry loop."""
    if not retry_after:
        return fallback
    try:
        return float(retry_after)
    except ValueError:
        return fallback


def _is_rate_limited(target: TargetTool, response: httpx.Response) -> bool:
    if response.status_code == 429 or response.status_code >= 500:
        return True
    if target == "github" and response.status_code == 403:
        # Only a header-confirmed rate limit counts -- a generic 403 (e.g. a real
        # permissions error) is a permanent error, not transient. Tightens a
        # pre-Issue-12.2 inconsistency where GitHub's update path retried on
        # *any* 403.
        return bool(response.headers.get("X-RateLimit-Remaining") == "0")
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
            delay = _parse_retry_after_seconds(retry_after, policy.backoff_base_s * attempt)
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
