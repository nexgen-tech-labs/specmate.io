"""GitHub App JWT signing + installation-token mint/cache (Issue 10.3) —
mirrors test_jira_connect_auth.py's test shape for the RS256-signed
app-JWT-then-installation-token two-hop flow."""
from __future__ import annotations

import time
from unittest.mock import AsyncMock, patch

import jwt as pyjwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from app.core.config import settings
from app.services.connectors.github_app_auth import (
    InstallationTokenConnection,
    _app_jwt,
    _InstallationTokenCache,
    mint_installation_token,
    resolve_installation_connection,
)
from app.services.connectors.types import ConnectorError


def _generate_test_keypair() -> tuple[str, str]:
    """Returns (private_key_pem, public_key_pem) for signing/verifying test
    JWTs — generated fresh per call, never a real App's key."""
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private_pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    public_pem = (
        key.public_key()
        .public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        .decode()
    )
    return private_pem, public_pem


_PRIVATE_KEY_PEM, _PUBLIC_KEY_PEM = _generate_test_keypair()


def test_app_jwt_is_signed_rs256_with_app_id_as_issuer_and_short_expiry() -> None:
    with (
        patch.object(settings, "github_app_id", "12345"),
        patch.object(settings, "github_app_private_key", _PRIVATE_KEY_PEM),
    ):
        token = _app_jwt()

    decoded = pyjwt.decode(token, _PUBLIC_KEY_PEM, algorithms=["RS256"])
    assert decoded["iss"] == "12345"
    # Backdated iat tolerates clock drift; exp must stay under GitHub's 10-min cap.
    assert decoded["iat"] < time.time()
    assert decoded["exp"] - decoded["iat"] <= 630


def test_app_jwt_raises_if_not_configured() -> None:
    with (
        patch.object(settings, "github_app_id", ""),
        patch.object(settings, "github_app_private_key", ""),
    ):
        with pytest.raises(ConnectorError):
            _app_jwt()


class _FakeTokenResponse:
    status_code = 201

    def json(self) -> dict[str, object]:
        return {"token": "ghs_installationTokenValue", "expires_at": "2026-01-01T13:00:00Z"}


@pytest.mark.asyncio
async def test_mint_installation_token_returns_token_and_expiry() -> None:
    with (
        patch.object(settings, "github_app_id", "12345"),
        patch.object(settings, "github_app_private_key", _PRIVATE_KEY_PEM),
        patch("httpx.AsyncClient.post", new=AsyncMock(return_value=_FakeTokenResponse())),
    ):
        token, expires_at = await mint_installation_token(999)
    assert token == "ghs_installationTokenValue"
    # 2026-01-01T13:00:00Z as epoch seconds.
    assert expires_at == 1767272400.0 or expires_at == 1767272400


@pytest.mark.asyncio
async def test_mint_installation_token_raises_on_non_201() -> None:
    class _FailResponse:
        status_code = 404

        @property
        def text(self) -> str:
            return "Not Found"

    with (
        patch.object(settings, "github_app_id", "12345"),
        patch.object(settings, "github_app_private_key", _PRIVATE_KEY_PEM),
        patch("httpx.AsyncClient.post", new=AsyncMock(return_value=_FailResponse())),
    ):
        with pytest.raises(ConnectorError):
            await mint_installation_token(999)


@pytest.mark.asyncio
async def test_installation_token_cache_reuses_unexpired_token() -> None:
    cache = _InstallationTokenCache()
    mint_mock = AsyncMock(return_value=("ghs_token1", time.time() + 3600))
    with patch("app.services.connectors.github_app_auth.mint_installation_token", mint_mock):
        first = await cache.get(123)
        second = await cache.get(123)
    assert first == second == "ghs_token1"
    mint_mock.assert_called_once()


@pytest.mark.asyncio
async def test_installation_token_cache_remints_after_expiry() -> None:
    cache = _InstallationTokenCache()
    mint_mock = AsyncMock(
        side_effect=[
            ("ghs_stale", time.time() - 10),  # already expired
            ("ghs_fresh", time.time() + 3600),
        ]
    )
    with patch("app.services.connectors.github_app_auth.mint_installation_token", mint_mock):
        first = await cache.get(123)
        second = await cache.get(123)
    assert first == "ghs_stale"
    assert second == "ghs_fresh"
    assert mint_mock.call_count == 2


@pytest.mark.asyncio
async def test_resolve_installation_connection_builds_connection_with_repos_url() -> None:
    mint_mock = AsyncMock(return_value=("ghs_token", time.time() + 3600))
    with patch("app.services.connectors.github_app_auth.mint_installation_token", mint_mock):
        connection = await resolve_installation_connection(999)
    assert isinstance(connection, InstallationTokenConnection)
    assert connection.installation_id == 999
    assert connection.repos_discovery_url() == "https://api.github.com/installation/repositories"
    assert connection.headers()["Authorization"] == "Bearer ghs_token"
