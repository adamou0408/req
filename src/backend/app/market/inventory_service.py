from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession


class InventoryService:
    """Inventory data service.

    Currently returns mock data. Interfaces are designed so that the
    implementation can be swapped to real synced platform DB data without
    changing callers.
    """

    _MOCK_INVENTORY = [
        {"model": "CTRL-A100", "part_number": "PN-001", "warehouse": "WH-TW-01", "quantity": 5200, "in_transit": 800, "last_updated": "2026-04-03T08:00:00Z"},
        {"model": "CTRL-A100", "part_number": "PN-001", "warehouse": "WH-CN-02", "quantity": 3100, "in_transit": 0, "last_updated": "2026-04-03T08:00:00Z"},
        {"model": "FL-256A", "part_number": "PN-010", "warehouse": "WH-TW-01", "quantity": 15000, "in_transit": 2000, "last_updated": "2026-04-03T08:00:00Z"},
        {"model": "FL-512B", "part_number": "PN-011", "warehouse": "WH-TW-01", "quantity": 3000, "in_transit": 5000, "last_updated": "2026-04-02T12:00:00Z"},
        {"model": "FL-1T-C", "part_number": "PN-012", "warehouse": "WH-CN-02", "quantity": 800, "in_transit": 1500, "last_updated": "2026-04-03T08:00:00Z"},
        {"model": "COMBO-A100-256A", "part_number": "PN-100", "warehouse": "WH-TW-01", "quantity": 1200, "in_transit": 300, "last_updated": "2026-04-03T10:00:00Z"},
        {"model": "COMBO-A100-512B", "part_number": "PN-101", "warehouse": "WH-TW-01", "quantity": 600, "in_transit": 0, "last_updated": "2026-04-03T10:00:00Z"},
    ]

    @staticmethod
    async def search_inventory(
        product_model: str | None = None,
        part_number: str | None = None,
        db: AsyncSession | None = None,
    ) -> list[dict[str, Any]]:
        """Search inventory by model and/or part number (substring match)."""
        results = list(InventoryService._MOCK_INVENTORY)
        if product_model:
            results = [r for r in results if product_model.upper() in r["model"].upper()]
        if part_number:
            results = [r for r in results if part_number.upper() in r["part_number"].upper()]
        return results

    @staticmethod
    async def get_product_schedule(
        product_model: str,
        db: AsyncSession | None = None,
    ) -> list[dict[str, Any]]:
        """Return production schedule for a given product model."""
        schedules: list[dict[str, Any]] = []
        statuses = ["scheduled", "in_progress", "completed"]
        for i in range(5):
            schedules.append(
                {
                    "product_model": product_model,
                    "scheduled_date": (date.today() + timedelta(days=i * 7)).isoformat(),
                    "quantity": 500 + i * 100,
                    "status": statuses[min(i, 2)],
                }
            )
        return schedules

    @staticmethod
    async def get_inventory_summary(
        db: AsyncSession | None = None,
    ) -> list[dict[str, Any]]:
        """Return inventory aggregated by product type."""
        type_map: dict[str, dict[str, int]] = {}
        for item in InventoryService._MOCK_INVENTORY:
            model = item["model"]
            if model.startswith("CTRL"):
                ptype = "controller"
            elif model.startswith("FL"):
                ptype = "flash"
            elif model.startswith("COMBO"):
                ptype = "combo"
            else:
                ptype = "other"

            if ptype not in type_map:
                type_map[ptype] = {"total_quantity": 0, "total_in_transit": 0, "sku_count": 0}
            type_map[ptype]["total_quantity"] += item["quantity"]
            type_map[ptype]["total_in_transit"] += item["in_transit"]
            type_map[ptype]["sku_count"] += 1

        return [
            {"product_type": ptype, **counts}
            for ptype, counts in sorted(type_map.items())
        ]
