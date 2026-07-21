"""Shared types for the backlog/content connectors (Issues #12-16)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

import httpx


class ConnectorError(Exception):
    """Raised when a connector can't reach or authenticate against its remote —
    missing credentials, HTTP failure, or an error payload from the remote API."""


class ConnectorTransport(Protocol):
    """Abstracts *how* an HTTP request reaches the target system, away from *what*
    the request contains (Issue 11.1). Connector logic — retry/backoff loops,
    status-code branching, error-body parsing — stays in each connector's
    *_publish.py module and calls this once per attempt; the transport itself is a
    single request/response round-trip, never a retry loop.

    Returns the real `httpx.Response` (not a custom wrapper) so every existing
    `response.status_code` / `.headers.get(...)` / `.json()` / `.text` call site at
    each connector needs no changes — only the `httpx.AsyncClient(...)` open/call
    boilerplate is replaced by a `transport.request(...)` call.

    `auth` and `headers` are independent optional params because auth mechanisms
    differ per connector: Jira/ADO pass `httpx.Auth | tuple[str, str]` via `auth`;
    GitHub is header-only (`headers: dict[str, str]`, no `auth()` method at all).
    """

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
