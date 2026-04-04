from __future__ import annotations

import csv
import io
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit.analyzer import AuditAnalyzer
from app.auth.rbac import require_permission
from app.core.database import get_db
from app.core.models import AuditLog

router = APIRouter(prefix="/api/audit", tags=["audit"])


# ---------------------------------------------------------------------------
# GET /logs – paginated audit logs with filters
# ---------------------------------------------------------------------------


@router.get(
    "/logs",
    dependencies=[Depends(require_permission("audit_log"))],
)
async def list_logs(
    user_id: uuid.UUID | None = Query(None, description="Filter by user ID"),
    action: str | None = Query(None, description="Filter by action"),
    start_date: datetime | None = Query(None, description="Start of date range (ISO 8601)"),
    end_date: datetime | None = Query(None, description="End of date range (ISO 8601)"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Return a paginated list of audit log entries."""
    filters: list[Any] = []
    if user_id is not None:
        filters.append(AuditLog.user_id == user_id)
    if action is not None:
        filters.append(AuditLog.action == action)
    if start_date is not None:
        filters.append(AuditLog.created_at >= start_date)
    if end_date is not None:
        filters.append(AuditLog.created_at <= end_date)

    # Total count
    count_stmt = select(func.count()).select_from(AuditLog).where(*filters) if filters else select(func.count()).select_from(AuditLog)
    total = (await db.execute(count_stmt)).scalar() or 0

    # Paginated data
    offset = (page - 1) * page_size
    data_stmt = (
        select(AuditLog)
        .where(*filters)
        .order_by(AuditLog.created_at.desc())
        .offset(offset)
        .limit(page_size)
    ) if filters else (
        select(AuditLog)
        .order_by(AuditLog.created_at.desc())
        .offset(offset)
        .limit(page_size)
    )

    result = await db.execute(data_stmt)
    logs = result.scalars().all()

    return {
        "total": total,
        "page": page,
        "page_size": page_size,
        "items": [
            {
                "id": entry.id,
                "user_id": str(entry.user_id),
                "action": entry.action,
                "target_datasource_id": str(entry.target_datasource_id) if entry.target_datasource_id else None,
                "query_text": entry.query_text,
                "response_time_ms": entry.response_time_ms,
                "ip_address": entry.ip_address,
                "created_at": entry.created_at.isoformat() if entry.created_at else None,
            }
            for entry in logs
        ],
    }


# ---------------------------------------------------------------------------
# GET /anomalies – detected anomalies
# ---------------------------------------------------------------------------


@router.get(
    "/anomalies",
    dependencies=[Depends(require_permission("audit_log"))],
)
async def get_anomalies(
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    """Return currently detected audit anomalies."""
    return await AuditAnalyzer.detect_anomalies(db)


# ---------------------------------------------------------------------------
# GET /export – export logs as CSV
# ---------------------------------------------------------------------------


@router.get(
    "/export",
    dependencies=[Depends(require_permission("audit_log"))],
)
async def export_logs(
    user_id: uuid.UUID | None = Query(None),
    action: str | None = Query(None),
    start_date: datetime | None = Query(None),
    end_date: datetime | None = Query(None),
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    """Export filtered audit logs as a downloadable CSV file."""
    filters: list[Any] = []
    if user_id is not None:
        filters.append(AuditLog.user_id == user_id)
    if action is not None:
        filters.append(AuditLog.action == action)
    if start_date is not None:
        filters.append(AuditLog.created_at >= start_date)
    if end_date is not None:
        filters.append(AuditLog.created_at <= end_date)

    stmt = (
        select(AuditLog)
        .where(*filters)
        .order_by(AuditLog.created_at.desc())
        .limit(10_000)
    ) if filters else (
        select(AuditLog)
        .order_by(AuditLog.created_at.desc())
        .limit(10_000)
    )

    result = await db.execute(stmt)
    logs = result.scalars().all()

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["id", "user_id", "action", "target_datasource_id", "query_text", "response_time_ms", "ip_address", "created_at"])

    for entry in logs:
        writer.writerow([
            entry.id,
            str(entry.user_id),
            entry.action,
            str(entry.target_datasource_id) if entry.target_datasource_id else "",
            entry.query_text or "",
            entry.response_time_ms or "",
            entry.ip_address or "",
            entry.created_at.isoformat() if entry.created_at else "",
        ])

    output.seek(0)
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=audit_logs.csv"},
    )
