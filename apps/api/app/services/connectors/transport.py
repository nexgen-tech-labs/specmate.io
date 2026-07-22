"""Concrete `ConnectorTransport` implementations (Issue 11.1).

Two today: `DirectCloudTransport` (the current default — direct API calls, used
for Jira Cloud, ADO Services, github.com) and a stubbed `AgentRelayTransport`
proving the interface shape can accommodate a future on-prem-agent-relayed call
without any connector code changing (Epic 11 — not built yet, see Issues 11.2/11.3)."""

from __future__ import annotations

import httpx


class DirectCloudTransport:
    """Default transport — one-shot: opens a client, makes one request, closes it.
    Retry/backoff is deliberately NOT here; each *_publish.py function already
    loops and calls this once per attempt, catching httpx.HTTPError itself. Adding
    a second retry layer here would just duplicate that behavior with no change,
    so this stays a thin pass-through to httpx."""

    async def request(
        self,
        method: str,
        url: str,
        *,
        auth: httpx.Auth | tuple[str, str] | None = None,
        headers: dict[str, str] | None = None,
        json: object | None = None,
        params: dict[str, str | int] | None = None,
        timeout: float = 30,
    ) -> httpx.Response:
        async with httpx.AsyncClient(auth=auth, headers=headers, timeout=timeout) as client:
            return await client.request(method, url, json=json, params=params)


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
        auth: httpx.Auth | tuple[str, str] | None = None,
        headers: dict[str, str] | None = None,
        json: object | None = None,
        params: dict[str, str | int] | None = None,
        timeout: float = 30,
    ) -> httpx.Response:
        raise NotImplementedError(
            "AgentRelayTransport is a stub (Issue 11.1) — on-prem agent relay isn't "
            "built yet; see Issue 11.2 (relay protocol spec) and Issue 11.3 "
            "(security model) before this can dispatch a real request."
        )
