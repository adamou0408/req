from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Optional

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    JSON,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.core.models import TimestampMixin


class EtlPipeline(TimestampMixin, Base):
    __tablename__ = "etl_pipelines"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    source_datasource_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("data_sources.id"), nullable=False
    )
    source_table: Mapped[str] = mapped_column(String(255), nullable=False)
    target_table: Mapped[str] = mapped_column(String(255), nullable=False)
    transform_config: Mapped[Optional[dict[str, Any]]] = mapped_column(
        JSON, nullable=True
    )
    cron_expression: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    last_run_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_run_status: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    last_run_duration_ms: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    last_run_rows: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    created_by: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=False
    )


class BiReport(TimestampMixin, Base):
    __tablename__ = "bi_reports"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    source_table: Mapped[str] = mapped_column(String(255), nullable=False)
    chart_type: Mapped[str] = mapped_column(String(50), nullable=False)
    config: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON, nullable=True)
    created_by: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=False
    )
    is_shared: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    share_approved: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    share_approved_by: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )


class Dashboard(TimestampMixin, Base):
    __tablename__ = "dashboards"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    layout: Mapped[Optional[list[dict[str, Any]]]] = mapped_column(JSON, nullable=True)
    refresh_interval_seconds: Mapped[Optional[int]] = mapped_column(
        Integer, nullable=True
    )
    is_shared: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    share_approved: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    share_approved_by: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )
    created_by: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=False
    )
