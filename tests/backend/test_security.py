from __future__ import annotations

from datetime import timedelta

import pytest
from fastapi import HTTPException

from app.core.security import (
    create_access_token,
    decrypt_password,
    encrypt_password,
    verify_token,
)


# ---------------------------------------------------------------------------
# Encrypt / Decrypt roundtrip
# ---------------------------------------------------------------------------


class TestEncryptDecrypt:
    def test_basic_roundtrip(self) -> None:
        original = "my-secret-password"
        encrypted = encrypt_password(original)
        assert isinstance(encrypted, bytes)
        assert decrypt_password(encrypted) == original

    def test_empty_password(self) -> None:
        original = ""
        encrypted = encrypt_password(original)
        assert decrypt_password(encrypted) == original

    def test_unicode_password(self) -> None:
        original = "密碼測試🔑café"
        encrypted = encrypt_password(original)
        assert decrypt_password(encrypted) == original

    def test_long_password(self) -> None:
        original = "x" * 10_000
        encrypted = encrypt_password(original)
        assert decrypt_password(encrypted) == original

    def test_encrypted_differs_from_plain(self) -> None:
        original = "password123"
        encrypted = encrypt_password(original)
        assert encrypted != original.encode("utf-8")

    def test_different_encryptions_produce_different_ciphertext(self) -> None:
        """Fernet includes a timestamp / IV so two encryptions should differ."""
        original = "same-password"
        enc1 = encrypt_password(original)
        enc2 = encrypt_password(original)
        assert enc1 != enc2  # different ciphertext
        assert decrypt_password(enc1) == decrypt_password(enc2) == original


# ---------------------------------------------------------------------------
# JWT
# ---------------------------------------------------------------------------


class TestJWT:
    def test_create_and_verify(self) -> None:
        data = {"sub": "alice", "role": "big_data"}
        token = create_access_token(data)
        payload = verify_token(token)
        assert payload["sub"] == "alice"
        assert payload["role"] == "big_data"
        assert "exp" in payload

    def test_custom_expiry(self) -> None:
        data = {"sub": "bob"}
        token = create_access_token(data, expires_delta=timedelta(minutes=5))
        payload = verify_token(token)
        assert payload["sub"] == "bob"

    def test_expired_token_raises(self) -> None:
        data = {"sub": "charlie"}
        token = create_access_token(data, expires_delta=timedelta(seconds=-1))
        with pytest.raises(HTTPException) as exc_info:
            verify_token(token)
        assert exc_info.value.status_code == 401

    def test_invalid_token_raises(self) -> None:
        with pytest.raises(HTTPException) as exc_info:
            verify_token("not.a.valid.token")
        assert exc_info.value.status_code == 401

    def test_token_preserves_extra_claims(self) -> None:
        data = {"sub": "dave", "user_id": "1234", "department": "engineering"}
        token = create_access_token(data)
        payload = verify_token(token)
        assert payload["user_id"] == "1234"
        assert payload["department"] == "engineering"
