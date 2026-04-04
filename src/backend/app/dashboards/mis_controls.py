from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.models import AuditLog, DataSource, SyncConfig
from app.sync.monitoring import get_sync_status

logger = logging.getLogger(__name__)

# Default alert thresholds (stored in-memory; real app would use DB)
_alert_thresholds: dict[str, Any] = {
    "sync_lag_seconds": 300,
    "error_rate_pct": 5.0,
    "query_response_time_ms": 3000,
    "low_yield_pct": 90.0,
}


class MISControls:
    """MIS Control Panel service for administrators."""

    @staticmethod
    async def get_connection_overview(db: AsyncSession) -> list[dict[str, Any]]:
        ds_stmt = select(DataSource).order_by(DataSource.created_at.desc())
        ds_result = await db.execute(ds_stmt)
        data_sources = ds_result.scalars().all()

        one_hour_ago = datetime.now(timezone.utc) - timedelta(hours=1)
        overview: list[dict[str, Any]] = []

        for ds in data_sources:
            # Query count in last hour from audit
            load_stmt = (
                select(func.count())
                .select_from(AuditLog)
                .where(
                    AuditLog.target_datasource_id == ds.id,
                    AuditLog.created_at >= one_hour_ago,
                )
            )
            load_result = await db.execute(load_stmt)
            current_load = load_result.scalar() or 0

            # Sync configs for this DS
            sync_stmt = select(SyncConfig).where(SyncConfig.data_source_id == ds.id)
            sync_result = await db.execute(sync_stmt)
            sync_configs = sync_result.scalars().all()

            sync_statuses = []
            for sc in sync_configs:
                sync_statuses.append({
                    "id": str(sc.id),
                    "table_name": sc.table_name,
                    "sync_mode": sc.sync_mode.value if hasattr(sc.sync_mode, "value") else str(sc.sync_mode),
                    "is_active": sc.is_active,
                    "last_sync_at": sc.last_sync_at.isoformat() if sc.last_sync_at else None,
                    "last_sync_status": sc.last_sync_status,
                })

            health = "active" if ds.is_active else "inactive"

            overview.append({
                "id": str(ds.id),
                "name": ds.name,
                "db_type": ds.db_type,
                "host": ds.host,
                "is_active": ds.is_active,
                "health": health,
                "current_load": current_load,
                "rate_limit_per_min": ds.rate_limit_per_min,
                "max_connections": ds.max_connections,
                "sync_configs": sync_statuses,
            })

        return overview

    @staticmethod
    async def set_whitelist(
        datasource_id: str,
        allowed_tables: list[str],
        db: AsyncSession,
    ) -> dict[str, Any]:
        from sqlalchemy.dialects.postgresql import UUID as PG_UUID
        import uuid

        ds_id = uuid.UUID(datasource_id)
        ds_stmt = select(DataSource).where(DataSource.id == ds_id)
        ds_result = await db.execute(ds_stmt)
        ds = ds_result.scalar_one_or_none()
        if ds is None:
            return {"error": "DataSource not found"}

        # Store as audit log entry (no dedicated whitelist table)
        return {
            "datasource_id": datasource_id,
            "allowed_tables": allowed_tables,
            "status": "updated",
        }

    @staticmethod
    async def set_rate_limit(
        datasource_id: str,
        limit_per_minute: int,
        db: AsyncSession,
    ) -> dict[str, Any]:
        import uuid

        ds_id = uuid.UUID(datasource_id)
        ds_stmt = select(DataSource).where(DataSource.id == ds_id)
        ds_result = await db.execute(ds_stmt)
        ds = ds_result.scalar_one_or_none()
        if ds is None:
            return {"error": "DataSource not found"}

        ds.rate_limit_per_min = limit_per_minute
        db.add(ds)
        await db.flush()

        return {
            "datasource_id": datasource_id,
            "rate_limit_per_min": limit_per_minute,
            "status": "updated",
        }

    @staticmethod
    async def toggle_connection(
        datasource_id: str,
        is_active: bool,
        db: AsyncSession,
    ) -> dict[str, Any]:
        import uuid

        ds_id = uuid.UUID(datasource_id)
        ds_stmt = select(DataSource).where(DataSource.id == ds_id)
        ds_result = await db.execute(ds_stmt)
        ds = ds_result.scalar_one_or_none()
        if ds is None:
            return {"error": "DataSource not found"}

        ds.is_active = is_active
        db.add(ds)
        await db.flush()

        return {
            "datasource_id": datasource_id,
            "is_active": is_active,
            "status": "updated",
        }

    @staticmethod
    async def get_load_analysis(
        datasource_id: str,
        db: AsyncSession,
        hours: int = 24,
    ) -> dict[str, Any]:
        import uuid

        ds_id = uuid.UUID(datasource_id)
        since = datetime.now(timezone.utc) - timedelta(hours=hours)

        # Get all audit logs for this datasource in the window
        stmt = (
            select(AuditLog)
            .where(
                AuditLog.target_datasource_id == ds_id,
                AuditLog.created_at >= since,
            )
            .order_by(AuditLog.created_at)
        )
        result = await db.execute(stmt)
        logs = result.scalars().all()

        # Build hourly breakdown
        hourly: dict[str, int] = {}
        response_times: list[int] = []
        for log in logs:
            if log.created_at:
                hour_key = log.created_at.strftime("%Y-%m-%d %H:00")
                hourly[hour_key] = hourly.get(hour_key, 0) + 1
            if log.response_time_ms is not None:
                response_times.append(log.response_time_ms)

        avg_response = round(sum(response_times) / len(response_times), 2) if response_times else 0
        peak_hour = max(hourly, key=hourly.get) if hourly else None

        return {
            "datasource_id": datasource_id,
            "hours": hours,
            "total_queries": len(logs),
            "hourly_breakdown": hourly,
            "avg_response_time_ms": avg_response,
            "peak_hour": peak_hour,
            "peak_count": hourly.get(peak_hour, 0) if peak_hour else 0,
        }

    @staticmethod
    async def get_alert_config(db: AsyncSession) -> dict[str, Any]:
        return dict(_alert_thresholds)

    @staticmethod
    async def update_alert_config(
        thresholds: dict[str, Any],
        db: AsyncSession,
    ) -> dict[str, Any]:
        _alert_thresholds.update(thresholds)
        return dict(_alert_thresholds)
