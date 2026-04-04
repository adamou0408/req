from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from cryptography.fernet import Fernet
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt

from app.core.config import settings

# ---------------------------------------------------------------------------
# Encryption helpers (Fernet – AES-128-CBC under the hood, simpler API than
# raw AES-256-GCM but still suitable for symmetric secret storage).
# ---------------------------------------------------------------------------

_fernet: Fernet | None = None


def _get_fernet() -> Fernet:
    global _fernet
    if _fernet is None:
        _fernet = Fernet(settings.fernet_key)
    return _fernet


def encrypt_password(plain: str) -> bytes:
    """Encrypt a plaintext database password and return the ciphertext bytes."""
    return _get_fernet().encrypt(plain.encode("utf-8"))


def decrypt_password(token: bytes) -> str:
    """Decrypt a previously-encrypted database password."""
    return _get_fernet().decrypt(token).decode("utf-8")


# ---------------------------------------------------------------------------
# JWT helpers
# ---------------------------------------------------------------------------


def create_access_token(data: dict[str, Any], expires_delta: timedelta | None = None) -> str:
    """Create a signed JWT access token."""
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + (
        expires_delta or timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    )
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, settings.SECRET_KEY, algorithm=settings.JWT_ALGORITHM)


def verify_token(token: str) -> dict[str, Any]:
    """Decode and verify a JWT token. Raises HTTPException on failure."""
    try:
        payload: dict[str, Any] = jwt.decode(
            token,
            settings.SECRET_KEY,
            algorithms=[settings.JWT_ALGORITHM],
        )
        return payload
    except JWTError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Could not validate credentials",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc


# ---------------------------------------------------------------------------
# FastAPI dependency
# ---------------------------------------------------------------------------

_bearer_scheme = HTTPBearer()


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(_bearer_scheme),
) -> dict[str, Any]:
    """Extract and validate the current user from the Authorization header."""
    payload = verify_token(credentials.credentials)
    username: str | None = payload.get("sub")
    if username is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token missing subject claim",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return payload
