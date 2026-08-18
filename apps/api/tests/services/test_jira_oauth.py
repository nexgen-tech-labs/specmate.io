"""Jira OAuth 3LO token exchange/refresh/site-discovery (fast-follow to
Issue #101) — mirrors test_github_oauth.py's service-level test shape."""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import httpx
import pytest

from app.core.config import settings
from app.services.connectors.jira_auth import (
    discover_accessible_jira_sites,
    exchange_oauth_code_for_tokens,
    refresh_jira_access_token,
)
from app.services.connectors.types import ConnectorError


class _FakeTokenResponse:
    status_code = 200

    def json(self) -> dict[str, object]:
        return {
            "access_token": "jira_access_token_value",
            "refresh_token": "jira_refresh_token_value",
            "expires_in": 3600,
        }

    def raise_for_status(self) -> None:
        pass


@pytest.mark.asyncio
async def test_exchange_oauth_code_for_tokens_returns_access_and_refresh_token() -> None:
    with (
        patch.object(settings, "jira_oauth_app_client_id", "test-client-id"),
        patch.object(settings, "jira_oauth_app_client_secret", "test-secret"),
        patch("httpx.AsyncClient.post", new=AsyncMock(return_value=_FakeTokenResponse())),
    ):
        tokens = await exchange_oauth_code_for_tokens("fake-code", "https://example.com/callback")
    assert tokens.access_token == "jira_access_token_value"
    assert tokens.refresh_token == "jira_refresh_token_value"
    assert tokens.expires_in == 3600


@pytest.mark.asyncio
async def test_exchange_oauth_code_for_tokens_raises_if_not_configured() -> None:
    with (
        patch.object(settings, "jira_oauth_app_client_id", ""),
        patch.object(settings, "jira_oauth_app_client_secret", ""),
    ):
        with pytest.raises(ConnectorError):
            await exchange_oauth_code_for_tokens("some-code", "https://example.com/callback")


@pytest.mark.asyncio
async def test_exchange_oauth_code_for_tokens_wraps_http_errors() -> None:
    fake_response = httpx.Response(
        status_code=400, request=httpx.Request("POST", "https://auth.atlassian.com/oauth/token")
    )
    with (
        patch.object(settings, "jira_oauth_app_client_id", "test-client-id"),
        patch.object(settings, "jira_oauth_app_client_secret", "test-secret"),
        patch(
            "httpx.AsyncClient.post",
            new=AsyncMock(side_effect=httpx.HTTPStatusError("bad request", request=fake_response.request, response=fake_response)),
        ),
    ):
        with pytest.raises(ConnectorError):
            await exchange_oauth_code_for_tokens("expired-code", "https://example.com/callback")


@pytest.mark.asyncio
async def test_refresh_jira_access_token_returns_rotated_tokens() -> None:
    with (
        patch.object(settings, "jira_oauth_app_client_id", "test-client-id"),
        patch.object(settings, "jira_oauth_app_client_secret", "test-secret"),
        patch("httpx.AsyncClient.post", new=AsyncMock(return_value=_FakeTokenResponse())),
    ):
        tokens = await refresh_jira_access_token("old-refresh-token")
    assert tokens.access_token == "jira_access_token_value"
    assert tokens.refresh_token == "jira_refresh_token_value"


class _FakeSitesResponse:
    status_code = 200

    def json(self) -> list[dict[str, object]]:
        return [
            {"id": "cloud-id-1", "url": "https://acme.atlassian.net", "name": "Acme", "scopes": ["read:jira-work"]},
        ]

    def raise_for_status(self) -> None:
        pass


@pytest.mark.asyncio
async def test_discover_accessible_jira_sites_returns_parsed_sites() -> None:
    with patch("httpx.AsyncClient.get", new=AsyncMock(return_value=_FakeSitesResponse())):
        sites = await discover_accessible_jira_sites("fake-access-token")
    assert len(sites) == 1
    assert sites[0].cloud_id == "cloud-id-1"
    assert sites[0].url == "https://acme.atlassian.net"


@pytest.mark.asyncio
async def test_discover_accessible_jira_sites_raises_on_empty_list() -> None:
    class _EmptyResponse:
        status_code = 200

        def json(self) -> list[dict[str, object]]:
            return []

        def raise_for_status(self) -> None:
            pass

    with patch("httpx.AsyncClient.get", new=AsyncMock(return_value=_EmptyResponse())):
        with pytest.raises(ConnectorError):
            await discover_accessible_jira_sites("fake-access-token")


@pytest.mark.asyncio
async def test_discover_accessible_jira_sites_raises_connector_error_on_malformed_entry() -> None:
    """A response entry missing an expected key (id/url/name) must surface as
    ConnectorError, not an unhandled KeyError — callers of this module only
    catch ConnectorError, per its own documented contract."""

    class _MalformedResponse:
        status_code = 200

        def json(self) -> list[dict[str, object]]:
            return [{"url": "https://acme.atlassian.net", "name": "Acme"}]  # missing "id"

        def raise_for_status(self) -> None:
            pass

    with patch("httpx.AsyncClient.get", new=AsyncMock(return_value=_MalformedResponse())):
        with pytest.raises(ConnectorError):
            await discover_accessible_jira_sites("fake-access-token")
