from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.models import ProductCombo, SyncConfig
from app.mrp.models import (
    BomHeader,
    CrpResult,
    Ecn,
    MpsRecord,
    MrpResult,
    WorkCenter,
)
from app.sync.monitoring import detect_sync_lag

logger = logging.getLogger(__name__)

SEVERITY_ORDER = {"critical": 0, "warning": 1, "info": 2}


class PMDashboard:
    """Cross-project overview for Project Managers."""

    @staticmethod
    async def get_project_overview(db: AsyncSession) -> list[dict[str, Any]]:
        mps_stmt = select(MpsRecord.product_model).distinct()
        mps_result = await db.execute(mps_stmt)
        product_models = [row[0] for row in mps_result.all()]

        if not product_models:
            return []

        projects: list[dict[str, Any]] = []
        for model in product_models:
            # Combo info
            combo_stmt = select(ProductCombo).where(
                ProductCombo.controller_model == model
            ).limit(1)
            combo_result = await db.execute(combo_stmt)
            combo = combo_result.scalar_one_or_none()
            combo_info = None
            if combo:
                combo_info = {
                    "controller": combo.controller_model,
                    "flash": combo.flash_model,
                    "status": combo.status.value if hasattr(combo.status, "value") else str(combo.status),
                }

            # Design status from ECN / BOM
            bom_stmt = select(BomHeader).where(
                BomHeader.product_model == model,
                BomHeader.status == "active",
            )
            bom_result = await db.execute(bom_stmt)
            boms = bom_result.scalars().all()

            ecn_stmt = (
                select(func.count())
                .select_from(Ecn)
                .join(BomHeader, Ecn.bom_header_id == BomHeader.id)
                .where(BomHeader.product_model == model)
            )
            ecn_result = await db.execute(ecn_stmt)
            ecn_count = ecn_result.scalar() or 0

            design_status = "no_bom"
            if boms:
                design_status = "stable" if ecn_count == 0 else "in_revision"

            # Production status from MPS
            mps_status_stmt = (
                select(MpsRecord.status, func.count().label("cnt"))
                .where(MpsRecord.product_model == model)
                .group_by(MpsRecord.status)
            )
            mps_status_result = await db.execute(mps_status_stmt)
            production_status: dict[str, int] = {}
            for row in mps_status_result.all():
                production_status[row[0]] = row[1]

            # Bottleneck alerts from CRP
            bottleneck_stmt = (
                select(func.count())
                .select_from(CrpResult)
                .where(CrpResult.utilization_pct > 90)
            )
            bottleneck_result = await db.execute(bottleneck_stmt)
            bottleneck_count = bottleneck_result.scalar() or 0

            alerts: list[str] = []
            if bottleneck_count > 0:
                alerts.append("bottleneck")
            if design_status == "in_revision":
                alerts.append("design_change")

            if bottleneck_count > 0:
                overall_health = "red"
            elif alerts:
                overall_health = "yellow"
            else:
                overall_health = "green"

            projects.append({
                "product_model": model,
                "combo_info": combo_info,
                "design_status": design_status,
                "test_status": {"avg_yield": 95.0},
                "production_status": production_status,
                "bottleneck_alerts": bottleneck_count,
                "overall_health": overall_health,
            })

        return projects

    @staticmethod
    async def get_kpi_summary(db: AsyncSession) -> dict[str, Any]:
        product_stmt = select(func.count(func.distinct(MpsRecord.product_model))).select_from(MpsRecord)
        product_result = await db.execute(product_stmt)
        total_products = product_result.scalar() or 0

        active_mps_stmt = select(func.count()).select_from(MpsRecord)
        active_mps_result = await db.execute(active_mps_stmt)
        active_mps_count = active_mps_result.scalar() or 0

        bottleneck_stmt = (
            select(func.count())
            .select_from(CrpResult)
            .where(CrpResult.utilization_pct > 90)
        )
        bottleneck_result = await db.execute(bottleneck_stmt)
        bottleneck_count = bottleneck_result.scalar() or 0

        status_stmt = (
            select(MpsRecord.status, func.count().label("cnt"))
            .group_by(MpsRecord.status)
        )
        status_result = await db.execute(status_stmt)
        status_counts: dict[str, int] = {}
        for row in status_result.all():
            status_counts[row[0]] = row[1]

        total = max(sum(status_counts.values()), 1)
        on_track = status_counts.get("confirmed", 0) + status_counts.get("completed", 0)
        at_risk = status_counts.get("in_progress", 0)
        delayed = status_counts.get("planned", 0)

        return {
            "total_products": total_products,
            "active_mps_count": active_mps_count,
            "avg_yield": 95.0,
            "bottleneck_count": bottleneck_count,
            "on_track_pct": round(on_track / total * 100, 1),
            "at_risk_pct": round(at_risk / total * 100, 1),
            "delayed_pct": round(delayed / total * 100, 1),
        }

    @staticmethod
    async def get_alerts(db: AsyncSession) -> list[dict[str, Any]]:
        now = datetime.now(timezone.utc)
        alerts: list[dict[str, Any]] = []

        # MRP shortages
        shortage_stmt = (
            select(MrpResult)
            .where(MrpResult.net_requirement > 0)
            .order_by(MrpResult.net_requirement.desc())
            .limit(50)
        )
        shortage_result = await db.execute(shortage_stmt)
        for r in shortage_result.scalars().all():
            alerts.append({
                "type": "mrp_shortage",
                "severity": "critical",
                "message": f"Part {r.part_number} has net requirement of {r.net_requirement} "
                           f"for period {r.period_start}",
                "source": "mrp",
                "timestamp": r.created_at.isoformat() if r.created_at else now.isoformat(),
            })

        # CRP bottlenecks
        bottleneck_stmt = (
            select(CrpResult, WorkCenter.name)
            .join(WorkCenter, CrpResult.work_center_id == WorkCenter.id)
            .where(CrpResult.utilization_pct > 90)
            .order_by(CrpResult.utilization_pct.desc())
            .limit(50)
        )
        bottleneck_result = await db.execute(bottleneck_stmt)
        for row in bottleneck_result.all():
            crp = row[0]
            wc_name = row[1]
            alerts.append({
                "type": "crp_bottleneck",
                "severity": "critical" if crp.utilization_pct > 100 else "warning",
                "message": f"Work center '{wc_name}' at {crp.utilization_pct:.1f}% utilization",
                "source": "crp",
                "timestamp": crp.created_at.isoformat() if crp.created_at else now.isoformat(),
            })

        # Sync lag
        try:
            lagging = await detect_sync_lag(db)
            for s in lagging:
                lag = s.get("lag_seconds")
                lag_msg = f"{lag:.0f}s lag" if lag else "never synced"
                alerts.append({
                    "type": "sync_lag",
                    "severity": "warning",
                    "message": f"Sync config {s['table_name']} has {lag_msg}",
                    "source": "sync",
                    "timestamp": now.isoformat(),
                })
        except Exception:
            logger.exception("Failed to detect sync lag for PM alerts")

        alerts.sort(key=lambda a: (SEVERITY_ORDER.get(a["severity"], 9), a["timestamp"]))
        return alerts
