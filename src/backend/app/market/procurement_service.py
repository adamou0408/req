from __future__ import annotations

import random
from datetime import date, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession


class FlashProcurementService:
    """Procurement data service.

    Currently returns mock data. Interfaces are designed so that the
    implementation can be swapped to real Tiptop sync (Phase 2 Task 2.1)
    without changing callers.
    """

    _FLASH_MODELS = ["FL-256A", "FL-512B", "FL-1T-C", "FL-2T-D"]

    @staticmethod
    async def get_purchase_orders(
        flash_model: str | None = None,
        db: AsyncSession | None = None,
    ) -> list[dict[str, Any]]:
        """Return purchase orders, optionally filtered by flash model."""
        orders = [
            {
                "po_number": f"PO-2026-{i:04d}",
                "flash_model": FlashProcurementService._FLASH_MODELS[i % len(FlashProcurementService._FLASH_MODELS)],
                "quantity": (i + 1) * 500,
                "unit_price": float(Decimal("12.50") + Decimal(str(i * 0.75))),
                "total_amount": float((Decimal("12.50") + Decimal(str(i * 0.75))) * ((i + 1) * 500)),
                "supplier": f"Supplier-{chr(65 + i % 3)}",
                "order_date": (date.today() - timedelta(days=30 - i * 5)).isoformat(),
                "expected_arrival": (date.today() + timedelta(days=10 + i * 3)).isoformat(),
                "status": ["confirmed", "in_transit", "delivered", "confirmed"][i % 4],
            }
            for i in range(8)
        ]
        if flash_model:
            orders = [o for o in orders if o["flash_model"] == flash_model]
        return orders

    @staticmethod
    async def get_price_history(
        flash_model: str,
        days: int = 365,
    ) -> list[tuple[str, float]]:
        """Return (date, price) tuples for a flash model over the given period."""
        base_price = 12.50
        history: list[tuple[str, float]] = []
        rng = random.Random(hash(flash_model))
        for i in range(0, days, 7):
            d = date.today() - timedelta(days=days - i)
            price = round(base_price + rng.uniform(-1.5, 2.0), 2)
            history.append((d.isoformat(), price))
        return history

    @staticmethod
    async def get_arrival_status(
        po_number: str | None = None,
    ) -> list[dict[str, Any]]:
        """Return arrival tracking information."""
        arrivals = [
            {
                "po_number": f"PO-2026-{i:04d}",
                "flash_model": FlashProcurementService._FLASH_MODELS[i % len(FlashProcurementService._FLASH_MODELS)],
                "shipped_date": (date.today() - timedelta(days=10 - i)).isoformat(),
                "expected_arrival": (date.today() + timedelta(days=i * 2)).isoformat(),
                "actual_arrival": (date.today() - timedelta(days=2)).isoformat() if i < 2 else None,
                "carrier": f"Carrier-{chr(65 + i % 2)}",
                "tracking_number": f"TRK{1000 + i}",
                "status": ["delivered", "delivered", "in_transit", "in_transit", "pending"][min(i, 4)],
            }
            for i in range(5)
        ]
        if po_number:
            arrivals = [a for a in arrivals if a["po_number"] == po_number]
        return arrivals

    @staticmethod
    async def check_safety_stock(
        db: AsyncSession | None = None,
    ) -> list[dict[str, Any]]:
        """Check safety stock levels for all flash models."""
        stock_data: list[dict[str, Any]] = []
        levels = [
            ("FL-256A", 15000, 10000),
            ("FL-512B", 3000, 5000),
            ("FL-1T-C", 800, 2000),
            ("FL-2T-D", 12000, 8000),
        ]
        for model, current, safety in levels:
            ratio = current / safety if safety > 0 else 999
            if ratio >= 1.5:
                s = "ok"
            elif ratio >= 1.0:
                s = "warning"
            else:
                s = "critical"
            stock_data.append(
                {
                    "flash_model": model,
                    "current_stock": current,
                    "safety_level": safety,
                    "status": s,
                }
            )
        return stock_data
