"""Shared discovery contract (Issue #101) — each tool's existing, unchanged
discovery logic gets a thin adapter into this shape; the actual API calls to
Jira/ADO/GitHub are untouched."""
from __future__ import annotations

from dataclasses import dataclass, field


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
