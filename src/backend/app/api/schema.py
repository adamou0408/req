from __future__ import annotations

import logging
import time
import uuid
from dataclasses import asdict
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit.logger import AuditLogger
from app.connectors.base import DBConnector
from app.connectors.registry import ConnectorRegistry
from app.core.database import get_db
from app.core.models import DataSource
from app.core.security import decrypt_password, get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/schema", tags=["schema"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _get_datasource(ds_id: uuid.UUID, db: AsyncSession) -> DataSource:
    stmt = select(DataSource).where(DataSource.id == ds_id, DataSource.is_active.is_(True))
    result = await db.execute(stmt)
    ds = result.scalar_one_or_none()
    if ds is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Data source not found")
    return ds


def _build_connector(ds: DataSource) -> DBConnector:
    password = decrypt_password(ds.encrypted_password)
    return ConnectorRegistry.get_connector(
        db_type=ds.db_type,
        host=ds.host,
        port=ds.port,
        database=ds.database_name,
        username=ds.username,
        password=password,
    )


def _client_ip(request: Request) -> str | None:
    if request.client:
        return request.client.host
    return None


# ---------------------------------------------------------------------------
# GET /{datasource_id}/tables
# ---------------------------------------------------------------------------


@router.get("/{datasource_id}/tables")
async def list_tables(
    datasource_id: uuid.UUID,
    schema: str | None = Query(None, description="Database schema to list tables from"),
    request: Request = ...,  # type: ignore[assignment]
    current_user: dict[str, Any] = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    """List all tables in a data source."""
    ds = await _get_datasource(datasource_id, db)
    connector = _build_connector(ds)

    start = time.monotonic()
    try:
        tables = connector.list_tables(schema=schema)
        elapsed_ms = int((time.monotonic() - start) * 1000)
        result = [asdict(t) for t in tables]
    except Exception as exc:
        logger.exception("Error listing tables for datasource %s", datasource_id)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc))
    finally:
        try:
            connector.disconnect()
        except Exception:
            pass

    await AuditLogger.log(
        user_id=uuid.UUID(current_user["user_id"]),
        action="schema.list_tables",
        target_datasource_id=datasource_id,
        query_text=f"schema={schema}" if schema else None,
        response_time_ms=elapsed_ms,
        ip_address=_client_ip(request),
        db=db,
    )
    return result


# ---------------------------------------------------------------------------
# GET /{datasource_id}/tables/{table_name}/columns
# ---------------------------------------------------------------------------


@router.get("/{datasource_id}/tables/{table_name}/columns")
async def list_columns(
    datasource_id: uuid.UUID,
    table_name: str,
    schema: str | None = Query(None),
    request: Request = ...,  # type: ignore[assignment]
    current_user: dict[str, Any] = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    """List columns for a specific table."""
    ds = await _get_datasource(datasource_id, db)
    connector = _build_connector(ds)

    start = time.monotonic()
    try:
        columns = connector.list_columns(table_name, schema=schema)
        elapsed_ms = int((time.monotonic() - start) * 1000)
        result = [asdict(c) for c in columns]
    except Exception as exc:
        logger.exception("Error listing columns for %s.%s", datasource_id, table_name)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc))
    finally:
        try:
            connector.disconnect()
        except Exception:
            pass

    await AuditLogger.log(
        user_id=uuid.UUID(current_user["user_id"]),
        action="schema.list_columns",
        target_datasource_id=datasource_id,
        query_text=f"table={table_name}, schema={schema}",
        response_time_ms=elapsed_ms,
        ip_address=_client_ip(request),
        db=db,
    )
    return result


# ---------------------------------------------------------------------------
# GET /{datasource_id}/tables/{table_name}/preview
# ---------------------------------------------------------------------------


@router.get("/{datasource_id}/tables/{table_name}/preview")
async def preview_data(
    datasource_id: uuid.UUID,
    table_name: str,
    schema: str | None = Query(None),
    limit: int = Query(10, ge=1, le=1000),
    request: Request = ...,  # type: ignore[assignment]
    current_user: dict[str, Any] = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    """Preview sample rows from a table."""
    ds = await _get_datasource(datasource_id, db)
    connector = _build_connector(ds)

    start = time.monotonic()
    try:
        rows = connector.preview_data(table_name, schema=schema, limit=limit)
        elapsed_ms = int((time.monotonic() - start) * 1000)
    except Exception as exc:
        logger.exception("Error previewing data for %s.%s", datasource_id, table_name)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc))
    finally:
        try:
            connector.disconnect()
        except Exception:
            pass

    await AuditLogger.log(
        user_id=uuid.UUID(current_user["user_id"]),
        action="schema.preview_data",
        target_datasource_id=datasource_id,
        query_text=f"table={table_name}, schema={schema}, limit={limit}",
        response_time_ms=elapsed_ms,
        ip_address=_client_ip(request),
        db=db,
    )

    # Serialize values that may not be JSON-serializable (e.g. datetime, Decimal)
    sanitized: list[dict[str, Any]] = []
    for row in rows:
        sanitized.append({k: _safe_value(v) for k, v in row.items()})
    return sanitized


def _safe_value(v: Any) -> Any:
    """Convert non-JSON-serializable values to strings."""
    if v is None or isinstance(v, (str, int, float, bool)):
        return v
    return str(v)


# ---------------------------------------------------------------------------
# GET /{datasource_id}/functions
# ---------------------------------------------------------------------------


@router.get("/{datasource_id}/functions")
async def list_functions(
    datasource_id: uuid.UUID,
    schema: str | None = Query(None),
    request: Request = ...,  # type: ignore[assignment]
    current_user: dict[str, Any] = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    """List stored functions / procedures in a data source."""
    ds = await _get_datasource(datasource_id, db)
    connector = _build_connector(ds)

    start = time.monotonic()
    try:
        functions = connector.list_functions(schema=schema)
        elapsed_ms = int((time.monotonic() - start) * 1000)
        result = [asdict(f) for f in functions]
    except Exception as exc:
        logger.exception("Error listing functions for datasource %s", datasource_id)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc))
    finally:
        try:
            connector.disconnect()
        except Exception:
            pass

    await AuditLogger.log(
        user_id=uuid.UUID(current_user["user_id"]),
        action="schema.list_functions",
        target_datasource_id=datasource_id,
        query_text=f"schema={schema}" if schema else None,
        response_time_ms=elapsed_ms,
        ip_address=_client_ip(request),
        db=db,
    )
    return result


# ---------------------------------------------------------------------------
# GET /{datasource_id}/search
# ---------------------------------------------------------------------------


@router.get("/{datasource_id}/search")
async def search_schema(
    datasource_id: uuid.UUID,
    q: str = Query(..., min_length=1, description="Keyword to search tables and columns"),
    schema: str | None = Query(None),
    request: Request = ...,  # type: ignore[assignment]
    current_user: dict[str, Any] = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Search tables and columns by name keyword."""
    ds = await _get_datasource(datasource_id, db)
    connector = _build_connector(ds)

    start = time.monotonic()
    try:
        keyword = q.lower()

        # Search tables
        all_tables = connector.list_tables(schema=schema)
        matched_tables = [asdict(t) for t in all_tables if keyword in t.name.lower()]

        # Search columns across all tables
        matched_columns: list[dict[str, Any]] = []
        for table in all_tables:
            try:
                cols = connector.list_columns(table.name, schema=table.schema or schema)
                for col in cols:
                    if keyword in col.name.lower():
                        col_dict = asdict(col)
                        col_dict["table_name"] = table.name
                        col_dict["table_schema"] = table.schema
                        matched_columns.append(col_dict)
            except Exception:
                logger.debug("Skipping column search for table %s", table.name)

        elapsed_ms = int((time.monotonic() - start) * 1000)
    except Exception as exc:
        logger.exception("Error searching schema for datasource %s", datasource_id)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc))
    finally:
        try:
            connector.disconnect()
        except Exception:
            pass

    await AuditLogger.log(
        user_id=uuid.UUID(current_user["user_id"]),
        action="schema.search",
        target_datasource_id=datasource_id,
        query_text=q,
        response_time_ms=elapsed_ms,
        ip_address=_client_ip(request),
        db=db,
    )

    return {
        "query": q,
        "matched_tables": matched_tables,
        "matched_columns": matched_columns,
    }
