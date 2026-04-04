from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.rbac import require_permission
from app.core.database import get_db
from app.core.models import FieldMapping
from app.core.security import get_current_user
from app.sync.mapping import FieldMappingService

router = APIRouter(prefix="/api/mappings", tags=["mappings"])


# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------


class FieldMappingEntry(BaseModel):
    source_field: str = Field(..., max_length=255)
    target_field: str = Field(..., max_length=255)
    transform_rule: dict[str, Any] | None = None


class MappingCreate(BaseModel):
    name: str = Field(..., max_length=255)
    source_datasource_id: uuid.UUID
    source_table: str = Field(..., max_length=255)
    mappings: list[FieldMappingEntry]


class MappingUpdate(BaseModel):
    source_datasource_id: uuid.UUID | None = None
    source_table: str | None = Field(None, max_length=255)
    mappings: list[FieldMappingEntry]


class PreviewRequest(BaseModel):
    mappings: list[FieldMappingEntry]
    sample_data: list[dict[str, Any]]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _serialize_field_mapping(fm: FieldMapping) -> dict[str, Any]:
    return {
        "id": str(fm.id),
        "name": fm.name,
        "version": fm.version,
        "source_datasource_id": str(fm.source_datasource_id),
        "source_table": fm.source_table,
        "source_field": fm.source_field,
        "target_field": fm.target_field,
        "transform_rule": fm.transform_rule,
        "created_at": fm.created_at.isoformat() if fm.created_at else None,
    }


# ---------------------------------------------------------------------------
# GET / — list all mappings
# ---------------------------------------------------------------------------


@router.get("/")
async def list_mappings(
    _current_user: dict[str, Any] = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    """List all mapping names with their latest version info."""
    return await FieldMappingService.list_all(db)


# ---------------------------------------------------------------------------
# POST / — create mapping
# ---------------------------------------------------------------------------


@router.post("/", status_code=status.HTTP_201_CREATED)
async def create_mapping(
    body: MappingCreate,
    _current_user: dict[str, Any] = Depends(require_permission("db_management")),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    """Create a new field mapping (version 1)."""
    mappings_data = [m.model_dump() for m in body.mappings]
    created = await FieldMappingService.create_mapping(
        name=body.name,
        source_ds_id=body.source_datasource_id,
        source_table=body.source_table,
        mappings=mappings_data,
        db=db,
    )
    return [_serialize_field_mapping(fm) for fm in created]


# ---------------------------------------------------------------------------
# GET /{id} — get mapping details
# ---------------------------------------------------------------------------


@router.get("/{mapping_id}")
async def get_mapping(
    mapping_id: uuid.UUID,
    _current_user: dict[str, Any] = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Get a single field mapping by ID."""
    fm = await FieldMappingService.get_mapping_by_id(mapping_id, db)
    if fm is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Field mapping not found",
        )
    return _serialize_field_mapping(fm)


# ---------------------------------------------------------------------------
# PUT /{id} — update mapping (creates new version)
# ---------------------------------------------------------------------------


@router.put("/{mapping_id}")
async def update_mapping(
    mapping_id: uuid.UUID,
    body: MappingUpdate,
    _current_user: dict[str, Any] = Depends(require_permission("db_management")),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    """Update a mapping by creating a new version."""
    # Get existing mapping to find name and defaults
    existing = await FieldMappingService.get_mapping_by_id(mapping_id, db)
    if existing is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Field mapping not found",
        )

    source_ds_id = body.source_datasource_id or existing.source_datasource_id
    source_table = body.source_table or existing.source_table
    mappings_data = [m.model_dump() for m in body.mappings]

    updated = await FieldMappingService.update_mapping(
        name=existing.name,
        source_ds_id=source_ds_id,
        source_table=source_table,
        mappings=mappings_data,
        db=db,
    )
    return [_serialize_field_mapping(fm) for fm in updated]


# ---------------------------------------------------------------------------
# GET /{name}/history — version history
# ---------------------------------------------------------------------------


@router.get("/{name}/history")
async def mapping_history(
    name: str,
    _current_user: dict[str, Any] = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    """Return version history for a named mapping."""
    history = await FieldMappingService.get_mapping_history(name, db)
    if not history:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No mapping found with name '{name}'",
        )
    return history


# ---------------------------------------------------------------------------
# POST /{name}/rollback/{version} — rollback
# ---------------------------------------------------------------------------


@router.post("/{name}/rollback/{version}")
async def rollback_mapping(
    name: str,
    version: int,
    _current_user: dict[str, Any] = Depends(require_permission("db_management")),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    """Rollback a mapping to a specific version (creates a new version)."""
    try:
        rolled_back = await FieldMappingService.rollback_mapping(name, version, db)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        )
    return [_serialize_field_mapping(fm) for fm in rolled_back]


# ---------------------------------------------------------------------------
# POST /preview — preview transform
# ---------------------------------------------------------------------------


@router.post("/preview")
async def preview_transform(
    body: PreviewRequest,
    _current_user: dict[str, Any] = Depends(get_current_user),
) -> list[dict[str, Any]]:
    """Preview a mapping transform on sample data without persisting."""
    # Build temporary FieldMapping objects for the transform
    temp_mappings: list[FieldMapping] = []
    for entry in body.mappings:
        fm = FieldMapping(
            id=uuid.uuid4(),
            name="_preview",
            version=0,
            source_datasource_id=uuid.uuid4(),
            source_table="_preview",
            source_field=entry.source_field,
            target_field=entry.target_field,
            transform_rule=entry.transform_rule,
        )
        temp_mappings.append(fm)

    try:
        return FieldMappingService.apply_mapping(temp_mappings, body.sample_data)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Transform error: {exc}",
        )
