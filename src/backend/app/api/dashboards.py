from __future__ import annotations

import uuid
from datetime import date
from typing import Any, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.rbac import require_permission
from app.core.database import get_db
from app.core.security import get_current_user
from app.dashboards.mis_controls import MISControls
from app.dashboards.pm_dashboard import PMDashboard
from app.dashboards.quality_dashboard import QualityDashboard
from app.dashboards.sync_dashboard import SyncDashboard

router = APIRouter()


# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------


class WhitelistRequest(BaseModel):
    allowed_tables: list[str]


class RateLimitRequest(BaseModel):
    limit_per_minute: int = Field(..., ge=1, le=10000)


class ToggleRequest(BaseModel):
    is_active: bool


class AlertConfigRequest(BaseModel):
    thresholds: dict[str, Any]


# ---------------------------------------------------------------------------
# PM Dashboard
# ---------------------------------------------------------------------------


@router.get("/pm/overview")
async def pm_overview(
    _current_user: dict[str, Any] = Depends(require_permission("production_schedule")),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    return await PMDashboard.get_project_overview(db)


@router.get("/pm/kpis")
async def pm_kpis(
    _current_user: dict[str, Any] = Depends(require_permission("production_schedule")),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    return await PMDashboard.get_kpi_summary(db)


@router.get("/pm/alerts")
async def pm_alerts(
    _current_user: dict[str, Any] = Depends(require_permission("production_schedule")),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    return await PMDashboard.get_alerts(db)


# ---------------------------------------------------------------------------
# Quality Dashboard
# ---------------------------------------------------------------------------


@router.get("/quality/yield-summary")
async def quality_yield_summary(
    product_model: str | None = Query(default=None),
    start_date: date | None = Query(default=None),
    end_date: date | None = Query(default=None),
    _current_user: dict[str, Any] = Depends(require_permission("test_data")),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    return await QualityDashboard.get_yield_summary(
        db=db,
        product_model=product_model,
        start_date=start_date,
        end_date=end_date,
    )


@router.get("/quality/yield-trend/{product_model}")
async def quality_yield_trend(
    product_model: str,
    period: str = Query(default="daily"),
    _current_user: dict[str, Any] = Depends(require_permission("test_data")),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    return await QualityDashboard.get_yield_trend(
        product_model=product_model, db=db, period=period
    )


@router.get("/quality/failure-analysis")
async def quality_failure_analysis(
    product_model: str | None = Query(default=None),
    _current_user: dict[str, Any] = Depends(require_permission("test_data")),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    return await QualityDashboard.get_failure_analysis(db=db, product_model=product_model)


@router.get("/quality/compare-fw")
async def quality_compare_fw(
    product_model: str = Query(...),
    version_a: str = Query(...),
    version_b: str = Query(...),
    _current_user: dict[str, Any] = Depends(require_permission("test_data")),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    return await QualityDashboard.compare_fw_versions(
        product_model=product_model,
        version_a=version_a,
        version_b=version_b,
        db=db,
    )


@router.get("/quality/trace/{batch_id}")
async def quality_trace(
    batch_id: str,
    _current_user: dict[str, Any] = Depends(require_permission("test_data")),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    return await QualityDashboard.trace_defect(batch_id=batch_id, db=db)


@router.get("/quality/alerts")
async def quality_alerts(
    _current_user: dict[str, Any] = Depends(require_permission("test_data")),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    return await QualityDashboard.get_quality_alerts(db=db)


# ---------------------------------------------------------------------------
# MIS Controls
# ---------------------------------------------------------------------------


@router.get("/mis/connections")
async def mis_connections(
    _current_user: dict[str, Any] = Depends(require_permission("db_management")),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    return await MISControls.get_connection_overview(db)


@router.put("/mis/connections/{datasource_id}/whitelist")
async def mis_set_whitelist(
    datasource_id: str,
    body: WhitelistRequest,
    _current_user: dict[str, Any] = Depends(require_permission("db_management")),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    return await MISControls.set_whitelist(
        datasource_id=datasource_id,
        allowed_tables=body.allowed_tables,
        db=db,
    )


@router.put("/mis/connections/{datasource_id}/rate-limit")
async def mis_set_rate_limit(
    datasource_id: str,
    body: RateLimitRequest,
    _current_user: dict[str, Any] = Depends(require_permission("db_management")),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    return await MISControls.set_rate_limit(
        datasource_id=datasource_id,
        limit_per_minute=body.limit_per_minute,
        db=db,
    )


@router.put("/mis/connections/{datasource_id}/toggle")
async def mis_toggle_connection(
    datasource_id: str,
    body: ToggleRequest,
    _current_user: dict[str, Any] = Depends(require_permission("db_management")),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    return await MISControls.toggle_connection(
        datasource_id=datasource_id,
        is_active=body.is_active,
        db=db,
    )


@router.get("/mis/connections/{datasource_id}/load")
async def mis_load_analysis(
    datasource_id: str,
    hours: int = Query(default=24, ge=1, le=720),
    _current_user: dict[str, Any] = Depends(require_permission("db_management")),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    return await MISControls.get_load_analysis(
        datasource_id=datasource_id, db=db, hours=hours
    )


@router.get("/mis/alerts/config")
async def mis_alert_config(
    _current_user: dict[str, Any] = Depends(require_permission("db_management")),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    return await MISControls.get_alert_config(db)


@router.put("/mis/alerts/config")
async def mis_update_alert_config(
    body: AlertConfigRequest,
    _current_user: dict[str, Any] = Depends(require_permission("db_management")),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    return await MISControls.update_alert_config(thresholds=body.thresholds, db=db)


# ---------------------------------------------------------------------------
# Sync Monitoring
# ---------------------------------------------------------------------------


@router.get("/sync/overview")
async def sync_overview(
    _current_user: dict[str, Any] = Depends(require_permission("db_management")),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    return await SyncDashboard.get_overview(db)


@router.get("/sync/detailed")
async def sync_detailed(
    _current_user: dict[str, Any] = Depends(require_permission("db_management")),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    return await SyncDashboard.get_detailed_status(db)


@router.get("/sync/timeline/{config_id}")
async def sync_timeline(
    config_id: str,
    hours: int = Query(default=24, ge=1, le=720),
    _current_user: dict[str, Any] = Depends(require_permission("db_management")),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    return await SyncDashboard.get_sync_timeline(
        config_id=config_id, db=db, hours=hours
    )


@router.get("/sync/lag-trend")
async def sync_lag_trend(
    hours: int = Query(default=24, ge=1, le=720),
    _current_user: dict[str, Any] = Depends(require_permission("db_management")),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    return await SyncDashboard.get_lag_trend(db=db, hours=hours)
