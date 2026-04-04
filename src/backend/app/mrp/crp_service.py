from __future__ import annotations

import uuid
from datetime import date, timedelta
from typing import Any

from sqlalchemy import select, func as sa_func
from sqlalchemy.ext.asyncio import AsyncSession

from app.mrp.models import CrpResult, MpsRecord, WorkCenter


class CrpService:
    """Capacity Requirements Planning engine."""

    @staticmethod
    async def run_crp(
        mps_records: list[MpsRecord],
        db: AsyncSession,
    ) -> uuid.UUID:
        """Execute a CRP run against the given MPS records.

        Algorithm:
        1. For each MPS record, calculate required capacity at each work center.
        2. Compare against available capacity (capacity_per_day * efficiency * working_days).
        3. Calculate utilization percentage.
        4. Flag bottlenecks (utilization > 90%).
        5. Save to CrpResult table.
        """
        run_id = uuid.uuid4()

        # Get active work centers
        stmt = select(WorkCenter).where(WorkCenter.is_active.is_(True))
        result = await db.execute(stmt)
        work_centers = list(result.scalars().all())

        if not work_centers:
            return run_id

        # Group MPS records by period
        period_demands: dict[tuple[date, date], float] = {}
        for mps in mps_records:
            key = (mps.period_start, mps.period_end)
            period_demands[key] = period_demands.get(key, 0.0) + mps.planned_quantity

        all_results: list[CrpResult] = []

        for (p_start, p_end), total_demand in period_demands.items():
            working_days = max(1, (p_end - p_start).days + 1)
            # Assume 5 working days per 7 calendar days
            working_days = max(1, int(working_days * 5 / 7))

            for wc in work_centers:
                available = wc.capacity_per_day * wc.efficiency * working_days
                # Distribute demand equally across work centers
                required = total_demand / len(work_centers)

                utilization = (required / available * 100.0) if available > 0 else 100.0
                is_bottleneck = utilization > 90.0

                crp = CrpResult(
                    run_id=run_id,
                    work_center_id=wc.id,
                    period_start=p_start,
                    period_end=p_end,
                    required_capacity=required,
                    available_capacity=available,
                    utilization_pct=round(utilization, 2),
                    is_bottleneck=is_bottleneck,
                )
                all_results.append(crp)

        db.add_all(all_results)
        await db.flush()
        return run_id

    @staticmethod
    async def get_results(
        run_id: uuid.UUID, db: AsyncSession
    ) -> list[CrpResult]:
        """Return CRP results for a run."""
        stmt = (
            select(CrpResult)
            .where(CrpResult.run_id == run_id)
            .order_by(CrpResult.period_start, CrpResult.work_center_id)
        )
        result = await db.execute(stmt)
        return list(result.scalars().all())

    @staticmethod
    async def get_bottlenecks(
        run_id: uuid.UUID | None = None, db: AsyncSession | None = None
    ) -> list[CrpResult]:
        """Return work centers with utilization > 90%."""
        assert db is not None
        stmt = select(CrpResult).where(CrpResult.is_bottleneck.is_(True))
        if run_id:
            stmt = stmt.where(CrpResult.run_id == run_id)
        stmt = stmt.order_by(CrpResult.utilization_pct.desc())
        result = await db.execute(stmt)
        return list(result.scalars().all())

    @staticmethod
    async def get_capacity_summary(
        start_date: date,
        end_date: date,
        db: AsyncSession,
    ) -> list[dict[str, Any]]:
        """Return capacity summary per work center for a date range."""
        stmt = (
            select(
                CrpResult.work_center_id,
                sa_func.avg(CrpResult.utilization_pct).label("avg_utilization"),
                sa_func.max(CrpResult.utilization_pct).label("max_utilization"),
                sa_func.sum(CrpResult.required_capacity).label("total_required"),
                sa_func.sum(CrpResult.available_capacity).label("total_available"),
            )
            .where(
                CrpResult.period_start >= start_date,
                CrpResult.period_end <= end_date,
            )
            .group_by(CrpResult.work_center_id)
        )
        result = await db.execute(stmt)
        rows = result.all()

        summary: list[dict[str, Any]] = []
        for row in rows:
            # Fetch work center name
            wc_stmt = select(WorkCenter).where(WorkCenter.id == row[0])
            wc_result = await db.execute(wc_stmt)
            wc = wc_result.scalar_one_or_none()
            summary.append(
                {
                    "work_center_id": str(row[0]),
                    "work_center_name": wc.name if wc else "Unknown",
                    "avg_utilization_pct": round(float(row[1] or 0), 2),
                    "max_utilization_pct": round(float(row[2] or 0), 2),
                    "total_required_capacity": round(float(row[3] or 0), 2),
                    "total_available_capacity": round(float(row[4] or 0), 2),
                }
            )
        return summary
