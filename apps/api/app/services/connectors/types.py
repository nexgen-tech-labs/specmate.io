"""Shared types for the backlog/content connectors (Issues #12-16)."""

from __future__ import annotations

from dataclasses import dataclass


class ConnectorError(Exception):
    """Raised when a connector can't reach or authenticate against its remote —
    missing credentials, HTTP failure, or an error payload from the remote API."""


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
