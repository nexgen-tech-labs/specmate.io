"""Tests for the connector registry (Issue #101) — the single source of truth
the wizard reads to render tool-agnostic UI. No network calls: we only assert
on the static registry data and that discovery_fn is callable, never invoking
it."""
from __future__ import annotations

from app.services.connectors.registry import CONNECTOR_REGISTRY


def test_all_three_tools_present_with_correct_keys() -> None:
    assert set(CONNECTOR_REGISTRY.keys()) == {"jira", "ado", "github"}
    for key, definition in CONNECTOR_REGISTRY.items():
        assert definition.tool_key == key


def test_jira_capabilities() -> None:
    jira = CONNECTOR_REGISTRY["jira"]
    assert jira.display_name == "Jira"
    assert jira.scope_picker_type == "PROJECT_KEY"
    assert jira.auth_methods == ["ENV_CONFIGURED"]
    assert jira.capabilities.supports_native_hierarchy is True
    assert jira.capabilities.type_system == "NAMED_TYPES"
    assert jira.capabilities.parent_link_strategy == "NATIVE_FIELD"


def test_ado_capabilities() -> None:
    ado = CONNECTOR_REGISTRY["ado"]
    assert ado.display_name == "Azure DevOps"
    assert ado.scope_picker_type == "PROJECT_NAME"
    assert ado.auth_methods == ["ENV_CONFIGURED"]
    assert ado.capabilities.supports_native_hierarchy is True
    assert ado.capabilities.type_system == "NAMED_TYPES"
    assert ado.capabilities.parent_link_strategy == "NATIVE_RELATION"


def test_github_capabilities() -> None:
    github = CONNECTOR_REGISTRY["github"]
    assert github.display_name == "GitHub"
    assert github.scope_picker_type == "REPO_FULL_NAME"
    assert github.capabilities.supports_native_hierarchy is False
    assert github.capabilities.type_system == "PUBLISHABLE_SET"
    assert github.capabilities.parent_link_strategy == "TASK_LIST_BACKFILL"


def test_github_supports_oauth_jira_and_ado_do_not() -> None:
    # Jira's OAuth app was never configured in production (see jira_oauth.py's
    # open infrastructure question about external ingress for the callback) —
    # advertising OAUTH here sends the wizard down a path that always 503s.
    # Re-add once a real Atlassian OAuth app is registered and deployed.
    assert set(CONNECTOR_REGISTRY["github"].auth_methods) == {"ENV_CONFIGURED", "OAUTH"}
    assert CONNECTOR_REGISTRY["jira"].auth_methods == ["ENV_CONFIGURED"]
    assert CONNECTOR_REGISTRY["ado"].auth_methods == ["ENV_CONFIGURED"]


def test_discovery_fn_is_callable_without_invoking_it() -> None:
    for definition in CONNECTOR_REGISTRY.values():
        assert callable(definition.discovery_fn)
