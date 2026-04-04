from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.rbac import check_permission, require_permission
from app.core.database import get_db
from app.core.security import get_current_user
from app.etl.bi_service import BiReportService
from app.etl.dashboard_service import DashboardService
from app.etl.pipeline_service import EtlPipelineService

router = APIRouter()


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class PipelineCreate(BaseModel):
    name: str
    source_datasource_id: str
    source_table: str
    target_table: str
    transform_config: dict[str, Any] | None = None
    cron_expression: str | None = None


class PipelineUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    source_table: str | None = None
    target_table: str | None = None
    transform_config: dict[str, Any] | None = None
    cron_expression: str | None = None
    is_active: bool | None = None


class ReportCreate(BaseModel):
    name: str
    source_table: str
    chart_type: str
    config: dict[str, Any] | None = None


class ReportUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    source_table: str | None = None
    chart_type: str | None = None
    config: dict[str, Any] | None = None


class DashboardCreate(BaseModel):
    name: str
    description: str | None = None
    layout: list[dict[str, Any]] | None = None
    refresh_interval_seconds: int | None = None


class DashboardUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    layout: list[dict[str, Any]] | None = None
    refresh_interval_seconds: int | None = None


class EmailSchedule(BaseModel):
    cron: str
    recipients: list[str]


# ---------------------------------------------------------------------------
# Helper to serialize models
# ---------------------------------------------------------------------------


def _serialize_pipeline(p: Any) -> dict[str, Any]:
    return {
        "id": str(p.id),
        "name": p.name,
        "description": p.description,
        "source_datasource_id": str(p.source_datasource_id),
        "source_table": p.source_table,
        "target_table": p.target_table,
        "transform_config": p.transform_config,
        "cron_expression": p.cron_expression,
        "is_active": p.is_active,
        "last_run_at": p.last_run_at.isoformat() if p.last_run_at else None,
        "last_run_status": p.last_run_status,
        "last_run_duration_ms": p.last_run_duration_ms,
        "last_run_rows": p.last_run_rows,
        "created_by": str(p.created_by),
        "created_at": p.created_at.isoformat() if p.created_at else None,
        "updated_at": p.updated_at.isoformat() if p.updated_at else None,
    }


def _serialize_report(r: Any) -> dict[str, Any]:
    return {
        "id": str(r.id),
        "name": r.name,
        "description": r.description,
        "source_table": r.source_table,
        "chart_type": r.chart_type,
        "config": r.config,
        "created_by": str(r.created_by),
        "is_shared": r.is_shared,
        "share_approved": r.share_approved,
        "share_approved_by": str(r.share_approved_by) if r.share_approved_by else None,
        "created_at": r.created_at.isoformat() if r.created_at else None,
        "updated_at": r.updated_at.isoformat() if r.updated_at else None,
    }


def _serialize_dashboard(d: Any) -> dict[str, Any]:
    return {
        "id": str(d.id),
        "name": d.name,
        "description": d.description,
        "layout": d.layout,
        "refresh_interval_seconds": d.refresh_interval_seconds,
        "is_shared": d.is_shared,
        "share_approved": d.share_approved,
        "share_approved_by": str(d.share_approved_by) if d.share_approved_by else None,
        "created_by": str(d.created_by),
        "created_at": d.created_at.isoformat() if d.created_at else None,
        "updated_at": d.updated_at.isoformat() if d.updated_at else None,
    }


# ---------------------------------------------------------------------------
# Pipeline Endpoints
# ---------------------------------------------------------------------------


@router.get("/pipelines")
async def list_pipelines(
    db: AsyncSession = Depends(get_db),
    current_user: dict[str, Any] = Depends(get_current_user),
) -> list[dict[str, Any]]:
    pipelines = await EtlPipelineService.list_pipelines(db=db)
    return [_serialize_pipeline(p) for p in pipelines]


@router.post("/pipelines", status_code=status.HTTP_201_CREATED)
async def create_pipeline(
    body: PipelineCreate,
    db: AsyncSession = Depends(get_db),
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    role = current_user.get("role", "")
    if role not in ("big_data", "mis"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only big_data or mis roles can create pipelines",
        )
    pipeline = await EtlPipelineService.create_pipeline(
        name=body.name,
        source_datasource_id=uuid.UUID(body.source_datasource_id),
        source_table=body.source_table,
        target_table=body.target_table,
        transform_config=body.transform_config,
        cron_expression=body.cron_expression,
        user_id=uuid.UUID(current_user["user_id"]),
        db=db,
    )
    return _serialize_pipeline(pipeline)


@router.get("/pipelines/{pipeline_id}")
async def get_pipeline(
    pipeline_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    pipeline = await EtlPipelineService.get_pipeline(uuid.UUID(pipeline_id), db)
    if pipeline is None:
        raise HTTPException(status_code=404, detail="Pipeline not found")
    return _serialize_pipeline(pipeline)


@router.put("/pipelines/{pipeline_id}")
async def update_pipeline(
    pipeline_id: str,
    body: PipelineUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    updates = body.model_dump(exclude_none=True)
    pipeline = await EtlPipelineService.update_pipeline(uuid.UUID(pipeline_id), updates, db)
    if pipeline is None:
        raise HTTPException(status_code=404, detail="Pipeline not found")
    return _serialize_pipeline(pipeline)


@router.delete("/pipelines/{pipeline_id}")
async def delete_pipeline(
    pipeline_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, str]:
    success = await EtlPipelineService.delete_pipeline(uuid.UUID(pipeline_id), db)
    if not success:
        raise HTTPException(status_code=404, detail="Pipeline not found")
    return {"status": "deactivated"}


@router.post("/pipelines/{pipeline_id}/run")
async def run_pipeline(
    pipeline_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    result = await EtlPipelineService.run_pipeline(uuid.UUID(pipeline_id), db)
    return result


@router.get("/pipelines/{pipeline_id}/history")
async def pipeline_history(
    pipeline_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: dict[str, Any] = Depends(get_current_user),
) -> list[dict[str, Any]]:
    return await EtlPipelineService.get_run_history(uuid.UUID(pipeline_id), db)


# ---------------------------------------------------------------------------
# Report Endpoints
# ---------------------------------------------------------------------------


@router.get("/reports")
async def list_reports(
    db: AsyncSession = Depends(get_db),
    current_user: dict[str, Any] = Depends(get_current_user),
) -> list[dict[str, Any]]:
    user_id = uuid.UUID(current_user["user_id"])
    reports = await BiReportService.list_reports(db=db, user_id=user_id, include_shared=True)
    return [_serialize_report(r) for r in reports]


@router.post("/reports", status_code=status.HTTP_201_CREATED)
async def create_report(
    body: ReportCreate,
    db: AsyncSession = Depends(get_db),
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    report = await BiReportService.create_report(
        name=body.name,
        source_table=body.source_table,
        chart_type=body.chart_type,
        config=body.config,
        user_id=uuid.UUID(current_user["user_id"]),
        db=db,
    )
    return _serialize_report(report)


@router.get("/reports/tables")
async def available_tables(
    db: AsyncSession = Depends(get_db),
    current_user: dict[str, Any] = Depends(get_current_user),
) -> list[str]:
    return await BiReportService.list_available_tables(db)


@router.get("/reports/{report_id}")
async def get_report(
    report_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    from app.etl.models import BiReport
    from sqlalchemy import select

    stmt = select(BiReport).where(BiReport.id == uuid.UUID(report_id))
    result = await db.execute(stmt)
    report = result.scalar_one_or_none()
    if report is None:
        raise HTTPException(status_code=404, detail="Report not found")
    return _serialize_report(report)


@router.put("/reports/{report_id}")
async def update_report(
    report_id: str,
    body: ReportUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    updates = body.model_dump(exclude_none=True)
    report = await BiReportService.update_report(uuid.UUID(report_id), updates, db)
    if report is None:
        raise HTTPException(status_code=404, detail="Report not found")
    return _serialize_report(report)


@router.delete("/reports/{report_id}")
async def delete_report(
    report_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, str]:
    success = await BiReportService.delete_report(uuid.UUID(report_id), db)
    if not success:
        raise HTTPException(status_code=404, detail="Report not found")
    return {"status": "deleted"}


@router.post("/reports/{report_id}/execute")
async def execute_report(
    report_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    result = await BiReportService.execute_query(uuid.UUID(report_id), db)
    return result


@router.post("/reports/{report_id}/share")
async def share_report(
    report_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    report = await BiReportService.share_report(uuid.UUID(report_id), db)
    if report is None:
        raise HTTPException(status_code=404, detail="Report not found")
    return _serialize_report(report)


@router.post("/reports/{report_id}/approve-share")
async def approve_report_share(
    report_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    role = current_user.get("role", "")
    if role not in ("big_data", "mis"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only big_data or mis roles can approve sharing",
        )
    report = await BiReportService.approve_share(
        uuid.UUID(report_id),
        uuid.UUID(current_user["user_id"]),
        db,
    )
    if report is None:
        raise HTTPException(status_code=404, detail="Report not found")
    return _serialize_report(report)


# ---------------------------------------------------------------------------
# Dashboard Endpoints
# ---------------------------------------------------------------------------


@router.get("/dashboards")
async def list_dashboards(
    db: AsyncSession = Depends(get_db),
    current_user: dict[str, Any] = Depends(get_current_user),
) -> list[dict[str, Any]]:
    user_id = uuid.UUID(current_user["user_id"])
    dashboards = await DashboardService.list_dashboards(db=db, user_id=user_id, include_shared=True)
    return [_serialize_dashboard(d) for d in dashboards]


@router.post("/dashboards", status_code=status.HTTP_201_CREATED)
async def create_dashboard(
    body: DashboardCreate,
    db: AsyncSession = Depends(get_db),
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    dashboard = await DashboardService.create_dashboard(
        name=body.name,
        description=body.description,
        layout=body.layout,
        refresh_interval_seconds=body.refresh_interval_seconds,
        user_id=uuid.UUID(current_user["user_id"]),
        db=db,
    )
    return _serialize_dashboard(dashboard)


@router.get("/dashboards/{dashboard_id}")
async def get_dashboard(
    dashboard_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    result = await DashboardService.get_dashboard_with_data(uuid.UUID(dashboard_id), db)
    if "error" in result:
        raise HTTPException(status_code=404, detail=result["error"])
    return result


@router.put("/dashboards/{dashboard_id}")
async def update_dashboard(
    dashboard_id: str,
    body: DashboardUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    updates = body.model_dump(exclude_none=True)
    dashboard = await DashboardService.update_dashboard(uuid.UUID(dashboard_id), updates, db)
    if dashboard is None:
        raise HTTPException(status_code=404, detail="Dashboard not found")
    return _serialize_dashboard(dashboard)


@router.delete("/dashboards/{dashboard_id}")
async def delete_dashboard(
    dashboard_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, str]:
    success = await DashboardService.delete_dashboard(uuid.UUID(dashboard_id), db)
    if not success:
        raise HTTPException(status_code=404, detail="Dashboard not found")
    return {"status": "deleted"}


@router.post("/dashboards/{dashboard_id}/share")
async def share_dashboard(
    dashboard_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    dashboard = await DashboardService.share_dashboard(uuid.UUID(dashboard_id), db)
    if dashboard is None:
        raise HTTPException(status_code=404, detail="Dashboard not found")
    return _serialize_dashboard(dashboard)


@router.post("/dashboards/{dashboard_id}/approve-share")
async def approve_dashboard_share(
    dashboard_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    role = current_user.get("role", "")
    if role not in ("big_data", "mis"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only big_data or mis roles can approve sharing",
        )
    dashboard = await DashboardService.approve_share(
        uuid.UUID(dashboard_id),
        uuid.UUID(current_user["user_id"]),
        db,
    )
    if dashboard is None:
        raise HTTPException(status_code=404, detail="Dashboard not found")
    return _serialize_dashboard(dashboard)


@router.get("/dashboards/{dashboard_id}/export/pdf")
async def export_dashboard_pdf(
    dashboard_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: dict[str, Any] = Depends(get_current_user),
) -> Response:
    pdf_bytes = await DashboardService.export_pdf(uuid.UUID(dashboard_id), db)
    if not pdf_bytes:
        raise HTTPException(status_code=404, detail="Dashboard not found")
    return Response(
        content=pdf_bytes,
        media_type="text/html",
        headers={"Content-Disposition": f"attachment; filename=dashboard_{dashboard_id}.html"},
    )


@router.post("/dashboards/{dashboard_id}/schedule-email")
async def schedule_dashboard_email(
    dashboard_id: str,
    body: EmailSchedule,
    db: AsyncSession = Depends(get_db),
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    result = await DashboardService.schedule_email(
        uuid.UUID(dashboard_id),
        body.cron,
        body.recipients,
        db,
    )
    if "error" in result:
        raise HTTPException(status_code=404, detail=result["error"])
    return result
