from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Optional

from sqlalchemy import ForeignKey, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class BomHeader(Base):
    """Bill of Materials header — synced from Tiptop ERP."""

    __tablename__ = "bom_headers"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    product_model: Mapped[str]
    version: Mapped[int] = mapped_column(default=1)
    effective_date: Mapped[datetime]
    status: Mapped[str] = mapped_column(default="active")  # active, obsolete
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())

    items: Mapped[list[BomItem]] = relationship(back_populates="bom_header", lazy="selectin")


class BomItem(Base):
    """Individual component line within a BOM."""

    __tablename__ = "bom_items"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    bom_header_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("bom_headers.id"))
    part_number: Mapped[str]
    part_name: Mapped[str]
    quantity_per: Mapped[float]
    unit: Mapped[str] = mapped_column(default="pcs")
    lead_time_days: Mapped[int] = mapped_column(default=0)
    is_phantom: Mapped[bool] = mapped_column(default=False)
    parent_item_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        ForeignKey("bom_items.id"), nullable=True
    )

    bom_header: Mapped[BomHeader] = relationship(back_populates="items")


class Ecn(Base):
    """Engineering Change Notice."""

    __tablename__ = "ecns"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    ecn_number: Mapped[str] = mapped_column(unique=True)
    bom_header_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("bom_headers.id"))
    description: Mapped[str]
    change_type: Mapped[str]  # add, remove, modify, substitute
    old_value: Mapped[Optional[str]]
    new_value: Mapped[Optional[str]]
    requested_by: Mapped[Optional[str]]
    approved_at: Mapped[Optional[datetime]]
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())


class InventoryRecord(Base):
    """Inventory snapshot — synced from Tiptop."""

    __tablename__ = "inventory_records"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    part_number: Mapped[str]
    warehouse: Mapped[str]
    quantity_on_hand: Mapped[float]
    quantity_in_transit: Mapped[float] = mapped_column(default=0)
    quantity_reserved: Mapped[float] = mapped_column(default=0)
    safety_stock: Mapped[float] = mapped_column(default=0)
    last_updated: Mapped[datetime] = mapped_column(server_default=func.now())


class DemandRecord(Base):
    """Demand record — orders and forecasts."""

    __tablename__ = "demand_records"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    product_model: Mapped[str]
    demand_type: Mapped[str]  # order, forecast
    quantity: Mapped[float]
    required_date: Mapped[date]
    source_ref: Mapped[Optional[str]]
    priority: Mapped[int] = mapped_column(default=5)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())


class MrpResult(Base):
    """MRP calculation result for one part in one period."""

    __tablename__ = "mrp_results"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    run_id: Mapped[uuid.UUID]
    part_number: Mapped[str]
    period_start: Mapped[date]
    period_end: Mapped[date]
    gross_requirement: Mapped[float] = mapped_column(default=0)
    scheduled_receipts: Mapped[float] = mapped_column(default=0)
    projected_on_hand: Mapped[float] = mapped_column(default=0)
    net_requirement: Mapped[float] = mapped_column(default=0)
    planned_order_release: Mapped[float] = mapped_column(default=0)
    planned_order_receipt: Mapped[float] = mapped_column(default=0)
    action_message: Mapped[Optional[str]]
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())


class WorkCenter(Base):
    """Work center for capacity requirements planning."""

    __tablename__ = "work_centers"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    name: Mapped[str]
    capacity_per_day: Mapped[float]
    efficiency: Mapped[float] = mapped_column(default=1.0)
    is_active: Mapped[bool] = mapped_column(default=True)


class MpsRecord(Base):
    """Master Production Schedule record."""

    __tablename__ = "mps_records"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    product_model: Mapped[str]
    period_start: Mapped[date]
    period_end: Mapped[date]
    planned_quantity: Mapped[float]
    confirmed_quantity: Mapped[float] = mapped_column(default=0)
    combo_id: Mapped[Optional[uuid.UUID]]
    status: Mapped[str] = mapped_column(default="planned")
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())


class CrpResult(Base):
    """Capacity Requirements Planning result."""

    __tablename__ = "crp_results"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    run_id: Mapped[uuid.UUID]
    work_center_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("work_centers.id"))
    period_start: Mapped[date]
    period_end: Mapped[date]
    required_capacity: Mapped[float]
    available_capacity: Mapped[float]
    utilization_pct: Mapped[float]
    is_bottleneck: Mapped[bool] = mapped_column(default=False)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
