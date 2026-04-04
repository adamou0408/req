from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.rbac import require_permission
from app.core.database import get_db
from app.market.inventory_service import InventoryService

router = APIRouter()


@router.get("/search")
async def search_inventory(
    model: str | None = Query(None, description="Product model substring filter"),
    part_number: str | None = Query(None, description="Part number substring filter"),
    _current_user: dict[str, Any] = Depends(require_permission("inventory")),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    """Search inventory by model and/or part number."""
    return await InventoryService.search_inventory(
        product_model=model,
        part_number=part_number,
        db=db,
    )


@router.get("/product/{model}/schedule")
async def product_schedule(
    model: str,
    _current_user: dict[str, Any] = Depends(require_permission("inventory")),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    """Return production schedule for a product model."""
    return await InventoryService.get_product_schedule(product_model=model, db=db)


@router.get("/summary")
async def inventory_summary(
    _current_user: dict[str, Any] = Depends(require_permission("inventory")),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    """Return inventory summary aggregated by product type."""
    return await InventoryService.get_inventory_summary(db=db)
