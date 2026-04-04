from __future__ import annotations

import uuid
from datetime import date, timedelta
from typing import Any

from sqlalchemy import select, func as sa_func
from sqlalchemy.ext.asyncio import AsyncSession

from app.mrp.bom_service import BomService
from app.mrp.models import (
    DemandRecord,
    InventoryRecord,
    MrpResult,
)


class MrpRunner:
    """Core MRP I calculation engine."""

    @staticmethod
    async def run_mrp(
        product_models: list[str] | None,
        periods: int,
        period_length_days: int,
        db: AsyncSession,
    ) -> uuid.UUID:
        """Execute a full MRP run and return the run_id.

        Algorithm:
        1. For each product model, get demand grouped by period.
        2. Expand BOM to get all component requirements (gross).
        3. For each component per period, calculate net requirements.
        4. Offset planned order releases by lead time.
        5. Generate action messages.
        """
        run_id = uuid.uuid4()
        today = date.today()

        # Build period boundaries
        period_ranges: list[tuple[date, date]] = []
        for i in range(periods):
            start = today + timedelta(days=i * period_length_days)
            end = start + timedelta(days=period_length_days - 1)
            period_ranges.append((start, end))

        # Resolve product models
        if not product_models:
            stmt = select(DemandRecord.product_model).distinct()
            result = await db.execute(stmt)
            product_models = [row[0] for row in result.all()]

        # Collect gross requirements per component per period
        component_gross: dict[str, dict[int, float]] = {}  # part -> {period_idx -> qty}
        component_lead: dict[str, int] = {}  # part -> lead_time_days

        for model in product_models:
            # Get demand per period
            for period_idx, (p_start, p_end) in enumerate(period_ranges):
                stmt = select(
                    sa_func.coalesce(sa_func.sum(DemandRecord.quantity), 0.0)
                ).where(
                    DemandRecord.product_model == model,
                    DemandRecord.required_date >= p_start,
                    DemandRecord.required_date <= p_end,
                )
                result = await db.execute(stmt)
                demand_qty = float(result.scalar() or 0.0)

                if demand_qty <= 0:
                    continue

                # Expand BOM for this model
                bom_items = await BomService.expand_bom(model, quantity=demand_qty, db=db)
                for item in bom_items:
                    pn = item["part_number"]
                    component_gross.setdefault(pn, {})
                    component_gross[pn][period_idx] = (
                        component_gross[pn].get(period_idx, 0.0) + item["total_quantity"]
                    )
                    component_lead[pn] = max(
                        component_lead.get(pn, 0), item["lead_time_days"]
                    )

        # For each component, calculate MRP records across periods
        all_results: list[MrpResult] = []

        for part_number, period_demands in component_gross.items():
            # Get inventory snapshot
            inv = await MrpRunner._get_inventory(part_number, db)
            on_hand = inv["quantity_on_hand"]
            in_transit = inv["quantity_in_transit"]
            safety_stock = inv["safety_stock"]
            lead_time = component_lead.get(part_number, 0)

            prev_on_hand = on_hand

            for period_idx, (p_start, p_end) in enumerate(period_ranges):
                gross_req = period_demands.get(period_idx, 0.0)
                # Scheduled receipts: in_transit only applies to first period
                scheduled_receipts = in_transit if period_idx == 0 else 0.0

                projected = prev_on_hand + scheduled_receipts - gross_req
                net_req = max(0.0, gross_req - prev_on_hand - scheduled_receipts + safety_stock)
                if projected >= safety_stock:
                    net_req = 0.0

                planned_receipt = net_req
                # Planned order release is offset by lead time
                planned_release = net_req

                # Update projected on hand after planned receipt
                final_on_hand = prev_on_hand + scheduled_receipts + planned_receipt - gross_req

                # Action message
                action = MrpRunner._determine_action(
                    net_req=net_req,
                    projected_on_hand=final_on_hand,
                    safety_stock=safety_stock,
                    lead_time=lead_time,
                    period_idx=period_idx,
                )

                mrp_result = MrpResult(
                    run_id=run_id,
                    part_number=part_number,
                    period_start=p_start,
                    period_end=p_end,
                    gross_requirement=gross_req,
                    scheduled_receipts=scheduled_receipts,
                    projected_on_hand=final_on_hand,
                    net_requirement=net_req,
                    planned_order_release=planned_release,
                    planned_order_receipt=planned_receipt,
                    action_message=action,
                )
                all_results.append(mrp_result)
                prev_on_hand = final_on_hand

        db.add_all(all_results)
        await db.flush()
        return run_id

    @staticmethod
    async def get_results(
        run_id: uuid.UUID, db: AsyncSession
    ) -> list[MrpResult]:
        """Return MRP results for a run, grouped by part_number then period."""
        stmt = (
            select(MrpResult)
            .where(MrpResult.run_id == run_id)
            .order_by(MrpResult.part_number, MrpResult.period_start)
        )
        result = await db.execute(stmt)
        return list(result.scalars().all())

    @staticmethod
    async def get_shortage_alerts(
        run_id: uuid.UUID | None = None, db: AsyncSession | None = None
    ) -> list[MrpResult]:
        """Return parts where net_requirement > 0."""
        assert db is not None
        stmt = select(MrpResult).where(MrpResult.net_requirement > 0)
        if run_id:
            stmt = stmt.where(MrpResult.run_id == run_id)
        stmt = stmt.order_by(MrpResult.net_requirement.desc())
        result = await db.execute(stmt)
        return list(result.scalars().all())

    @staticmethod
    async def get_action_messages(
        run_id: uuid.UUID, db: AsyncSession
    ) -> list[MrpResult]:
        """Return results that have action messages."""
        stmt = (
            select(MrpResult)
            .where(
                MrpResult.run_id == run_id,
                MrpResult.action_message.isnot(None),
            )
            .order_by(MrpResult.part_number, MrpResult.period_start)
        )
        result = await db.execute(stmt)
        return list(result.scalars().all())

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    async def _get_inventory(
        part_number: str, db: AsyncSession
    ) -> dict[str, float]:
        """Aggregate inventory across warehouses for a part."""
        stmt = select(
            sa_func.coalesce(sa_func.sum(InventoryRecord.quantity_on_hand), 0.0),
            sa_func.coalesce(sa_func.sum(InventoryRecord.quantity_in_transit), 0.0),
            sa_func.coalesce(sa_func.sum(InventoryRecord.quantity_reserved), 0.0),
            sa_func.coalesce(sa_func.max(InventoryRecord.safety_stock), 0.0),
        ).where(InventoryRecord.part_number == part_number)
        result = await db.execute(stmt)
        row = result.one()
        return {
            "quantity_on_hand": float(row[0]),
            "quantity_in_transit": float(row[1]),
            "quantity_reserved": float(row[2]),
            "safety_stock": float(row[3]),
        }

    @staticmethod
    def _determine_action(
        net_req: float,
        projected_on_hand: float,
        safety_stock: float,
        lead_time: int,
        period_idx: int,
    ) -> str | None:
        """Generate an action message based on MRP calculations."""
        if net_req > 0 and period_idx == 0 and lead_time > 0:
            return "expedite"
        if net_req > 0:
            return "new order"
        if projected_on_hand > safety_stock * 3 and safety_stock > 0:
            return "defer"
        return None
