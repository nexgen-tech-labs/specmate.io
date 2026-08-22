"""Connector registry (Issue #101) — the single source of truth the wizard
reads to render tool-agnostic UI. Adding a future connector (Monday.com,
Linear) means adding one entry here, not touching wizard UI components."""
from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Literal

from app.services.connectors import ado_publish, github_publish, jira_publish
from app.services.connectors.discovery_types import DiscoveryResult


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
        auth_methods=["ENV_CONFIGURED", "OAUTH"],
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
            supports_native_hierarchy=False,
            type_system="PUBLISHABLE_SET",
            parent_link_strategy="TASK_LIST_BACKFILL",
        ),
    ),
}
