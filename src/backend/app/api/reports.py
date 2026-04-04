from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.rbac import require_permission
from app.core.database import get_db
from app.market.report_service import ReportService

router = APIRouter()


@router.get("/sales-trend")
async def sales_trend(
    group_by: str = Query("combo", pattern="^(combo|region|month)$"),
    start: str | None = Query(None, description="Start date YYYY-MM-DD"),
    end: str | None = Query(None, description="End date YYYY-MM-DD"),
    _current_user: dict[str, Any] = Depends(require_permission("sales_data")),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    """Return sales trend data grouped by combo, region, or month."""
    filters: dict[str, Any] = {}
    if start:
        filters["start"] = start
    if end:
        filters["end"] = end
    return await ReportService.get_sales_trend(
        group_by=group_by, filters=filters or None, db=db
    )


@router.get("/combo-performance")
async def combo_performance(
    _current_user: dict[str, Any] = Depends(require_permission("sales_data")),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    """Return combo-level performance metrics."""
    return await ReportService.get_combo_performance(db=db)


@router.get("/export/excel")
async def export_excel(
    group_by: str = Query("combo", pattern="^(combo|region|month)$"),
    _current_user: dict[str, Any] = Depends(require_permission("sales_data")),
    db: AsyncSession = Depends(get_db),
) -> Response:
    """Download sales trend data as an Excel file."""
    data = await ReportService.get_sales_trend(group_by=group_by, db=db)
    content = await ReportService.export_excel(data, f"sales_trend_{group_by}.xlsx")
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename=sales_trend_{group_by}.xlsx"},
    )


@router.get("/export/pdf")
async def export_pdf(
    group_by: str = Query("combo", pattern="^(combo|region|month)$"),
    _current_user: dict[str, Any] = Depends(require_permission("sales_data")),
    db: AsyncSession = Depends(get_db),
) -> Response:
    """Download sales trend data as a PDF file."""
    data = await ReportService.get_sales_trend(group_by=group_by, db=db)
    content = await ReportService.export_pdf(data, f"sales_trend_{group_by}.pdf")
    return Response(
        content=content,
        media_type="application/pdf",
        headers={"Content-Disposition": f"attachment; filename=sales_trend_{group_by}.pdf"},
    )
