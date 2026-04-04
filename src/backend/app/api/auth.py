from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import service as auth_service
from app.core.database import get_db
from app.core.security import get_current_user

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/login")
async def login(
    form_data: OAuth2PasswordRequestForm = Depends(),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Authenticate user and return a JWT access token."""
    result = await auth_service.login(form_data.username, form_data.password, db)
    if result is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return result


@router.get("/me")
async def me(
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Return information about the currently authenticated user."""
    return {
        "ad_username": current_user.get("sub"),
        "user_id": current_user.get("user_id"),
        "role": current_user.get("role"),
    }


@router.post("/logout")
async def logout(
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, str]:
    """Log out the current user.

    Token invalidation is handled client-side (discard the token).  A
    server-side token blacklist can be added later if required.
    """
    return {"detail": "Successfully logged out"}
