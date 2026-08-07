"""Envelope encryption for per-workspace connector credentials (Issue #101).

A single data-encryption key (DEK) is fetched from Azure Key Vault once per
process and cached module-level — Key Vault only ever holds this one
long-lived key, never the actual per-connection OAuth tokens. Each encrypt
call generates a fresh random nonce (AES-GCM requires this — reusing a nonce
with the same key catastrophically breaks confidentiality), so the same
plaintext never produces the same ciphertext twice. The nonce is prepended to
the ciphertext (standard practice — a nonce isn't secret, just unique) so
decrypt_credentials needs only the stored bytes, not a second stored field.
"""

from __future__ import annotations

import base64
import os

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.core.config import settings

_NONCE_LENGTH = 12  # AES-GCM standard nonce size


class CredentialDecryptionError(Exception):
    pass


_cached_dek: bytes | None = None


def _fetch_dek_from_source() -> bytes:
    """Fetch the data-encryption key from its source of truth (uncached).

    Prefers a local-dev override (CONNECTOR_DEK_B64) if set; otherwise fetches
    the real key from Azure Key Vault. Callers should go through
    _get_data_encryption_key() instead, which adds process-level caching.
    """
    if settings.connector_dek_b64:
        # Local/test override — a base64-encoded 32-byte key set directly via
        # env, bypassing Key Vault. Never used in production; documented in
        # .env.example.
        return base64.b64decode(settings.connector_dek_b64)

    from azure.identity import DefaultAzureCredential
    from azure.keyvault.secrets import SecretClient

    vault_url = settings.azure_key_vault_url
    if not vault_url:
        raise RuntimeError(
            "AZURE_KEY_VAULT_URL is not configured — cannot fetch the connector "
            "credential encryption key."
        )
    client = SecretClient(vault_url=vault_url, credential=DefaultAzureCredential())
    secret = client.get_secret("connector-credentials-dek")
    if not secret.value:
        raise RuntimeError(
            "Key Vault secret 'connector-credentials-dek' has no value."
        )
    return base64.b64decode(secret.value)


def _get_data_encryption_key() -> bytes:
    global _cached_dek
    if _cached_dek is None:
        _cached_dek = _fetch_dek_from_source()
    return _cached_dek


def encrypt_credentials(plaintext: str) -> bytes:
    key = _get_data_encryption_key()
    nonce = os.urandom(_NONCE_LENGTH)
    ciphertext = AESGCM(key).encrypt(nonce, plaintext.encode(), None)
    return nonce + ciphertext


def decrypt_credentials(encrypted: bytes) -> str:
    if len(encrypted) < _NONCE_LENGTH:
        # Too short to even contain a nonce — corrupted/truncated input.
        # AESGCM.decrypt would raise a bare ValueError here, not InvalidTag,
        # which callers catching only CredentialDecryptionError wouldn't see.
        raise CredentialDecryptionError("Ciphertext is too short to be valid.")
    key = _get_data_encryption_key()
    nonce, ciphertext = encrypted[:_NONCE_LENGTH], encrypted[_NONCE_LENGTH:]
    try:
        plaintext = AESGCM(key).decrypt(nonce, ciphertext, None)
    except InvalidTag as exc:
        raise CredentialDecryptionError("Ciphertext failed authentication — possibly tampered.") from exc
    return plaintext.decode()
