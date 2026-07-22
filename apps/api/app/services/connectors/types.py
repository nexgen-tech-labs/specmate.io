"""Shared types for the backlog/content connectors (Issues #12-16)."""

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
    about audit logging. Called with (status_code, wait_seconds, attempt) — attempt
    is the retry loop's current 1-indexed attempt number, so callers can capture how
    many tries had elapsed when this incident happened.
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
        on_rate_limited: Callable[[int, float, int], Awaitable[None]] | None = None,
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
