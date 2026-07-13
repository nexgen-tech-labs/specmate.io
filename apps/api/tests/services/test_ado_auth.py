"""Epic 6 ADO connection selection tests: OAuth preferred over PAT when
configured, PAT fallback otherwise, and app-only token fetch/caching."""

from __future__ import annotations

import httpx
import pytest

from app.core.config import settings
from app.services.connectors.ado_auth import (
    OAuthConnection,
    PatConnection,
    _OAuthBearerAuth,
    get_ado_connection,
)
from app.services.connectors.types import ConnectorError


@pytest.fixture(autouse=True)
def _reset_settings():
    original = (
        settings.ado_org_url,
        settings.ado_pat,
        settings.azure_ad_client_id,
        settings.azure_ad_client_secret,
        settings.azure_ad_tenant_id,
    )
    yield
    (
        settings.ado_org_url,
        settings.ado_pat,
        settings.azure_ad_client_id,
        settings.azure_ad_client_secret,
        settings.azure_ad_tenant_id,
    ) = original


def test_raises_when_org_url_missing() -> None:
    settings.ado_org_url = ""
    with pytest.raises(ConnectorError, match="ADO_ORG_URL"):
        get_ado_connection()


def test_falls_back_to_pat_when_azure_ad_not_configured() -> None:
    settings.ado_org_url = "https://dev.azure.com/acme"
    settings.ado_pat = "fake-pat"
    settings.azure_ad_client_id = ""
    settings.azure_ad_client_secret = ""
    settings.azure_ad_tenant_id = ""

    conn = get_ado_connection()

    assert isinstance(conn, PatConnection)
    assert conn.auth() == ("", "fake-pat")


def test_raises_when_neither_oauth_nor_pat_configured() -> None:
    settings.ado_org_url = "https://dev.azure.com/acme"
    settings.ado_pat = ""
    settings.azure_ad_client_id = ""
    settings.azure_ad_client_secret = ""
    settings.azure_ad_tenant_id = ""

    with pytest.raises(ConnectorError, match="AZURE_AD_CLIENT_ID"):
        get_ado_connection()


def test_prefers_oauth_when_all_three_azure_ad_settings_present() -> None:
    settings.ado_org_url = "https://dev.azure.com/acme"
    settings.ado_pat = "fake-pat"  # present but should be ignored
    settings.azure_ad_client_id = "client-id"
    settings.azure_ad_client_secret = "client-secret"
    settings.azure_ad_tenant_id = "tenant-id"

    conn = get_ado_connection()

    assert isinstance(conn, OAuthConnection)
    assert conn.org_url() == "https://dev.azure.com/acme"
    assert isinstance(conn.auth(), httpx.Auth)


def test_oauth_bearer_fetches_and_caches_token(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = {"count": 0}

    class _FakeResponse:
        status_code = 200

        def json(self) -> dict[str, object]:
            calls["count"] += 1
            return {"access_token": f"token-{calls['count']}", "expires_in": 3600}

    def fake_post(url: str, data: dict[str, str], timeout: int) -> _FakeResponse:
        assert data["grant_type"] == "client_credentials"
        assert data["scope"].endswith("/.default")
        return _FakeResponse()

    monkeypatch.setattr(httpx, "post", fake_post)

    bearer = _OAuthBearerAuth(client_id="id", client_secret="secret", tenant_id="tenant")
    first = bearer._valid_token()
    second = bearer._valid_token()  # cached, no second fetch

    assert first == "token-1"
    assert second == "token-1"
    assert calls["count"] == 1


def test_oauth_bearer_raises_connector_error_on_failed_token_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class _FailResponse:
        status_code = 401
        text = "invalid_client"

    monkeypatch.setattr(httpx, "post", lambda *a, **k: _FailResponse())

    bearer = _OAuthBearerAuth(client_id="id", client_secret="bad-secret", tenant_id="tenant")
    with pytest.raises(ConnectorError, match="Azure AD token request failed"):
        bearer._valid_token()
