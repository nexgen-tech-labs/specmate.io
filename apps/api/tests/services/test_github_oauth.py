import pytest
from unittest.mock import AsyncMock, patch


from app.services.connectors.github_auth import exchange_oauth_code_for_token


@pytest.mark.asyncio
async def test_exchange_oauth_code_for_token_returns_access_token(monkeypatch):
    monkeypatch.setattr("app.core.config.settings.github_oauth_app_client_id", "test-client-id")
    monkeypatch.setattr("app.core.config.settings.github_oauth_app_client_secret", "test-secret")

    class FakeResponse:
        status_code = 200

        def json(self):
            return {"access_token": "gho_faketoken123", "token_type": "bearer", "scope": "repo"}

        def raise_for_status(self):
            pass

    with patch("httpx.AsyncClient.post", new=AsyncMock(return_value=FakeResponse())):
        token = await exchange_oauth_code_for_token("fake-auth-code")
    assert token == "gho_faketoken123"


@pytest.mark.asyncio
async def test_exchange_oauth_code_for_token_raises_on_error_response(monkeypatch):
    monkeypatch.setattr("app.core.config.settings.github_oauth_app_client_id", "test-client-id")
    monkeypatch.setattr("app.core.config.settings.github_oauth_app_client_secret", "test-secret")

    class FakeResponse:
        status_code = 200

        def json(self):
            return {"error": "bad_verification_code"}

        def raise_for_status(self):
            pass

    from app.services.connectors.types import ConnectorError

    with patch("httpx.AsyncClient.post", new=AsyncMock(return_value=FakeResponse())):
        with pytest.raises(ConnectorError):
            await exchange_oauth_code_for_token("expired-or-reused-code")


@pytest.mark.asyncio
async def test_exchange_oauth_code_for_token_raises_if_not_configured(monkeypatch):
    monkeypatch.setattr("app.core.config.settings.github_oauth_app_client_id", "")
    monkeypatch.setattr("app.core.config.settings.github_oauth_app_client_secret", "")
    from app.services.connectors.types import ConnectorError

    with pytest.raises(ConnectorError):
        await exchange_oauth_code_for_token("some-code")
