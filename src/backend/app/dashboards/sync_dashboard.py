from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.models import AuditLog, DataSource, SyncConfig
from app.sync.monitoring import get_sync_status

logger = logging.getLogger(__name__)


class SyncDashboard:
    """Sync Monitoring Dashboard service."""

    @staticmethod
    async def get_overview(db: AsyncSession) -> dict[str, Any]:
        total_stmt = select(func.count()).select_from(SyncConfig)
        total_result = await db.execute(total_stmt)
        total_configs = total_result.scalar() or 0

        active_stmt = (
            select(func.count())
            .select_from(SyncConfig)
            .where(SyncConfig.is_active == True)  # noqa: E712
        )
        active_result = await db.execute(active_stmt)
        active = active_result.scalar() or 0

        # By mode
        mode_stmt = (
            select(SyncConfig.sync_mode, func.count().label("cnt"))
            .group_by(SyncConfig.sync_mode)
        )
        mode_result = await db.execute(mode_stmt)
        by_mode: dict[str, int] = {}
        for row in mode_result.all():
            mode_val = row[0].value if hasattr(row[0], "value") else str(row[0])
            by_mode[mode_val] = row[1]

        # Health indicators from sync status
        statuses = await get_sync_status(db)
        healthy = 0
        lagging = 0
        failed = 0
        for s in statuses:
            if not s["is_active"]:
                continue
            if s["last_sync_status"] == "failed":
                failed += 1
            elif s["lag_seconds"] is not None and s["lag_seconds"] > 300:
                lagging += 1
            else:
                healthy += 1

        return {
            "total_configs": total_configs,
            "active": active,
            "by_mode": by_mode,
            "healthy": healthy,
            "lagging": lagging,
            "failed": failed,
        }

    @staticmethod
    async def get_detailed_status(db: AsyncSession) -> list[dict[str, Any]]:
        stmt = (
            select(SyncConfig, DataSource.name.label("ds_name"))
            .join(DataSource, SyncConfig.data_source_id == DataSource.id)
            .order_by(SyncConfig.created_at.desc())
        )
        result = await db.execute(stmt)
        rows = result.all()

        now = datetime.now(timezone.utc)
        detailed: list[dict[str, Any]] = []

        for row in rows:
            config = row[0]
            ds_name = row[1]

            lag_seconds: float | None = None
            if config.last_sync_at is not None:
                last_sync = config.last_sync_at
                if last_sync.tzinfo is None:
                    last_sync = last_sync.replace(tzinfo=timezone.utc)
                lag_seconds = (now - last_sync).total_seconds()

            # Determine health
            if not config.is_active:
                health = "inactive"
            elif config.last_sync_status == "failed":
                health = "failed"
            elif lag_seconds is not None and lag_seconds > 300:
                health = "lagging"
            elif lag_seconds is None and config.is_active:
                health = "lagging"
            else:
                health = "healthy"

            detailed.append({
                "id": str(config.id),
                "data_source_name": ds_name,
                "table_name": config.table_name,
                "sync_mode": config.sync_mode.value if hasattr(config.sync_mode, "value") else str(config.sync_mode),
                "last_sync_at": config.last_sync_at.isoformat() if config.last_sync_at else None,
                "lag_seconds": lag_seconds,
                "status": config.last_sync_status,
                "is_active": config.is_active,
                "health": health,
            })

        return detailed

    @staticmethod
    async def get_sync_timeline(
        config_id: str,
        db: AsyncSession,
        hours: int = 24,
    ) -> list[dict[str, Any]]:
        since = datetime.now(timezone.utc) - timedelta(hours=hours)

        stmt = (
            select(AuditLog)
            .where(
                AuditLog.action.like("sync.%"),
                AuditLog.query_text.like(f"%{config_id}%"),
                AuditLog.created_at >= since,
            )
            .order_by(AuditLog.created_at.desc())
            .limit(100)
        )
        result = await db.execute(stmt)
        logs = result.scalars().all()

        return [
            {
                "id": log.id,
                "action": log.action,
                "created_at": log.created_at.isoformat() if log.created_at else None,
                "response_time_ms": log.response_time_ms,
                "query_text": log.query_text,
            }
            for log in logs
        ]

    @staticmethod
    async def get_lag_trend(
        db: AsyncSession,
        hours: int = 24,
    ) -> list[dict[str, Any]]:
        """Return aggregated lag data. Since we don't store historical lag,
        return current snapshot per config as a simple trend point."""
        statuses = await get_sync_status(db)
        now = datetime.now(timezone.utc)

        trend: list[dict[str, Any]] = []
        for s in statuses:
            if not s["is_active"]:
                continue
            trend.append({
                "config_id": s["id"],
                "table_name": s["table_name"],
                "timestamp": now.isoformat(),
                "lag_seconds": s["lag_seconds"],
            })

        return trend
