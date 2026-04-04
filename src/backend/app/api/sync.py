from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.rbac import require_permission
from app.core.database import get_db
from app.core.models import SyncConfig, SyncMode
from app.core.security import get_current_user
from app.sync.monitoring import detect_sync_lag, get_sync_history, get_sync_status

router = APIRouter(prefix="/api/sync", tags=["sync"])


# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------


class SyncConfigCreate(BaseModel):
    data_source_id: uuid.UUID
    table_name: str = Field(..., max_length=255)
    sync_mode: str = Field(..., pattern="^(batch|cdc)$")
    cron_expression: str | None = Field(None, max_length=100)
    is_active: bool = True


class SyncConfigUpdate(BaseModel):
    table_name: str | None = Field(None, max_length=255)
    sync_mode: str | None = Field(None, pattern="^(batch|cdc)$")
    cron_expression: str | None = Field(None, max_length=100)
    is_active: bool | None = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _serialize_sync_config(sc: SyncConfig) -> dict[str, Any]:
    return {
        "id": str(sc.id),
        "data_source_id": str(sc.data_source_id),
        "table_name": sc.table_name,
        "sync_mode": sc.sync_mode.value if hasattr(sc.sync_mode, "value") else str(sc.sync_mode),
        "cron_expression": sc.cron_expression,
        "last_sync_at": sc.last_sync_at.isoformat() if sc.last_sync_at else None,
        "last_sync_status": sc.last_sync_status,
        "is_active": sc.is_active,
        "created_at": sc.created_at.isoformat() if sc.created_at else None,
        "updated_at": sc.updated_at.isoformat() if sc.updated_at else None,
    }


async def _get_sync_config_or_404(
    config_id: uuid.UUID, db: AsyncSession
) -> SyncConfig:
    stmt = select(SyncConfig).where(SyncConfig.id == config_id)
    result = await db.execute(stmt)
    sc = result.scalar_one_or_none()
    if sc is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Sync config not found",
        )
    return sc


# ---------------------------------------------------------------------------
# GET /configs
# ---------------------------------------------------------------------------


@router.get("/configs")
async def list_sync_configs(
    _current_user: dict[str, Any] = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    """Return all sync configs."""
    stmt = select(SyncConfig).order_by(SyncConfig.created_at.desc())
    result = await db.execute(stmt)
    return [_serialize_sync_config(sc) for sc in result.scalars().all()]


# ---------------------------------------------------------------------------
# POST /configs
# ---------------------------------------------------------------------------


@router.post("/configs", status_code=status.HTTP_201_CREATED)
async def create_sync_config(
    body: SyncConfigCreate,
    _current_user: dict[str, Any] = Depends(require_permission("db_management")),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Create a new sync config. Requires big_data role."""
    sc = SyncConfig(
        data_source_id=body.data_source_id,
        table_name=body.table_name,
        sync_mode=SyncMode(body.sync_mode),
        cron_expression=body.cron_expression,
        is_active=body.is_active,
    )
    db.add(sc)
    await db.flush()
    await db.refresh(sc)
    return _serialize_sync_config(sc)


# ---------------------------------------------------------------------------
# PUT /configs/{id}
# ---------------------------------------------------------------------------


@router.put("/configs/{config_id}")
async def update_sync_config(
    config_id: uuid.UUID,
    body: SyncConfigUpdate,
    _current_user: dict[str, Any] = Depends(require_permission("db_management")),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Update an existing sync config."""
    sc = await _get_sync_config_or_404(config_id, db)

    update_data = body.model_dump(exclude_unset=True)
    if "sync_mode" in update_data and update_data["sync_mode"] is not None:
        update_data["sync_mode"] = SyncMode(update_data["sync_mode"])

    for field, value in update_data.items():
        setattr(sc, field, value)

    db.add(sc)
    await db.flush()
    await db.refresh(sc)
    return _serialize_sync_config(sc)


# ---------------------------------------------------------------------------
# DELETE /configs/{id}
# ---------------------------------------------------------------------------


@router.delete("/configs/{config_id}", status_code=status.HTTP_204_NO_CONTENT)
async def deactivate_sync_config(
    config_id: uuid.UUID,
    _current_user: dict[str, Any] = Depends(require_permission("db_management")),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Soft-delete (deactivate) a sync config."""
    sc = await _get_sync_config_or_404(config_id, db)
    sc.is_active = False
    db.add(sc)
    await db.flush()


# ---------------------------------------------------------------------------
# POST /configs/{id}/trigger
# ---------------------------------------------------------------------------


@router.post("/configs/{config_id}/trigger")
async def trigger_sync(
    config_id: uuid.UUID,
    _current_user: dict[str, Any] = Depends(require_permission("db_management")),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Manually trigger a sync for a given config."""
    sc = await _get_sync_config_or_404(config_id, db)

    if not sc.is_active:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot trigger sync for an inactive config",
        )

    sync_mode = sc.sync_mode.value if hasattr(sc.sync_mode, "value") else str(sc.sync_mode)

    if sync_mode == "batch":
        from app.sync.batch_scheduler import run_batch_sync

        task = run_batch_sync.delay(str(config_id))
        return {"status": "triggered", "task_id": task.id, "sync_mode": "batch"}

    if sync_mode == "cdc":
        from app.sync.cdc_listener import cdc_manager

        started = await cdc_manager.start_one(config_id)
        return {
            "status": "started" if started else "already_running",
            "sync_mode": "cdc",
        }

    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail=f"Unknown sync mode: {sync_mode}",
    )


# ---------------------------------------------------------------------------
# GET /status
# ---------------------------------------------------------------------------


@router.get("/status")
async def sync_status(
    _current_user: dict[str, Any] = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Return all sync statuses with lag info."""
    statuses = await get_sync_status(db)
    lagging = await detect_sync_lag(db)
    return {
        "configs": statuses,
        "lagging_count": len(lagging),
        "lagging": lagging,
    }


# ---------------------------------------------------------------------------
# GET /history/{config_id}
# ---------------------------------------------------------------------------


@router.get("/history/{config_id}")
async def sync_history(
    config_id: uuid.UUID,
    limit: int = 50,
    _current_user: dict[str, Any] = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    """Return sync history for a specific config."""
    # Verify config exists
    await _get_sync_config_or_404(config_id, db)
    return await get_sync_history(config_id, db, limit=limit)
