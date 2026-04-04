from __future__ import annotations

from cryptography.fernet import Fernet
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings – populated from environment variables / .env file."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=True,
    )

    # ---- Database -------------------------------------------------------
    DATABASE_URL: str = (
        "postgresql+asyncpg://postgres:postgres@localhost:5432/mrp_platform"
    )

    # ---- Redis / Celery -------------------------------------------------
    REDIS_URL: str = "redis://localhost:6379/0"

    # ---- JWT / Auth -----------------------------------------------------
    SECRET_KEY: str = "change-me-in-production"
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 480

    # ---- Active Directory -----------------------------------------------
    AD_SERVER: str = ""
    AD_BASE_DN: str = ""
    AD_DOMAIN: str = ""

    # ---- Encryption (Fernet) for stored DB passwords --------------------
    ENCRYPTION_KEY: str = ""

    # ---- General --------------------------------------------------------
    APP_NAME: str = "MRP Multi-DB Connector"
    DEBUG: bool = False

    @property
    def fernet_key(self) -> bytes:
        """Return a valid Fernet key, auto-generating one if not configured."""
        if self.ENCRYPTION_KEY:
            return self.ENCRYPTION_KEY.encode()
        # Deterministic fallback derived from SECRET_KEY so restarts stay
        # consistent (production should always set ENCRYPTION_KEY explicitly).
        import base64
        import hashlib

        digest = hashlib.sha256(self.SECRET_KEY.encode()).digest()
        return base64.urlsafe_b64encode(digest)


settings = Settings()
