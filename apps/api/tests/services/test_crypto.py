import pytest

from app.services.crypto import CredentialDecryptionError, decrypt_credentials, encrypt_credentials


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
