"""Tests for the per-tool discover_as_result adapters (Issue #101) — these wrap
the existing, unchanged discover_projects/discover_project_meta/discover_repos/
discover_repo_meta functions into the shared DiscoveryResult shape. We
monkeypatch the underlying module-level discovery functions (the same
functions the adapters call) so no real HTTP happens, and assert the adapter
output preserves all the information the old bespoke dict shape had."""
from __future__ import annotations

import pytest

from app.services.connectors import ado_publish, github_publish, jira_publish
from app.services.connectors.ado_auth import PatConnection
from app.services.connectors.github_auth import TokenConnection
from app.services.connectors.jira_auth import CloudTokenConnection


# ---------- Jira ----------


@pytest.mark.asyncio
async def test_jira_discover_as_result_no_project_key(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_discover_projects(connection, transport=None):
        return [{"key": "ABC", "name": "Alphabet"}, {"key": "XYZ", "name": "Xylophone"}]

    monkeypatch.setattr(jira_publish, "discover_projects", fake_discover_projects)

    connection = CloudTokenConnection(email="a@b.com", token="t", url="https://x.atlassian.net")
    result = await jira_publish.discover_as_result(connection)

    assert [o.id for o in result.scope_options] == ["ABC", "XYZ"]
    assert result.scope_options[0].label == "Alphabet (ABC)"
    assert result.item_types is None
    assert result.extras == {}


@pytest.mark.asyncio
async def test_jira_discover_as_result_preserves_field_requirement_data(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_discover_projects(connection, transport=None):
        return [{"key": "ABC", "name": "Alphabet"}]

    async def fake_discover_project_meta(connection, project_key, transport=None):
        assert project_key == "ABC"
        return {
            "project_key": "ABC",
            "issue_types": [
                {
                    "id": "10001",
                    "name": "Story",
                    "subtask": False,
                    "fields": [
                        {"id": "summary", "name": "Summary", "required": True, "has_default": False},
                        {
                            "id": "priority",
                            "name": "Priority",
                            "required": False,
                            "has_default": True,
                        },
                    ],
                },
                {"id": "10002", "name": "Sub-task", "subtask": True, "fields": []},
            ],
        }

    monkeypatch.setattr(jira_publish, "discover_projects", fake_discover_projects)
    monkeypatch.setattr(jira_publish, "discover_project_meta", fake_discover_project_meta)

    connection = CloudTokenConnection(email="a@b.com", token="t", url="https://x.atlassian.net")
    result = await jira_publish.discover_as_result(connection, project_key="ABC")

    assert result.item_types is not None
    story = result.item_types[0]
    assert story.id == "10001"
    assert story.name == "Story"
    assert story.supports_children is True  # not a subtask

    summary_field, priority_field = story.fields
    assert summary_field.id == "summary"
    assert summary_field.required is True
    assert summary_field.has_default is False
    assert priority_field.id == "priority"
    assert priority_field.required is False
    assert priority_field.has_default is True

    subtask = result.item_types[1]
    assert subtask.supports_children is False  # is a subtask


# ---------- ADO ----------


@pytest.mark.asyncio
async def test_ado_discover_as_result_required_fields_only(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_discover_projects(connection, transport=None):
        return [{"id": "proj-1", "name": "Project One"}]

    async def fake_discover_project_meta(connection, project_name, transport=None):
        assert project_name == "Project One"
        return {
            "project_name": "Project One",
            "work_item_types": [
                {
                    "name": "User Story",
                    "required_fields": [{"id": "System.Title", "name": "Title"}],
                }
            ],
            "area_paths": ["Project One", "Project One\\TeamA"],
            "iteration_paths": ["Project One", "Project One\\Sprint 1"],
        }

    monkeypatch.setattr(ado_publish, "discover_projects", fake_discover_projects)
    monkeypatch.setattr(ado_publish, "discover_project_meta", fake_discover_project_meta)

    connection = PatConnection(pat="secret", url="https://dev.azure.com/org")
    result = await ado_publish.discover_as_result(connection, project_name="Project One")

    assert [o.id for o in result.scope_options] == ["proj-1"]
    assert result.scope_options[0].label == "Project One"

    assert result.item_types is not None
    user_story = result.item_types[0]
    assert user_story.name == "User Story"
    field = user_story.fields[0]
    assert field.id == "System.Title"
    assert field.name == "Title"
    assert field.required is True
    assert field.has_default is False

    assert result.extras == {
        "area_paths": ["Project One", "Project One\\TeamA"],
        "iteration_paths": ["Project One", "Project One\\Sprint 1"],
    }


@pytest.mark.asyncio
async def test_ado_discover_as_result_no_project_name(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_discover_projects(connection, transport=None):
        return [{"id": "proj-1", "name": "Project One"}]

    monkeypatch.setattr(ado_publish, "discover_projects", fake_discover_projects)

    connection = PatConnection(pat="secret", url="https://dev.azure.com/org")
    result = await ado_publish.discover_as_result(connection)

    assert result.item_types is None
    assert result.extras == {}


# ---------- GitHub ----------


@pytest.mark.asyncio
async def test_github_discover_as_result_no_item_types(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_discover_repos(connection, transport=None):
        return [{"full_name": "acme/widgets", "id": "123"}]

    monkeypatch.setattr(github_publish, "discover_repos", fake_discover_repos)

    connection = TokenConnection(token="t")
    result = await github_publish.discover_as_result(connection)

    assert result.item_types is None
    assert [o.id for o in result.scope_options] == ["acme/widgets"]
    assert result.scope_options[0].label == "acme/widgets"
    assert result.extras == {}


@pytest.mark.asyncio
async def test_github_discover_as_result_extras_only_when_repo_given(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_discover_repos(connection, transport=None):
        return [{"full_name": "acme/widgets", "id": "123"}]

    async def fake_discover_repo_meta(connection, repo, transport=None):
        assert repo == "acme/widgets"
        return {
            "repo": "acme/widgets",
            "labels": ["bug", "enhancement"],
            "milestones": [{"number": 1, "title": "v1.0"}],
            "file_paths": ["README.md", "src/index.ts"],
        }

    monkeypatch.setattr(github_publish, "discover_repos", fake_discover_repos)
    monkeypatch.setattr(github_publish, "discover_repo_meta", fake_discover_repo_meta)

    connection = TokenConnection(token="t")
    result = await github_publish.discover_as_result(connection, repo="acme/widgets")

    assert result.item_types is None
    assert result.extras == {
        "labels": ["bug", "enhancement"],
        "milestones": [{"number": 1, "title": "v1.0"}],
        "file_paths": ["README.md", "src/index.ts"],
    }
