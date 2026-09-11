"""Azure DevOps delegated OAuth token exchange/refresh (Issue 10.4) — mirrors
test_jira_oauth.py's service-level test shape."""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import httpx
import pytest

from app.core.config import settings
from app.services.connectors.ado_auth import (
    exchange_ado_oauth_code_for_tokens,
    refresh_ado_access_token,
)
from app.services.connectors.types import ConnectorError


class _FakeTokenResponse:
    status_code = 200

    def json(self) -> dict[str, object]:
        return {
            "access_token": "ado_access_token_value",
            "refresh_token": "ado_refresh_token_value",
            "expires_in": 3600,
        }


@pytest.mark.asyncio
async def test_exchange_ado_oauth_code_for_tokens_returns_access_and_refresh_token() -> None:
    with (
        patch.object(settings, "azure_ad_client_id", "test-client-id"),
        patch.object(settings, "azure_ad_client_secret", "test-secret"),
        patch.object(settings, "azure_ad_tenant_id", "test-tenant-id"),
        patch("httpx.AsyncClient.post", new=AsyncMock(return_value=_FakeTokenResponse())),
    ):
        tokens = await exchange_ado_oauth_code_for_tokens("fake-code", "https://example.com/callback")
    assert tokens.access_token == "ado_access_token_value"
    assert tokens.refresh_token == "ado_refresh_token_value"
    assert tokens.expires_in == 3600


@pytest.mark.asyncio
async def test_exchange_ado_oauth_code_for_tokens_raises_if_not_configured() -> None:
    with (
        patch.object(settings, "azure_ad_client_id", ""),
        patch.object(settings, "azure_ad_client_secret", ""),
        patch.object(settings, "azure_ad_tenant_id", ""),
    ):
        with pytest.raises(ConnectorError):
            await exchange_ado_oauth_code_for_tokens("some-code", "https://example.com/callback")


@pytest.mark.asyncio
async def test_exchange_ado_oauth_code_for_tokens_wraps_http_errors() -> None:
    with (
        patch.object(settings, "azure_ad_client_id", "test-client-id"),
        patch.object(settings, "azure_ad_client_secret", "test-secret"),
        patch.object(settings, "azure_ad_tenant_id", "test-tenant-id"),
        patch("httpx.AsyncClient.post", new=AsyncMock(side_effect=httpx.ConnectError("boom"))),
    ):
        with pytest.raises(ConnectorError):
            await exchange_ado_oauth_code_for_tokens("some-code", "https://example.com/callback")


@pytest.mark.asyncio
async def test_exchange_ado_oauth_code_for_tokens_surfaces_entra_error_body_on_non_200() -> None:
    fake_response = httpx.Response(
        status_code=400,
        json={"error": "invalid_grant", "error_description": "AADSTS70008: expired code."},
        request=httpx.Request(
            "POST", "https://login.microsoftonline.com/test-tenant-id/oauth2/v2.0/token"
        ),
    )
    with (
        patch.object(settings, "azure_ad_client_id", "test-client-id"),
        patch.object(settings, "azure_ad_client_secret", "test-secret"),
        patch.object(settings, "azure_ad_tenant_id", "test-tenant-id"),
        patch("httpx.AsyncClient.post", new=AsyncMock(return_value=fake_response)),
    ):
        with pytest.raises(ConnectorError, match="400"):
            await exchange_ado_oauth_code_for_tokens("expired-code", "https://example.com/callback")


@pytest.mark.asyncio
async def test_refresh_ado_access_token_returns_rotated_tokens() -> None:
    with (
        patch.object(settings, "azure_ad_client_id", "test-client-id"),
        patch.object(settings, "azure_ad_client_secret", "test-secret"),
        patch.object(settings, "azure_ad_tenant_id", "test-tenant-id"),
        patch("httpx.AsyncClient.post", new=AsyncMock(return_value=_FakeTokenResponse())),
    ):
        tokens = await refresh_ado_access_token("old-refresh-token")
    assert tokens.access_token == "ado_access_token_value"
    assert tokens.refresh_token == "ado_refresh_token_value"


@pytest.mark.asyncio
async def test_refresh_ado_access_token_raises_if_not_configured() -> None:
    with (
        patch.object(settings, "azure_ad_client_id", ""),
        patch.object(settings, "azure_ad_client_secret", ""),
        patch.object(settings, "azure_ad_tenant_id", ""),
    ):
        with pytest.raises(ConnectorError):
            await refresh_ado_access_token("old-refresh-token")
