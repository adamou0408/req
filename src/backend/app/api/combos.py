from __future__ import annotations

import uuid
from decimal import Decimal
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.rbac import require_permission
from app.core.database import get_db
from app.core.models import ProductCombo
from app.core.security import get_current_user
from app.market.combo_service import ProductComboService

router = APIRouter()


# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------


class ComboCreateRequest(BaseModel):
    controller_model: str = Field(..., max_length=255)
    flash_model: str = Field(..., max_length=255)
    target_ratio: Decimal = Field(..., gt=0, le=100)


class ComboRejectRequest(BaseModel):
    reason: str = Field(..., min_length=1, max_length=1000)


class ComboResponse(BaseModel):
    id: str
    controller_model: str
    flash_model: str
    target_ratio: float
    status: str
    approved_by: str | None = None
    approved_at: str | None = None
    published_at: str | None = None
    created_by: str
    created_at: str | None = None
    updated_at: str | None = None

    model_config = {"from_attributes": True}


class ComboPublishResponse(BaseModel):
    combo: ComboResponse
    notifications: list[dict[str, Any]]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _serialize_combo(combo: ProductCombo) -> dict[str, Any]:
    return {
        "id": str(combo.id),
        "controller_model": combo.controller_model,
        "flash_model": combo.flash_model,
        "target_ratio": float(combo.target_ratio),
        "status": combo.status.value,
        "approved_by": str(combo.approved_by) if combo.approved_by else None,
        "approved_at": combo.approved_at.isoformat() if combo.approved_at else None,
        "published_at": combo.published_at.isoformat() if combo.published_at else None,
        "created_by": str(combo.created_by),
        "created_at": combo.created_at.isoformat() if combo.created_at else None,
        "updated_at": combo.updated_at.isoformat() if combo.updated_at else None,
    }


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("/active")
async def list_active_combos(
    _current_user: dict[str, Any] = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    """Return only active combos (for sales / manufacturing)."""
    combos = await ProductComboService.get_active_combos(db)
    return [_serialize_combo(c) for c in combos]


@router.get("/history")
async def combo_history(
    limit: int = Query(50, ge=1, le=500),
    _current_user: dict[str, Any] = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    """Return combo change history ordered by created_at desc."""
    combos = await ProductComboService.get_combo_history(db, limit=limit)
    return [_serialize_combo(c) for c in combos]


@router.get("/")
async def list_combos(
    _current_user: dict[str, Any] = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    """Return all combos with active ones highlighted."""
    combos = await ProductComboService.get_all_combos(db)
    results = []
    for c in combos:
        data = _serialize_combo(c)
        data["is_active"] = c.status.value == "active"
        results.append(data)
    return results


@router.post("/", status_code=status.HTTP_201_CREATED)
async def create_combo(
    body: ComboCreateRequest,
    current_user: dict[str, Any] = Depends(require_permission("product_combos")),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Create a new product combo (requires market permission)."""
    combo = await ProductComboService.create_combo(
        controller_model=body.controller_model,
        flash_model=body.flash_model,
        target_ratio=body.target_ratio,
        created_by=uuid.UUID(current_user["user_id"]),
        db=db,
    )
    return _serialize_combo(combo)


@router.get("/{combo_id}")
async def get_combo(
    combo_id: uuid.UUID,
    _current_user: dict[str, Any] = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Return combo details."""
    combo = await ProductComboService.get_combo_by_id(combo_id, db)
    return _serialize_combo(combo)


@router.post("/{combo_id}/submit")
async def submit_combo(
    combo_id: uuid.UUID,
    _current_user: dict[str, Any] = Depends(require_permission("product_combos")),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Submit a combo for approval."""
    combo = await ProductComboService.submit_for_approval(combo_id, db)
    return _serialize_combo(combo)


@router.post("/{combo_id}/approve")
async def approve_combo(
    combo_id: uuid.UUID,
    current_user: dict[str, Any] = Depends(require_permission("product_combos")),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Approve a combo (requires product_combos permission + manager role check)."""
    user_role = current_user.get("role", "")
    if user_role not in ("big_data", "market", "pm"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only market managers, PMs, or admins can approve combos",
        )
    combo = await ProductComboService.approve_combo(
        combo_id=combo_id,
        approved_by=uuid.UUID(current_user["user_id"]),
        db=db,
    )
    return _serialize_combo(combo)


@router.post("/{combo_id}/reject")
async def reject_combo(
    combo_id: uuid.UUID,
    body: ComboRejectRequest,
    _current_user: dict[str, Any] = Depends(require_permission("product_combos")),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Reject a combo back to draft."""
    combo = await ProductComboService.reject_combo(combo_id, body.reason, db)
    return _serialize_combo(combo)


@router.post("/{combo_id}/publish")
async def publish_combo(
    combo_id: uuid.UUID,
    _current_user: dict[str, Any] = Depends(require_permission("product_combos")),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Publish a combo to all departments."""
    result = await ProductComboService.publish_combo(combo_id, db)
    return {
        "combo": _serialize_combo(result["combo"]),
        "notifications": result["notifications"],
    }


@router.post("/{combo_id}/archive")
async def archive_combo(
    combo_id: uuid.UUID,
    _current_user: dict[str, Any] = Depends(require_permission("product_combos")),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Archive a combo."""
    combo = await ProductComboService.archive_combo(combo_id, db)
    return _serialize_combo(combo)
