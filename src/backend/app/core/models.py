from __future__ import annotations

import enum
import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any, Optional

from sqlalchemy import (
    BigInteger,
    DateTime,
    Enum,
    ForeignKey,
    Integer,
    JSON,
    LargeBinary,
    Numeric,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------


class UserRole(str, enum.Enum):
    admin = "admin"
    engineer = "engineer"
    viewer = "viewer"


class SyncMode(str, enum.Enum):
    cdc = "cdc"
    batch = "batch"


class ComboStatus(str, enum.Enum):
    draft = "draft"
    pending_approval = "pending_approval"
    active = "active"
    archived = "archived"


# ---------------------------------------------------------------------------
# Mixin for common timestamp columns
# ---------------------------------------------------------------------------


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


class User(TimestampMixin, Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    ad_username: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    display_name: Mapped[str] = mapped_column(String(255), nullable=False)
    department: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    role: Mapped[UserRole] = mapped_column(
        Enum(UserRole, name="user_role"), default=UserRole.viewer, nullable=False
    )
    is_active: Mapped[bool] = mapped_column(default=True, nullable=False)
    last_login_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    # Relationships
    data_sources: Mapped[list[DataSource]] = relationship(
        back_populates="creator", lazy="selectin"
    )


class DataSource(TimestampMixin, Base):
    __tablename__ = "data_sources"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    db_type: Mapped[str] = mapped_column(String(50), nullable=False)
    host: Mapped[str] = mapped_column(String(255), nullable=False)
    port: Mapped[int] = mapped_column(Integer, nullable=False)
    database_name: Mapped[str] = mapped_column(String(255), nullable=False)
    username: Mapped[str] = mapped_column(String(255), nullable=False)
    encrypted_password: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    is_active: Mapped[bool] = mapped_column(default=True, nullable=False)
    max_connections: Mapped[int] = mapped_column(Integer, default=5, nullable=False)
    rate_limit_per_min: Mapped[int] = mapped_column(Integer, default=60, nullable=False)

    created_by: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=False
    )

    # Relationships
    creator: Mapped[User] = relationship(back_populates="data_sources", lazy="selectin")
    sync_configs: Mapped[list[SyncConfig]] = relationship(
        back_populates="data_source", lazy="selectin"
    )


class SyncConfig(TimestampMixin, Base):
    __tablename__ = "sync_configs"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    data_source_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("data_sources.id"), nullable=False
    )
    table_name: Mapped[str] = mapped_column(String(255), nullable=False)
    sync_mode: Mapped[SyncMode] = mapped_column(
        Enum(SyncMode, name="sync_mode"), nullable=False
    )
    cron_expression: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    last_sync_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_sync_status: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    is_active: Mapped[bool] = mapped_column(default=True, nullable=False)

    # Relationships
    data_source: Mapped[DataSource] = relationship(
        back_populates="sync_configs", lazy="selectin"
    )


class FieldMapping(Base):
    __tablename__ = "field_mappings"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    source_datasource_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("data_sources.id"), nullable=False
    )
    source_table: Mapped[str] = mapped_column(String(255), nullable=False)
    source_field: Mapped[str] = mapped_column(String(255), nullable=False)
    target_field: Mapped[str] = mapped_column(String(255), nullable=False)
    transform_rule: Mapped[Optional[dict[str, Any]]] = mapped_column(
        JSON, nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class ProductCombo(TimestampMixin, Base):
    __tablename__ = "product_combos"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    controller_model: Mapped[str] = mapped_column(String(255), nullable=False)
    flash_model: Mapped[str] = mapped_column(String(255), nullable=False)
    target_ratio: Mapped[Decimal] = mapped_column(Numeric(10, 4), nullable=False)
    status: Mapped[ComboStatus] = mapped_column(
        Enum(ComboStatus, name="combo_status"),
        default=ComboStatus.draft,
        nullable=False,
    )
    approved_by: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )
    approved_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    published_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_by: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=False
    )


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id: Mapped[int] = mapped_column(
        BigInteger, primary_key=True, autoincrement=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=False
    )
    action: Mapped[str] = mapped_column(String(255), nullable=False)
    target_datasource_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("data_sources.id"), nullable=True
    )
    query_text: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    response_time_ms: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    ip_address: Mapped[Optional[str]] = mapped_column(String(45), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
