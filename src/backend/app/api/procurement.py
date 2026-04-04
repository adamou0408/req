from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.rbac import require_permission
from app.core.database import get_db
from app.market.procurement_service import FlashProcurementService

router = APIRouter()


@router.get("/orders")
async def list_purchase_orders(
    flash_model: str | None = Query(None, description="Filter by flash model"),
    _current_user: dict[str, Any] = Depends(require_permission("procurement")),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    """Return purchase orders, optionally filtered by flash model."""
    return await FlashProcurementService.get_purchase_orders(
        flash_model=flash_model, db=db
    )


@router.get("/price-history/{flash_model}")
async def price_history(
    flash_model: str,
    days: int = Query(365, ge=1, le=3650),
    _current_user: dict[str, Any] = Depends(require_permission("procurement")),
) -> list[dict[str, Any]]:
    """Return price history for a flash model."""
    raw = await FlashProcurementService.get_price_history(
        flash_model=flash_model, days=days
    )
    return [{"date": d, "price": p} for d, p in raw]


@router.get("/arrival-status")
async def arrival_status(
    po_number: str | None = Query(None, description="Filter by PO number"),
    _current_user: dict[str, Any] = Depends(require_permission("procurement")),
) -> list[dict[str, Any]]:
    """Return arrival tracking information."""
    return await FlashProcurementService.get_arrival_status(po_number=po_number)


@router.get("/safety-stock")
async def safety_stock(
    _current_user: dict[str, Any] = Depends(require_permission("procurement")),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    """Return safety stock alerts for all flash models."""
    return await FlashProcurementService.check_safety_stock(db=db)
