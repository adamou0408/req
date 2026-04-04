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
from app.mrp.bom_service import BomService
from app.mrp.crp_service import CrpService
from app.mrp.mps_service import MpsService
from app.mrp.mrp_runner import MrpRunner

router = APIRouter()


# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------


class MrpRunRequest(BaseModel):
    product_models: list[str] | None = None
    periods: int = Field(default=4, ge=1, le=52)
    period_length_days: int = Field(default=7, ge=1, le=90)


class MpsGenerateRequest(BaseModel):
    planning_horizon_weeks: int = Field(default=8, ge=1, le=52)


class MpsConfirmRequest(BaseModel):
    confirmed_quantity: float = Field(..., ge=0)


class CrpRunRequest(BaseModel):
    product_model: str | None = None
    start_date: date | None = None
    end_date: date | None = None


# ---------------------------------------------------------------------------
# Serializers
# ---------------------------------------------------------------------------


def _serialize_bom_header(bom: Any) -> dict[str, Any]:
    return {
        "id": str(bom.id),
        "product_model": bom.product_model,
        "version": bom.version,
        "effective_date": bom.effective_date.isoformat() if bom.effective_date else None,
        "status": bom.status,
        "items": [
            {
                "id": str(item.id),
                "part_number": item.part_number,
                "part_name": item.part_name,
                "quantity_per": item.quantity_per,
                "unit": item.unit,
                "lead_time_days": item.lead_time_days,
                "is_phantom": item.is_phantom,
                "parent_item_id": str(item.parent_item_id) if item.parent_item_id else None,
            }
            for item in bom.items
        ],
    }


def _serialize_mrp_result(r: Any) -> dict[str, Any]:
    return {
        "id": str(r.id),
        "run_id": str(r.run_id),
        "part_number": r.part_number,
        "period_start": r.period_start.isoformat(),
        "period_end": r.period_end.isoformat(),
        "gross_requirement": r.gross_requirement,
        "scheduled_receipts": r.scheduled_receipts,
        "projected_on_hand": r.projected_on_hand,
        "net_requirement": r.net_requirement,
        "planned_order_release": r.planned_order_release,
        "planned_order_receipt": r.planned_order_receipt,
        "action_message": r.action_message,
    }


def _serialize_mps(mps: Any) -> dict[str, Any]:
    return {
        "id": str(mps.id),
        "product_model": mps.product_model,
        "period_start": mps.period_start.isoformat(),
        "period_end": mps.period_end.isoformat(),
        "planned_quantity": mps.planned_quantity,
        "confirmed_quantity": mps.confirmed_quantity,
        "combo_id": str(mps.combo_id) if mps.combo_id else None,
        "status": mps.status,
    }


def _serialize_crp_result(r: Any) -> dict[str, Any]:
    return {
        "id": str(r.id),
        "run_id": str(r.run_id),
        "work_center_id": str(r.work_center_id),
        "period_start": r.period_start.isoformat(),
        "period_end": r.period_end.isoformat(),
        "required_capacity": r.required_capacity,
        "available_capacity": r.available_capacity,
        "utilization_pct": r.utilization_pct,
        "is_bottleneck": r.is_bottleneck,
    }


def _serialize_ecn(ecn: Any) -> dict[str, Any]:
    return {
        "id": str(ecn.id),
        "ecn_number": ecn.ecn_number,
        "bom_header_id": str(ecn.bom_header_id),
        "description": ecn.description,
        "change_type": ecn.change_type,
        "old_value": ecn.old_value,
        "new_value": ecn.new_value,
        "requested_by": ecn.requested_by,
        "approved_at": ecn.approved_at.isoformat() if ecn.approved_at else None,
    }


# ---------------------------------------------------------------------------
# BOM endpoints
# ---------------------------------------------------------------------------


@router.get("/bom/{product_model}")
async def get_bom(
    product_model: str,
    _current_user: dict[str, Any] = Depends(require_permission("bom_ecn")),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Get the active BOM for a product model."""
    bom = await BomService.get_bom(product_model, db)
    if bom is None:
        return {"detail": "BOM not found", "product_model": product_model}
    return _serialize_bom_header(bom)


@router.get("/bom/{product_model}/expand")
async def expand_bom(
    product_model: str,
    quantity: float = Query(default=1.0, ge=0),
    _current_user: dict[str, Any] = Depends(require_permission("bom_ecn")),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    """Multi-level BOM explosion returning flat component list."""
    return await BomService.expand_bom(product_model, quantity=quantity, db=db)


@router.get("/bom/search")
async def search_bom(
    part_number: str | None = Query(default=None),
    product_model: str | None = Query(default=None),
    _current_user: dict[str, Any] = Depends(require_permission("bom_ecn")),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    """Search BOMs by part_number or product_model."""
    boms = await BomService.search_bom(part_number=part_number, product_model=product_model, db=db)
    return [_serialize_bom_header(b) for b in boms]


@router.get("/bom/{product_model}/ecn")
async def get_ecn_history(
    product_model: str,
    _current_user: dict[str, Any] = Depends(require_permission("bom_ecn")),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    """Get ECN history for a product model."""
    ecns = await BomService.get_ecn_history(product_model=product_model, db=db)
    return [_serialize_ecn(e) for e in ecns]


@router.get("/bom/{product_model}/compare")
async def compare_bom_versions(
    product_model: str,
    version_a: int = Query(...),
    version_b: int = Query(...),
    _current_user: dict[str, Any] = Depends(require_permission("bom_ecn")),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Compare two BOM versions."""
    return await BomService.compare_bom_versions(product_model, version_a, version_b, db)


# ---------------------------------------------------------------------------
# MRP endpoints
# ---------------------------------------------------------------------------


@router.post("/run")
async def run_mrp(
    body: MrpRunRequest,
    _current_user: dict[str, Any] = Depends(require_permission("production_schedule")),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Trigger an MRP calculation run."""
    run_id = await MrpRunner.run_mrp(
        product_models=body.product_models,
        periods=body.periods,
        period_length_days=body.period_length_days,
        db=db,
    )
    return {"run_id": str(run_id)}


@router.get("/results/{run_id}")
async def get_mrp_results(
    run_id: uuid.UUID,
    _current_user: dict[str, Any] = Depends(require_permission("production_schedule")),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    """Get MRP results for a specific run."""
    results = await MrpRunner.get_results(run_id, db)
    return [_serialize_mrp_result(r) for r in results]


@router.get("/shortages")
async def get_shortages(
    run_id: uuid.UUID | None = Query(default=None),
    _current_user: dict[str, Any] = Depends(require_permission("production_schedule")),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    """Get shortage alerts — parts where net_requirement > 0."""
    results = await MrpRunner.get_shortage_alerts(run_id=run_id, db=db)
    return [_serialize_mrp_result(r) for r in results]


@router.get("/actions/{run_id}")
async def get_actions(
    run_id: uuid.UUID,
    _current_user: dict[str, Any] = Depends(require_permission("production_schedule")),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    """Get action messages for an MRP run."""
    results = await MrpRunner.get_action_messages(run_id, db)
    return [_serialize_mrp_result(r) for r in results]


# ---------------------------------------------------------------------------
# MPS endpoints
# ---------------------------------------------------------------------------


@router.post("/mps/generate")
async def generate_mps(
    body: MpsGenerateRequest,
    _current_user: dict[str, Any] = Depends(require_permission("production_schedule")),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    """Generate a master production schedule."""
    records = await MpsService.generate_mps(
        planning_horizon_weeks=body.planning_horizon_weeks, db=db
    )
    return [_serialize_mps(r) for r in records]


@router.get("/mps")
async def get_mps(
    product_model: str | None = Query(default=None),
    start_date: date | None = Query(default=None),
    end_date: date | None = Query(default=None),
    _current_user: dict[str, Any] = Depends(require_permission("production_schedule")),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    """Get MPS schedule with optional filters."""
    records = await MpsService.get_schedule(
        product_model=product_model,
        start_date=start_date,
        end_date=end_date,
        db=db,
    )
    return [_serialize_mps(r) for r in records]


@router.put("/mps/{mps_id}/confirm")
async def confirm_mps(
    mps_id: uuid.UUID,
    body: MpsConfirmRequest,
    _current_user: dict[str, Any] = Depends(require_permission("production_schedule")),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Confirm a planned MPS record."""
    mps = await MpsService.confirm_schedule(mps_id, body.confirmed_quantity, db)
    return _serialize_mps(mps)


@router.get("/mps/with-combos")
async def get_mps_with_combos(
    _current_user: dict[str, Any] = Depends(require_permission("production_schedule")),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    """Get MPS records enriched with combo info."""
    return await MpsService.get_schedule_with_combos(db)


# ---------------------------------------------------------------------------
# CRP endpoints
# ---------------------------------------------------------------------------


@router.post("/crp/run")
async def run_crp(
    body: CrpRunRequest | None = None,
    _current_user: dict[str, Any] = Depends(require_permission("production_schedule")),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Run CRP on current MPS records."""
    mps_records = await MpsService.get_schedule(
        product_model=body.product_model if body else None,
        start_date=body.start_date if body else None,
        end_date=body.end_date if body else None,
        db=db,
    )
    run_id = await CrpService.run_crp(mps_records, db)
    return {"run_id": str(run_id)}


@router.get("/crp/results/{run_id}")
async def get_crp_results(
    run_id: uuid.UUID,
    _current_user: dict[str, Any] = Depends(require_permission("production_schedule")),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    """Get CRP results for a specific run."""
    results = await CrpService.get_results(run_id, db)
    return [_serialize_crp_result(r) for r in results]


@router.get("/crp/bottlenecks")
async def get_bottlenecks(
    run_id: uuid.UUID | None = Query(default=None),
    _current_user: dict[str, Any] = Depends(require_permission("production_schedule")),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    """Get current bottlenecks (work centers > 90% utilization)."""
    results = await CrpService.get_bottlenecks(run_id=run_id, db=db)
    return [_serialize_crp_result(r) for r in results]


@router.get("/crp/summary")
async def get_capacity_summary(
    start: date = Query(...),
    end: date = Query(...),
    _current_user: dict[str, Any] = Depends(require_permission("production_schedule")),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    """Get capacity summary per work center for a date range."""
    return await CrpService.get_capacity_summary(start, end, db)
