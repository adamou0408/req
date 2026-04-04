from __future__ import annotations

import uuid
from datetime import date, timedelta
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import func as sa_func

from app.core.models import ComboStatus, ProductCombo
from app.mrp.models import DemandRecord, InventoryRecord, MpsRecord


class MpsService:
    """Master Production Schedule generation and management."""

    @staticmethod
    async def generate_mps(
        planning_horizon_weeks: int, db: AsyncSession
    ) -> list[MpsRecord]:
        """Generate a master production schedule.

        Algorithm:
        1. Get active product combos (controller + flash pairings with ratios).
        2. Get demand forecasts and actual orders.
        3. For each weekly period, allocate production based on combo target_ratio.
        4. Consider current inventory levels.
        5. Save MPS records.
        """
        # Get active combos
        stmt = select(ProductCombo).where(ProductCombo.status == ComboStatus.active)
        result = await db.execute(stmt)
        combos = list(result.scalars().all())

        today = date.today()
        records: list[MpsRecord] = []

        for week_idx in range(planning_horizon_weeks):
            period_start = today + timedelta(weeks=week_idx)
            period_end = period_start + timedelta(days=6)

            # Get total demand for this period across all products
            demand_stmt = select(
                DemandRecord.product_model,
                sa_func.coalesce(sa_func.sum(DemandRecord.quantity), 0.0),
            ).where(
                DemandRecord.required_date >= period_start,
                DemandRecord.required_date <= period_end,
            ).group_by(DemandRecord.product_model)

            demand_result = await db.execute(demand_stmt)
            demand_by_model: dict[str, float] = {
                row[0]: float(row[1]) for row in demand_result.all()
            }

            if combos:
                # Distribute production based on combo ratios
                total_demand = sum(demand_by_model.values()) if demand_by_model else 0
                for combo in combos:
                    product_model = f"{combo.controller_model}+{combo.flash_model}"
                    ratio = float(combo.target_ratio) / 100.0

                    # Use demand for this specific product or allocate by ratio
                    model_demand = demand_by_model.get(product_model, total_demand * ratio)
                    planned_qty = max(0.0, model_demand)

                    if planned_qty > 0:
                        mps = MpsRecord(
                            product_model=product_model,
                            period_start=period_start,
                            period_end=period_end,
                            planned_quantity=planned_qty,
                            combo_id=combo.id,
                            status="planned",
                        )
                        records.append(mps)
            else:
                # No combos: create MPS directly from demand
                for model, qty in demand_by_model.items():
                    if qty > 0:
                        mps = MpsRecord(
                            product_model=model,
                            period_start=period_start,
                            period_end=period_end,
                            planned_quantity=qty,
                            status="planned",
                        )
                        records.append(mps)

        db.add_all(records)
        await db.flush()
        # Refresh to get server-generated defaults
        for r in records:
            await db.refresh(r)
        return records

    @staticmethod
    async def get_schedule(
        product_model: str | None = None,
        start_date: date | None = None,
        end_date: date | None = None,
        db: AsyncSession | None = None,
    ) -> list[MpsRecord]:
        """Query MPS records with optional filters."""
        assert db is not None
        stmt = select(MpsRecord)
        if product_model:
            stmt = stmt.where(MpsRecord.product_model == product_model)
        if start_date:
            stmt = stmt.where(MpsRecord.period_end >= start_date)
        if end_date:
            stmt = stmt.where(MpsRecord.period_start <= end_date)
        stmt = stmt.order_by(MpsRecord.period_start, MpsRecord.product_model)
        result = await db.execute(stmt)
        return list(result.scalars().all())

    @staticmethod
    async def confirm_schedule(
        mps_id: uuid.UUID, confirmed_quantity: float, db: AsyncSession
    ) -> MpsRecord:
        """Confirm a planned MPS record with an actual quantity."""
        stmt = select(MpsRecord).where(MpsRecord.id == mps_id)
        result = await db.execute(stmt)
        mps = result.scalar_one_or_none()
        if mps is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="MPS record not found",
            )
        mps.confirmed_quantity = confirmed_quantity
        mps.status = "confirmed"
        db.add(mps)
        await db.flush()
        await db.refresh(mps)
        return mps

    @staticmethod
    async def get_schedule_with_combos(
        db: AsyncSession,
    ) -> list[dict[str, Any]]:
        """Return MPS records enriched with combo information."""
        stmt = select(MpsRecord).order_by(MpsRecord.period_start)
        result = await db.execute(stmt)
        mps_records = list(result.scalars().all())

        enriched: list[dict[str, Any]] = []
        for mps in mps_records:
            data: dict[str, Any] = {
                "id": str(mps.id),
                "product_model": mps.product_model,
                "period_start": mps.period_start.isoformat(),
                "period_end": mps.period_end.isoformat(),
                "planned_quantity": mps.planned_quantity,
                "confirmed_quantity": mps.confirmed_quantity,
                "status": mps.status,
                "combo_id": str(mps.combo_id) if mps.combo_id else None,
            }
            if mps.combo_id:
                combo_stmt = select(ProductCombo).where(ProductCombo.id == mps.combo_id)
                combo_result = await db.execute(combo_stmt)
                combo = combo_result.scalar_one_or_none()
                if combo:
                    data["combo"] = {
                        "controller_model": combo.controller_model,
                        "flash_model": combo.flash_model,
                        "target_ratio": float(combo.target_ratio),
                    }
            enriched.append(data)
        return enriched
