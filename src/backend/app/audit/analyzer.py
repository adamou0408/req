from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.models import AuditLog

logger = logging.getLogger(__name__)

# Thresholds
SLOW_QUERY_THRESHOLD_MS = 3000
HIGH_FREQUENCY_THRESHOLD = 60  # queries per minute


class AuditAnalyzer:
    """Analyses audit log data for anomalies and usage statistics."""

    @staticmethod
    async def detect_anomalies(db: AsyncSession) -> list[dict[str, Any]]:
        """Return a list of detected anomaly dicts.

        Current checks:
        * **slow_query** -- any audit entry with ``response_time_ms > 3000``.
        * **high_frequency** -- any user who issued > 60 actions in the last
          minute.
        """
        anomalies: list[dict[str, Any]] = []

        # -- Slow queries (last 24 hours) ----------------------------------
        since = datetime.now(timezone.utc) - timedelta(hours=24)
        slow_stmt = (
            select(AuditLog)
            .where(
                AuditLog.response_time_ms > SLOW_QUERY_THRESHOLD_MS,
                AuditLog.created_at >= since,
            )
            .order_by(AuditLog.response_time_ms.desc())
            .limit(100)
        )
        result = await db.execute(slow_stmt)
        for entry in result.scalars().all():
            anomalies.append(
                {
                    "type": "slow_query",
                    "audit_log_id": entry.id,
                    "user_id": str(entry.user_id),
                    "action": entry.action,
                    "response_time_ms": entry.response_time_ms,
                    "created_at": entry.created_at.isoformat() if entry.created_at else None,
                }
            )

        # -- High-frequency users (last minute) ----------------------------
        one_min_ago = datetime.now(timezone.utc) - timedelta(minutes=1)
        freq_stmt = (
            select(AuditLog.user_id, func.count().label("cnt"))
            .where(AuditLog.created_at >= one_min_ago)
            .group_by(AuditLog.user_id)
            .having(func.count() > HIGH_FREQUENCY_THRESHOLD)
        )
        result = await db.execute(freq_stmt)
        for row in result.all():
            anomalies.append(
                {
                    "type": "high_frequency",
                    "user_id": str(row.user_id),
                    "query_count_last_minute": row.cnt,
                }
            )

        return anomalies

    @staticmethod
    async def get_stats(
        db: AsyncSession,
        start_date: datetime,
        end_date: datetime,
    ) -> dict[str, Any]:
        """Return summary statistics for the given date range."""
        base_filter = [
            AuditLog.created_at >= start_date,
            AuditLog.created_at <= end_date,
        ]

        # Total count
        total_stmt = select(func.count()).select_from(AuditLog).where(*base_filter)
        total_result = await db.execute(total_stmt)
        total_count = total_result.scalar() or 0

        # Unique users
        users_stmt = (
            select(func.count(func.distinct(AuditLog.user_id)))
            .select_from(AuditLog)
            .where(*base_filter)
        )
        users_result = await db.execute(users_stmt)
        unique_users = users_result.scalar() or 0

        # Average response time
        avg_stmt = (
            select(func.avg(AuditLog.response_time_ms))
            .select_from(AuditLog)
            .where(*base_filter, AuditLog.response_time_ms.is_not(None))
        )
        avg_result = await db.execute(avg_stmt)
        avg_response_time = avg_result.scalar()

        # Actions breakdown
        actions_stmt = (
            select(AuditLog.action, func.count().label("cnt"))
            .where(*base_filter)
            .group_by(AuditLog.action)
            .order_by(func.count().desc())
            .limit(20)
        )
        actions_result = await db.execute(actions_stmt)
        actions_breakdown = {row.action: row.cnt for row in actions_result.all()}

        return {
            "start_date": start_date.isoformat(),
            "end_date": end_date.isoformat(),
            "total_events": total_count,
            "unique_users": unique_users,
            "avg_response_time_ms": round(float(avg_response_time), 2) if avg_response_time else None,
            "actions_breakdown": actions_breakdown,
        }
