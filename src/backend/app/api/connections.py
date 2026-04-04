from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.rbac import require_permission
from app.connectors.registry import ConnectorRegistry
from app.core.database import get_db
from app.core.models import DataSource
from app.core.security import decrypt_password, encrypt_password, get_current_user

router = APIRouter(prefix="/api/connections", tags=["connections"])


# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------


class DataSourceCreate(BaseModel):
    name: str = Field(..., max_length=255)
    db_type: str = Field(..., max_length=50)
    host: str = Field(..., max_length=255)
    port: int = Field(..., gt=0, le=65535)
    database_name: str = Field(..., max_length=255)
    username: str = Field(..., max_length=255)
    password: str = Field(..., min_length=1)
    max_connections: int = Field(5, ge=1, le=100)
    rate_limit_per_min: int = Field(60, ge=1)


class DataSourceUpdate(BaseModel):
    name: str | None = Field(None, max_length=255)
    db_type: str | None = Field(None, max_length=50)
    host: str | None = Field(None, max_length=255)
    port: int | None = Field(None, gt=0, le=65535)
    database_name: str | None = Field(None, max_length=255)
    username: str | None = Field(None, max_length=255)
    password: str | None = None
    max_connections: int | None = Field(None, ge=1, le=100)
    rate_limit_per_min: int | None = Field(None, ge=1)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _serialize_datasource(ds: DataSource, mask_password: bool = True) -> dict[str, Any]:
    return {
        "id": str(ds.id),
        "name": ds.name,
        "db_type": ds.db_type,
        "host": ds.host,
        "port": ds.port,
        "database_name": ds.database_name,
        "username": ds.username,
        "password": "********" if mask_password else None,
        "is_active": ds.is_active,
        "max_connections": ds.max_connections,
        "rate_limit_per_min": ds.rate_limit_per_min,
        "created_by": str(ds.created_by),
        "created_at": ds.created_at.isoformat() if ds.created_at else None,
        "updated_at": ds.updated_at.isoformat() if ds.updated_at else None,
    }


async def _get_datasource_or_404(ds_id: uuid.UUID, db: AsyncSession) -> DataSource:
    stmt = select(DataSource).where(DataSource.id == ds_id, DataSource.is_active.is_(True))
    result = await db.execute(stmt)
    ds = result.scalar_one_or_none()
    if ds is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Data source not found")
    return ds


# ---------------------------------------------------------------------------
# GET /supported-types
# ---------------------------------------------------------------------------


@router.get("/supported-types")
async def supported_types(
    _current_user: dict[str, Any] = Depends(get_current_user),
) -> list[str]:
    """Return the list of supported database connector types."""
    return ConnectorRegistry.list_supported_types()


# ---------------------------------------------------------------------------
# GET / – list all data sources
# ---------------------------------------------------------------------------


@router.get("/")
async def list_data_sources(
    _current_user: dict[str, Any] = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    """Return all active data sources."""
    stmt = select(DataSource).where(DataSource.is_active.is_(True)).order_by(DataSource.name)
    result = await db.execute(stmt)
    return [_serialize_datasource(ds) for ds in result.scalars().all()]


# ---------------------------------------------------------------------------
# POST / – create data source
# ---------------------------------------------------------------------------


@router.post("/", status_code=status.HTTP_201_CREATED)
async def create_data_source(
    body: DataSourceCreate,
    current_user: dict[str, Any] = Depends(require_permission("db_management")),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Create a new data source. The password is encrypted before storage."""
    ds = DataSource(
        name=body.name,
        db_type=body.db_type,
        host=body.host,
        port=body.port,
        database_name=body.database_name,
        username=body.username,
        encrypted_password=encrypt_password(body.password),
        max_connections=body.max_connections,
        rate_limit_per_min=body.rate_limit_per_min,
        created_by=uuid.UUID(current_user["user_id"]),
    )
    db.add(ds)
    await db.flush()
    await db.refresh(ds)
    return _serialize_datasource(ds)


# ---------------------------------------------------------------------------
# GET /{id} – get data source details
# ---------------------------------------------------------------------------


@router.get("/{ds_id}")
async def get_data_source(
    ds_id: uuid.UUID,
    _current_user: dict[str, Any] = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Return data source details (password masked)."""
    ds = await _get_datasource_or_404(ds_id, db)
    return _serialize_datasource(ds)


# ---------------------------------------------------------------------------
# PUT /{id} – update data source
# ---------------------------------------------------------------------------


@router.put("/{ds_id}")
async def update_data_source(
    ds_id: uuid.UUID,
    body: DataSourceUpdate,
    _current_user: dict[str, Any] = Depends(require_permission("db_management")),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Update an existing data source."""
    ds = await _get_datasource_or_404(ds_id, db)

    update_data = body.model_dump(exclude_unset=True)
    if "password" in update_data:
        raw_pw = update_data.pop("password")
        if raw_pw is not None:
            ds.encrypted_password = encrypt_password(raw_pw)

    for field, value in update_data.items():
        setattr(ds, field, value)

    db.add(ds)
    await db.flush()
    await db.refresh(ds)
    return _serialize_datasource(ds)


# ---------------------------------------------------------------------------
# DELETE /{id} – soft delete
# ---------------------------------------------------------------------------


@router.delete("/{ds_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_data_source(
    ds_id: uuid.UUID,
    _current_user: dict[str, Any] = Depends(require_permission("db_management")),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Soft-delete a data source by setting ``is_active = False``."""
    ds = await _get_datasource_or_404(ds_id, db)
    ds.is_active = False
    db.add(ds)
    await db.flush()


# ---------------------------------------------------------------------------
# POST /{id}/test – test connection
# ---------------------------------------------------------------------------


@router.post("/{ds_id}/test")
async def test_connection(
    ds_id: uuid.UUID,
    _current_user: dict[str, Any] = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Test connectivity to the data source using the connector registry."""
    ds = await _get_datasource_or_404(ds_id, db)
    password = decrypt_password(ds.encrypted_password)

    try:
        connector = ConnectorRegistry.get_connector(
            db_type=ds.db_type,
            host=ds.host,
            port=ds.port,
            database=ds.database_name,
            username=ds.username,
            password=password,
        )
        result = connector.test_connection()
        return result
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    except Exception as exc:
        return {"success": False, "message": str(exc), "server_version": None}
