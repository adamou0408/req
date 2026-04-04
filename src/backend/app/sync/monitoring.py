from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.models import SyncConfig

logger = logging.getLogger(__name__)


async def get_sync_status(db: AsyncSession) -> list[dict[str, Any]]:
    """Return the current status of all sync configs with lag information."""
    stmt = select(SyncConfig).order_by(SyncConfig.created_at.desc())
    result = await db.execute(stmt)
    configs = result.scalars().all()

    now = datetime.now(timezone.utc)
    statuses: list[dict[str, Any]] = []
    for config in configs:
        lag_seconds: float | None = None
        if config.last_sync_at is not None:
            last_sync = config.last_sync_at
            if last_sync.tzinfo is None:
                last_sync = last_sync.replace(tzinfo=timezone.utc)
            lag_seconds = (now - last_sync).total_seconds()

        statuses.append({
            "id": str(config.id),
            "data_source_id": str(config.data_source_id),
            "table_name": config.table_name,
            "sync_mode": config.sync_mode.value if hasattr(config.sync_mode, "value") else str(config.sync_mode),
            "is_active": config.is_active,
            "last_sync_at": config.last_sync_at.isoformat() if config.last_sync_at else None,
            "last_sync_status": config.last_sync_status,
            "lag_seconds": lag_seconds,
            "cron_expression": config.cron_expression,
        })

    return statuses


async def detect_sync_lag(
    db: AsyncSession,
    threshold_seconds: float = 300,
) -> list[dict[str, Any]]:
    """Return active sync configs where lag exceeds the given threshold."""
    all_statuses = await get_sync_status(db)
    lagging: list[dict[str, Any]] = []

    for status in all_statuses:
        if not status["is_active"]:
            continue
        lag = status.get("lag_seconds")
        if lag is not None and lag > threshold_seconds:
            status["threshold_seconds"] = threshold_seconds
            lagging.append(status)
        elif lag is None and status["is_active"]:
            # Never synced — considered lagging
            status["threshold_seconds"] = threshold_seconds
            status["lag_seconds"] = None
            lagging.append(status)

    return lagging


async def get_sync_history(
    sync_config_id: uuid.UUID,
    db: AsyncSession,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """Return recent sync run history for a specific config.

    This queries the audit_logs table for sync-related events, falling
    back to the sync config's own last_sync_at / last_sync_status if no
    dedicated history table exists.
    """
    from app.core.models import AuditLog

    # Try to get sync events from audit logs
    stmt = (
        select(AuditLog)
        .where(
            AuditLog.action.like(f"sync.%"),
            AuditLog.query_text.like(f"%{sync_config_id}%"),
        )
        .order_by(AuditLog.created_at.desc())
        .limit(limit)
    )
    result = await db.execute(stmt)
    audit_rows = result.scalars().all()

    if audit_rows:
        return [
            {
                "id": row.id,
                "action": row.action,
                "created_at": row.created_at.isoformat() if row.created_at else None,
                "query_text": row.query_text,
                "response_time_ms": row.response_time_ms,
            }
            for row in audit_rows
        ]

    # Fallback: return current config status as a single-entry history
    config_stmt = select(SyncConfig).where(SyncConfig.id == sync_config_id)
    config_result = await db.execute(config_stmt)
    config = config_result.scalar_one_or_none()

    if config is None:
        return []

    history: list[dict[str, Any]] = []
    if config.last_sync_at is not None:
        history.append({
            "id": None,
            "action": f"sync.{config.sync_mode.value if hasattr(config.sync_mode, 'value') else config.sync_mode}",
            "created_at": config.last_sync_at.isoformat(),
            "status": config.last_sync_status,
            "response_time_ms": None,
        })

    return history
