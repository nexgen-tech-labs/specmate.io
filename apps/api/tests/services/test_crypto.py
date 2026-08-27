from unittest.mock import MagicMock, patch

import pytest

from app.services.crypto import (
    CredentialDecryptionError,
    _fetch_dek_from_source,
    decrypt_credentials,
    encrypt_credentials,
)


def test_encrypt_then_decrypt_round_trips_to_original_value(monkeypatch):
    monkeypatch.setattr(
        "app.services.crypto._get_data_encryption_key",
        lambda: b"0" * 32,  # 32-byte test key, bypasses real Key Vault call
    )
    original = "gho_realTokenValueHere1234567890"
    encrypted = encrypt_credentials(original)
    assert encrypted != original.encode()
    decrypted = decrypt_credentials(encrypted)
    assert decrypted == original


def test_encrypt_produces_different_ciphertext_each_call(monkeypatch):
    # AES-GCM requires a fresh nonce per encryption — same plaintext must not
    # produce identical ciphertext twice, or nonce reuse would leak information.
    monkeypatch.setattr(
        "app.services.crypto._get_data_encryption_key",
        lambda: b"0" * 32,
    )
    a = encrypt_credentials("same-value")
    b = encrypt_credentials("same-value")
    assert a != b


def test_decrypt_rejects_tampered_ciphertext(monkeypatch):
    monkeypatch.setattr(
        "app.services.crypto._get_data_encryption_key",
        lambda: b"0" * 32,
    )
    encrypted = bytearray(encrypt_credentials("some-token"))
    encrypted[-1] ^= 0xFF  # flip a byte
    with pytest.raises(CredentialDecryptionError):
        decrypt_credentials(bytes(encrypted))


def test_decrypt_rejects_input_too_short_to_contain_a_nonce(monkeypatch):
    monkeypatch.setattr(
        "app.services.crypto._get_data_encryption_key",
        lambda: b"0" * 32,
    )
    with pytest.raises(CredentialDecryptionError):
        decrypt_credentials(b"short")


def test_cached_key_is_reused_across_calls(monkeypatch):
    # The DEK should be fetched once and cached module-level, not re-fetched
    # on every encrypt/decrypt call (that would be a real Key Vault round-trip
    # per credential operation — unacceptable latency/cost).
    import app.services.crypto as crypto_module

    crypto_module._cached_dek = None  # reset any state from prior tests
    call_count = 0

    def fake_fetch():
        nonlocal call_count
        call_count += 1
        return b"1" * 32

    monkeypatch.setattr("app.services.crypto._fetch_dek_from_source", fake_fetch)
    encrypt_credentials("value-one")
    encrypt_credentials("value-two")
    assert call_count == 1
    crypto_module._cached_dek = None  # reset for other tests


def test_fetch_dek_passes_managed_identity_client_id_to_default_azure_credential(monkeypatch):
    # specmate-api runs under a user-assigned managed identity — a bare
    # DefaultAzureCredential() only probes for a system-assigned identity and
    # fails ("Unable to load the proper Managed Identity"), confirmed live in
    # production against the real Jira OAuth callback. Regression test for
    # that incident: the client id from settings must reach the credential.
    monkeypatch.setattr("app.core.config.settings.connector_dek_b64", "")
    monkeypatch.setattr("app.core.config.settings.azure_key_vault_url", "https://kv.example/")
    monkeypatch.setattr(
        "app.core.config.settings.azure_managed_identity_client_id", "fake-client-id"
    )

    fake_secret = MagicMock()
    fake_secret.value = "ZmFrZS1kZWs="  # base64 doesn't matter here, just non-empty
    fake_secret_client = MagicMock()
    fake_secret_client.get_secret.return_value = fake_secret

    with (
        patch("azure.identity.DefaultAzureCredential") as fake_credential_cls,
        patch("azure.keyvault.secrets.SecretClient", return_value=fake_secret_client),
    ):
        _fetch_dek_from_source()

    fake_credential_cls.assert_called_once_with(managed_identity_client_id="fake-client-id")


def test_fetch_dek_passes_none_when_no_managed_identity_client_id_configured(monkeypatch):
    # Local/CI runs (no managed identity at all) must still pass None rather
    # than an empty string, which azure-identity would treat as a real
    # (invalid) client id instead of "use the default probing behavior."
    monkeypatch.setattr("app.core.config.settings.connector_dek_b64", "")
    monkeypatch.setattr("app.core.config.settings.azure_key_vault_url", "https://kv.example/")
    monkeypatch.setattr("app.core.config.settings.azure_managed_identity_client_id", "")

    fake_secret = MagicMock()
    fake_secret.value = "ZmFrZS1kZWs="
    fake_secret_client = MagicMock()
    fake_secret_client.get_secret.return_value = fake_secret

    with (
        patch("azure.identity.DefaultAzureCredential") as fake_credential_cls,
        patch("azure.keyvault.secrets.SecretClient", return_value=fake_secret_client),
    ):
        _fetch_dek_from_source()

    fake_credential_cls.assert_called_once_with(managed_identity_client_id=None)
