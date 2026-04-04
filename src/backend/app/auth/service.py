from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.ad_connector import ADConnector
from app.core.models import User, UserRole
from app.core.security import create_access_token

logger = logging.getLogger(__name__)

_ad = ADConnector()


async def authenticate(username: str, password: str, db: AsyncSession) -> User | None:
    """Authenticate via AD (or dev-mode fallback) and return the User model."""
    if not _ad.connect_and_authenticate(username, password):
        return None

    user_info = _ad.get_user_info(username)
    user = await get_or_create_user(username, user_info, db)

    # Update last login timestamp
    user.last_login_at = datetime.now(timezone.utc)
    db.add(user)
    await db.flush()

    return user


async def get_or_create_user(
    ad_username: str,
    user_info: dict[str, Any],
    db: AsyncSession,
) -> User:
    """Return an existing user or create a new one from AD information."""
    stmt = select(User).where(User.ad_username == ad_username)
    result = await db.execute(stmt)
    user = result.scalar_one_or_none()

    if user is not None:
        # Sync display name / department from AD on each login
        user.display_name = user_info.get("display_name", user.display_name)
        user.department = user_info.get("department", user.department)
        db.add(user)
        await db.flush()
        return user

    user = User(
        ad_username=ad_username,
        display_name=user_info.get("display_name", ad_username),
        department=user_info.get("department"),
        role=UserRole.viewer,
        is_active=True,
    )
    db.add(user)
    await db.flush()
    await db.refresh(user)
    logger.info("Created new user '%s' (id=%s)", ad_username, user.id)
    return user


async def login(
    username: str,
    password: str,
    db: AsyncSession,
) -> dict[str, Any] | None:
    """Perform full login flow and return token payload, or ``None`` on failure."""
    user = await authenticate(username, password, db)
    if user is None:
        return None

    token = create_access_token(
        data={
            "sub": user.ad_username,
            "user_id": str(user.id),
            "role": user.role.value,
        }
    )

    return {
        "access_token": token,
        "token_type": "bearer",
        "user": {
            "id": str(user.id),
            "ad_username": user.ad_username,
            "display_name": user.display_name,
            "department": user.department,
            "role": user.role.value,
        },
    }
