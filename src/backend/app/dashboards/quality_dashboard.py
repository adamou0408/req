from __future__ import annotations

import uuid
from datetime import date, datetime, timezone
from typing import Any, Optional

from sqlalchemy import JSON, Date, Float, Integer, String, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.mrp.models import BomHeader, MpsRecord


# ---------------------------------------------------------------------------
# TestResult model
# ---------------------------------------------------------------------------


class TestResult(Base):
    __tablename__ = "test_results"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    batch_id: Mapped[str] = mapped_column(String(255), nullable=False)
    product_model: Mapped[str] = mapped_column(String(255), nullable=False)
    fw_version: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    bom_version: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    test_type: Mapped[str] = mapped_column(String(100), nullable=False)
    total_units: Mapped[int] = mapped_column(Integer, nullable=False)
    passed_units: Mapped[int] = mapped_column(Integer, nullable=False)
    failed_units: Mapped[int] = mapped_column(Integer, nullable=False)
    yield_rate: Mapped[float] = mapped_column(Float, nullable=False)
    test_date: Mapped[date] = mapped_column(Date, nullable=False)
    details: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())


# ---------------------------------------------------------------------------
# QualityDashboard service
# ---------------------------------------------------------------------------


class QualityDashboard:
    """Yield analysis service for QA and HW/FW RD."""

    @staticmethod
    async def get_yield_summary(
        db: AsyncSession,
        product_model: str | None = None,
        start_date: date | None = None,
        end_date: date | None = None,
    ) -> dict[str, Any]:
        filters = []
        if product_model:
            filters.append(TestResult.product_model == product_model)
        if start_date:
            filters.append(TestResult.test_date >= start_date)
        if end_date:
            filters.append(TestResult.test_date <= end_date)

        agg_stmt = select(
            func.avg(TestResult.yield_rate).label("avg_yield"),
            func.min(TestResult.yield_rate).label("min_yield"),
            func.max(TestResult.yield_rate).label("max_yield"),
            func.count().label("total_batches"),
            func.sum(TestResult.total_units).label("total_units"),
        )
        if filters:
            agg_stmt = agg_stmt.where(*filters)

        result = await db.execute(agg_stmt)
        row = result.one()

        by_product_stmt = (
            select(
                TestResult.product_model,
                func.avg(TestResult.yield_rate).label("avg_yield"),
                func.count().label("batch_count"),
            )
            .group_by(TestResult.product_model)
            .order_by(func.avg(TestResult.yield_rate).desc())
        )
        if filters:
            by_product_stmt = by_product_stmt.where(*filters)

        by_product_result = await db.execute(by_product_stmt)
        by_product = [
            {
                "model": r[0],
                "avg_yield": round(float(r[1]), 2) if r[1] else 0,
                "trend": "stable",
            }
            for r in by_product_result.all()
        ]

        return {
            "avg_yield": round(float(row.avg_yield), 2) if row.avg_yield else 0,
            "min_yield": round(float(row.min_yield), 2) if row.min_yield else 0,
            "max_yield": round(float(row.max_yield), 2) if row.max_yield else 0,
            "total_batches": row.total_batches or 0,
            "total_units": row.total_units or 0,
            "by_product": by_product,
        }

    @staticmethod
    async def get_yield_trend(
        product_model: str,
        db: AsyncSession,
        period: str = "daily",
    ) -> list[dict[str, Any]]:
        stmt = (
            select(
                TestResult.test_date,
                func.avg(TestResult.yield_rate).label("yield_rate"),
                func.sum(TestResult.total_units).label("total_units"),
            )
            .where(TestResult.product_model == product_model)
            .group_by(TestResult.test_date)
            .order_by(TestResult.test_date)
        )

        result = await db.execute(stmt)
        rows = result.all()

        return [
            {
                "period": r[0].isoformat() if r[0] else None,
                "yield_rate": round(float(r[1]), 2) if r[1] else 0,
                "total_units": r[2] or 0,
            }
            for r in rows
        ]

    @staticmethod
    async def get_failure_analysis(
        db: AsyncSession,
        product_model: str | None = None,
    ) -> dict[str, Any]:
        filters = []
        if product_model:
            filters.append(TestResult.product_model == product_model)

        stmt = select(
            TestResult.test_type,
            func.sum(TestResult.failed_units).label("fail_count"),
            func.sum(TestResult.total_units).label("total_units"),
        ).group_by(TestResult.test_type)

        if filters:
            stmt = stmt.where(*filters)

        result = await db.execute(stmt)
        by_test_type = []
        for r in result.all():
            total = r[2] or 1
            fail = r[1] or 0
            by_test_type.append({
                "type": r[0],
                "fail_count": fail,
                "fail_rate": round(float(fail) / float(total) * 100, 2),
            })

        return {
            "by_test_type": by_test_type,
            "top_failures": sorted(by_test_type, key=lambda x: x["fail_count"], reverse=True),
        }

    @staticmethod
    async def compare_fw_versions(
        product_model: str,
        version_a: str,
        version_b: str,
        db: AsyncSession,
    ) -> dict[str, Any]:
        async def _get_version_data(fw_version: str) -> dict[str, Any]:
            stmt = select(
                func.avg(TestResult.yield_rate).label("yield_rate"),
                func.sum(TestResult.total_units).label("units"),
            ).where(
                TestResult.product_model == product_model,
                TestResult.fw_version == fw_version,
            )
            result = await db.execute(stmt)
            row = result.one()

            type_stmt = (
                select(
                    TestResult.test_type,
                    func.avg(TestResult.yield_rate).label("yield_rate"),
                )
                .where(
                    TestResult.product_model == product_model,
                    TestResult.fw_version == fw_version,
                )
                .group_by(TestResult.test_type)
            )
            type_result = await db.execute(type_stmt)
            by_test_type = {
                r[0]: round(float(r[1]), 2) if r[1] else 0
                for r in type_result.all()
            }

            return {
                "yield": round(float(row.yield_rate), 2) if row.yield_rate else 0,
                "units": row.units or 0,
                "by_test_type": by_test_type,
            }

        data_a = await _get_version_data(version_a)
        data_b = await _get_version_data(version_b)

        diff_yield = round(data_b["yield"] - data_a["yield"], 2)

        return {
            "version_a": data_a,
            "version_b": data_b,
            "diff": {
                "yield_change": diff_yield,
                "improved": diff_yield > 0,
            },
        }

    @staticmethod
    async def trace_defect(
        batch_id: str,
        db: AsyncSession,
    ) -> dict[str, Any]:
        stmt = select(TestResult).where(TestResult.batch_id == batch_id)
        result = await db.execute(stmt)
        test_results = result.scalars().all()

        if not test_results:
            return {"batch_id": batch_id, "error": "Batch not found"}

        first = test_results[0]
        product_model = first.product_model
        bom_version = first.bom_version
        fw_version = first.fw_version

        bom_info = None
        if bom_version is not None:
            bom_stmt = select(BomHeader).where(
                BomHeader.product_model == product_model,
                BomHeader.version == bom_version,
            )
            bom_result = await db.execute(bom_stmt)
            bom = bom_result.scalar_one_or_none()
            if bom:
                bom_info = {
                    "id": str(bom.id),
                    "product_model": bom.product_model,
                    "version": bom.version,
                    "status": bom.status,
                }

        mps_stmt = select(MpsRecord).where(
            MpsRecord.product_model == product_model
        ).limit(5)
        mps_result = await db.execute(mps_stmt)
        production_info = [
            {
                "id": str(m.id),
                "product_model": m.product_model,
                "status": m.status,
                "planned_quantity": m.planned_quantity,
            }
            for m in mps_result.scalars().all()
        ]

        return {
            "batch_id": batch_id,
            "product_model": product_model,
            "bom_version": bom_version,
            "fw_version": fw_version,
            "test_results": [
                {
                    "id": str(t.id),
                    "test_type": t.test_type,
                    "yield_rate": t.yield_rate,
                    "total_units": t.total_units,
                    "passed_units": t.passed_units,
                    "failed_units": t.failed_units,
                    "test_date": t.test_date.isoformat(),
                }
                for t in test_results
            ],
            "bom_info": bom_info,
            "production_info": production_info,
        }

    @staticmethod
    async def get_quality_alerts(db: AsyncSession) -> list[dict[str, Any]]:
        now = datetime.now(timezone.utc)
        alerts: list[dict[str, Any]] = []

        low_yield_stmt = (
            select(TestResult)
            .where(TestResult.yield_rate < 90.0)
            .order_by(TestResult.test_date.desc())
            .limit(50)
        )
        result = await db.execute(low_yield_stmt)
        for t in result.scalars().all():
            alerts.append({
                "type": "low_yield",
                "severity": "critical" if t.yield_rate < 80.0 else "warning",
                "message": f"Batch {t.batch_id} ({t.product_model}) yield at {t.yield_rate:.1f}%",
                "source": "quality",
                "timestamp": t.created_at.isoformat() if t.created_at else now.isoformat(),
            })

        avg_stmt = (
            select(
                TestResult.product_model,
                func.avg(TestResult.yield_rate).label("avg_yield"),
            )
            .group_by(TestResult.product_model)
        )
        avg_result = await db.execute(avg_stmt)
        avg_map = {r[0]: float(r[1]) for r in avg_result.all() if r[1]}

        for model, avg_yield in avg_map.items():
            latest_stmt = (
                select(TestResult)
                .where(TestResult.product_model == model)
                .order_by(TestResult.test_date.desc())
                .limit(1)
            )
            latest_result = await db.execute(latest_stmt)
            latest = latest_result.scalar_one_or_none()
            if latest and (avg_yield - latest.yield_rate) > 5.0:
                alerts.append({
                    "type": "yield_drop",
                    "severity": "warning",
                    "message": f"{model} latest yield {latest.yield_rate:.1f}% "
                               f"dropped > 5% from avg {avg_yield:.1f}%",
                    "source": "quality",
                    "timestamp": latest.created_at.isoformat() if latest.created_at else now.isoformat(),
                })

        return alerts
