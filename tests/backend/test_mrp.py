from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any

import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.mrp.bom_service import BomService
from app.mrp.crp_service import CrpService
from app.mrp.models import (
    BomHeader,
    BomItem,
    CrpResult,
    DemandRecord,
    Ecn,
    InventoryRecord,
    MpsRecord,
    MrpResult,
    WorkCenter,
)
from app.mrp.mps_service import MpsService
from app.mrp.mrp_runner import MrpRunner


# ---------------------------------------------------------------------------
# Fixtures — seed data helpers
# ---------------------------------------------------------------------------


async def _create_single_level_bom(db: AsyncSession) -> BomHeader:
    """Create a single-level BOM: SSD-001 with 3 components."""
    bom = BomHeader(
        product_model="SSD-001",
        version=1,
        effective_date=datetime.now(timezone.utc),
        status="active",
    )
    db.add(bom)
    await db.flush()

    items = [
        BomItem(
            bom_header_id=bom.id,
            part_number="CTRL-A01",
            part_name="Controller A01",
            quantity_per=1.0,
            lead_time_days=14,
        ),
        BomItem(
            bom_header_id=bom.id,
            part_number="NAND-B01",
            part_name="NAND Flash B01",
            quantity_per=4.0,
            lead_time_days=21,
        ),
        BomItem(
            bom_header_id=bom.id,
            part_number="PCB-C01",
            part_name="PCB Board C01",
            quantity_per=1.0,
            lead_time_days=7,
        ),
    ]
    db.add_all(items)
    await db.flush()
    await db.refresh(bom)
    return bom


async def _create_multi_level_bom(db: AsyncSession) -> BomHeader:
    """Create a multi-level BOM: SSD-002 → sub-assembly → components."""
    bom = BomHeader(
        product_model="SSD-002",
        version=1,
        effective_date=datetime.now(timezone.utc),
        status="active",
    )
    db.add(bom)
    await db.flush()

    # Level 1: sub-assembly (2 per parent)
    sub_assy = BomItem(
        bom_header_id=bom.id,
        part_number="SUB-ASM-01",
        part_name="Sub-Assembly 01",
        quantity_per=2.0,
        lead_time_days=3,
        parent_item_id=None,
    )
    db.add(sub_assy)
    await db.flush()

    # Level 1: direct component
    direct = BomItem(
        bom_header_id=bom.id,
        part_number="CASE-01",
        part_name="Enclosure Case",
        quantity_per=1.0,
        lead_time_days=5,
        parent_item_id=None,
    )
    db.add(direct)
    await db.flush()

    # Level 2: children of sub-assembly
    child_a = BomItem(
        bom_header_id=bom.id,
        part_number="CHIP-X1",
        part_name="Chip X1",
        quantity_per=3.0,
        lead_time_days=10,
        parent_item_id=sub_assy.id,
    )
    child_b = BomItem(
        bom_header_id=bom.id,
        part_number="CAP-Y1",
        part_name="Capacitor Y1",
        quantity_per=8.0,
        lead_time_days=5,
        parent_item_id=sub_assy.id,
    )
    db.add_all([child_a, child_b])
    await db.flush()
    await db.refresh(bom)
    return bom


async def _create_phantom_bom(db: AsyncSession) -> BomHeader:
    """Create a BOM with a phantom sub-assembly."""
    bom = BomHeader(
        product_model="SSD-003",
        version=1,
        effective_date=datetime.now(timezone.utc),
        status="active",
    )
    db.add(bom)
    await db.flush()

    # Phantom sub-assembly
    phantom = BomItem(
        bom_header_id=bom.id,
        part_number="PHANTOM-01",
        part_name="Phantom Group",
        quantity_per=1.0,
        is_phantom=True,
        parent_item_id=None,
    )
    db.add(phantom)
    await db.flush()

    # Children of phantom
    child = BomItem(
        bom_header_id=bom.id,
        part_number="REAL-PART-01",
        part_name="Real Part 01",
        quantity_per=5.0,
        lead_time_days=7,
        parent_item_id=phantom.id,
    )
    db.add(child)
    await db.flush()
    await db.refresh(bom)
    return bom


async def _seed_inventory(
    db: AsyncSession, part_number: str, on_hand: float,
    in_transit: float = 0, safety_stock: float = 0,
) -> InventoryRecord:
    inv = InventoryRecord(
        part_number=part_number,
        warehouse="MAIN",
        quantity_on_hand=on_hand,
        quantity_in_transit=in_transit,
        safety_stock=safety_stock,
    )
    db.add(inv)
    await db.flush()
    return inv


async def _seed_demand(
    db: AsyncSession, product_model: str, quantity: float,
    required_date: date, demand_type: str = "order",
) -> DemandRecord:
    dr = DemandRecord(
        product_model=product_model,
        demand_type=demand_type,
        quantity=quantity,
        required_date=required_date,
    )
    db.add(dr)
    await db.flush()
    return dr


async def _seed_work_center(
    db: AsyncSession, name: str, capacity: float, efficiency: float = 1.0,
) -> WorkCenter:
    wc = WorkCenter(
        name=name,
        capacity_per_day=capacity,
        efficiency=efficiency,
    )
    db.add(wc)
    await db.flush()
    return wc


# ===================================================================
# BOM Tests
# ===================================================================


@pytest.mark.asyncio
async def test_expand_bom_single_level(db_session: AsyncSession) -> None:
    """Single-level BOM with 3 components expands with correct quantities."""
    await _create_single_level_bom(db_session)
    await db_session.commit()

    flat = await BomService.expand_bom("SSD-001", quantity=10, db=db_session)
    assert len(flat) == 3
    by_part = {item["part_number"]: item for item in flat}
    assert by_part["CTRL-A01"]["total_quantity"] == pytest.approx(10.0)
    assert by_part["NAND-B01"]["total_quantity"] == pytest.approx(40.0)
    assert by_part["PCB-C01"]["total_quantity"] == pytest.approx(10.0)
    # All at level 1
    for item in flat:
        assert item["level"] == 1


@pytest.mark.asyncio
async def test_expand_bom_multi_level(db_session: AsyncSession) -> None:
    """Multi-level BOM: product -> sub-assembly -> components, correct totals."""
    await _create_multi_level_bom(db_session)
    await db_session.commit()

    flat = await BomService.expand_bom("SSD-002", quantity=1, db=db_session)
    by_part = {item["part_number"]: item for item in flat}

    # SUB-ASM-01: 2 per unit, level 1
    assert by_part["SUB-ASM-01"]["total_quantity"] == pytest.approx(2.0)
    assert by_part["SUB-ASM-01"]["level"] == 1
    # CASE-01: 1 per unit, level 1
    assert by_part["CASE-01"]["total_quantity"] == pytest.approx(1.0)
    # CHIP-X1: 3 per sub-assy * 2 sub-assy = 6, level 2
    assert by_part["CHIP-X1"]["total_quantity"] == pytest.approx(6.0)
    assert by_part["CHIP-X1"]["level"] == 2
    # CAP-Y1: 8 per sub-assy * 2 sub-assy = 16, level 2
    assert by_part["CAP-Y1"]["total_quantity"] == pytest.approx(16.0)


@pytest.mark.asyncio
async def test_expand_bom_phantom(db_session: AsyncSession) -> None:
    """Phantom items pass through — only real components in output."""
    await _create_phantom_bom(db_session)
    await db_session.commit()

    flat = await BomService.expand_bom("SSD-003", quantity=2, db=db_session)
    part_numbers = [item["part_number"] for item in flat]
    assert "PHANTOM-01" not in part_numbers
    assert "REAL-PART-01" in part_numbers
    by_part = {item["part_number"]: item for item in flat}
    # 1 (phantom qty_per) * 5 (real part qty_per) * 2 (requested qty) = 10
    assert by_part["REAL-PART-01"]["total_quantity"] == pytest.approx(10.0)


@pytest.mark.asyncio
async def test_bom_search(db_session: AsyncSession) -> None:
    """Search by part_number returns matching BOMs."""
    await _create_single_level_bom(db_session)
    await db_session.commit()

    results = await BomService.search_bom(part_number="CTRL-A01", db=db_session)
    assert len(results) >= 1
    assert results[0].product_model == "SSD-001"


@pytest.mark.asyncio
async def test_ecn_history(db_session: AsyncSession) -> None:
    """Returns ECNs for a product model."""
    bom = await _create_single_level_bom(db_session)
    ecn = Ecn(
        ecn_number="ECN-2026-001",
        bom_header_id=bom.id,
        description="Change NAND-B01 to NAND-B02",
        change_type="substitute",
        old_value="NAND-B01",
        new_value="NAND-B02",
        requested_by="engineer@phison.com",
    )
    db_session.add(ecn)
    await db_session.commit()

    ecns = await BomService.get_ecn_history(product_model="SSD-001", db=db_session)
    assert len(ecns) == 1
    assert ecns[0].ecn_number == "ECN-2026-001"
    assert ecns[0].change_type == "substitute"


# ===================================================================
# MRP Runner Tests
# ===================================================================


@pytest.mark.asyncio
async def test_mrp_basic(db_session: AsyncSession) -> None:
    """1 product, 1 component, demand=100, on_hand=30 -> net_req=70."""
    await _create_single_level_bom(db_session)
    today = date.today()
    await _seed_demand(db_session, "SSD-001", 100, today)
    # CTRL-A01: qty_per=1, so gross=100. on_hand=30, net=70
    await _seed_inventory(db_session, "CTRL-A01", on_hand=30)
    await _seed_inventory(db_session, "NAND-B01", on_hand=1000)
    await _seed_inventory(db_session, "PCB-C01", on_hand=1000)
    await db_session.commit()

    run_id = await MrpRunner.run_mrp(
        product_models=["SSD-001"], periods=1, period_length_days=7, db=db_session
    )
    await db_session.commit()

    results = await MrpRunner.get_results(run_id, db_session)
    ctrl_results = [r for r in results if r.part_number == "CTRL-A01"]
    assert len(ctrl_results) == 1
    assert ctrl_results[0].gross_requirement == pytest.approx(100.0)
    assert ctrl_results[0].net_requirement == pytest.approx(70.0)


@pytest.mark.asyncio
async def test_mrp_with_safety_stock(db_session: AsyncSession) -> None:
    """demand=100, on_hand=50, safety_stock=20 -> net_req=70."""
    await _create_single_level_bom(db_session)
    today = date.today()
    await _seed_demand(db_session, "SSD-001", 100, today)
    await _seed_inventory(db_session, "CTRL-A01", on_hand=50, safety_stock=20)
    await _seed_inventory(db_session, "NAND-B01", on_hand=10000)
    await _seed_inventory(db_session, "PCB-C01", on_hand=10000)
    await db_session.commit()

    run_id = await MrpRunner.run_mrp(
        product_models=["SSD-001"], periods=1, period_length_days=7, db=db_session
    )
    await db_session.commit()

    results = await MrpRunner.get_results(run_id, db_session)
    ctrl_results = [r for r in results if r.part_number == "CTRL-A01"]
    assert len(ctrl_results) == 1
    assert ctrl_results[0].net_requirement == pytest.approx(70.0)


@pytest.mark.asyncio
async def test_mrp_multi_period(db_session: AsyncSession) -> None:
    """Demand across 3 periods, verify projected on-hand carries forward."""
    await _create_single_level_bom(db_session)
    today = date.today()
    # Demand in each of 3 weekly periods
    await _seed_demand(db_session, "SSD-001", 50, today)
    await _seed_demand(db_session, "SSD-001", 30, today + timedelta(days=7))
    await _seed_demand(db_session, "SSD-001", 20, today + timedelta(days=14))
    await _seed_inventory(db_session, "CTRL-A01", on_hand=40)
    await _seed_inventory(db_session, "NAND-B01", on_hand=100000)
    await _seed_inventory(db_session, "PCB-C01", on_hand=100000)
    await db_session.commit()

    run_id = await MrpRunner.run_mrp(
        product_models=["SSD-001"], periods=3, period_length_days=7, db=db_session
    )
    await db_session.commit()

    results = await MrpRunner.get_results(run_id, db_session)
    ctrl_results = sorted(
        [r for r in results if r.part_number == "CTRL-A01"],
        key=lambda r: r.period_start,
    )
    assert len(ctrl_results) == 3
    # Period 1: gross=50, on_hand=40, net=10
    assert ctrl_results[0].gross_requirement == pytest.approx(50.0)
    assert ctrl_results[0].net_requirement == pytest.approx(10.0)
    # Period 2 and 3 should have results (on_hand should carry forward)
    assert ctrl_results[1].gross_requirement == pytest.approx(30.0)
    assert ctrl_results[2].gross_requirement == pytest.approx(20.0)


@pytest.mark.asyncio
async def test_shortage_alerts(db_session: AsyncSession) -> None:
    """Parts with net_requirement > 0 appear in shortage alerts."""
    await _create_single_level_bom(db_session)
    today = date.today()
    await _seed_demand(db_session, "SSD-001", 100, today)
    await _seed_inventory(db_session, "CTRL-A01", on_hand=30)
    await _seed_inventory(db_session, "NAND-B01", on_hand=10)  # Need 400, have 10
    await _seed_inventory(db_session, "PCB-C01", on_hand=10000)
    await db_session.commit()

    run_id = await MrpRunner.run_mrp(
        product_models=["SSD-001"], periods=1, period_length_days=7, db=db_session
    )
    await db_session.commit()

    alerts = await MrpRunner.get_shortage_alerts(run_id=run_id, db=db_session)
    shortage_parts = {a.part_number for a in alerts}
    assert "CTRL-A01" in shortage_parts
    assert "NAND-B01" in shortage_parts


@pytest.mark.asyncio
async def test_action_messages(db_session: AsyncSession) -> None:
    """Verify expedite/new-order messages generated correctly."""
    await _create_single_level_bom(db_session)
    today = date.today()
    await _seed_demand(db_session, "SSD-001", 100, today)
    await _seed_inventory(db_session, "CTRL-A01", on_hand=10)  # lead_time=14, period=0 -> expedite
    await _seed_inventory(db_session, "NAND-B01", on_hand=10)
    await _seed_inventory(db_session, "PCB-C01", on_hand=10000)
    await db_session.commit()

    run_id = await MrpRunner.run_mrp(
        product_models=["SSD-001"], periods=1, period_length_days=7, db=db_session
    )
    await db_session.commit()

    actions = await MrpRunner.get_action_messages(run_id, db_session)
    assert len(actions) > 0
    action_types = {a.action_message for a in actions}
    # CTRL-A01 has lead_time=14, period_idx=0, net_req > 0 -> expedite
    assert "expedite" in action_types


# ===================================================================
# MPS Tests
# ===================================================================


@pytest.mark.asyncio
async def test_generate_mps(db_session: AsyncSession) -> None:
    """Given demand, MPS distributes production accordingly."""
    today = date.today()
    await _seed_demand(db_session, "SSD-001", 100, today)
    await _seed_demand(db_session, "SSD-001", 50, today + timedelta(days=7))
    await db_session.commit()

    records = await MpsService.generate_mps(planning_horizon_weeks=2, db=db_session)
    await db_session.commit()

    assert len(records) >= 1
    # At least some records for SSD-001
    ssd_records = [r for r in records if "SSD-001" in r.product_model]
    assert len(ssd_records) >= 1


@pytest.mark.asyncio
async def test_confirm_schedule(db_session: AsyncSession) -> None:
    """Confirming a schedule changes status to confirmed."""
    today = date.today()
    await _seed_demand(db_session, "SSD-001", 100, today)
    await db_session.commit()

    records = await MpsService.generate_mps(planning_horizon_weeks=1, db=db_session)
    await db_session.commit()

    assert len(records) >= 1
    mps_id = records[0].id
    updated = await MpsService.confirm_schedule(mps_id, 95.0, db_session)
    await db_session.commit()

    assert updated.status == "confirmed"
    assert updated.confirmed_quantity == pytest.approx(95.0)


# ===================================================================
# CRP Tests
# ===================================================================


@pytest.mark.asyncio
async def test_crp_basic(db_session: AsyncSession) -> None:
    """MPS with capacity -> correct utilization calculation."""
    today = date.today()
    period_end = today + timedelta(days=6)

    wc = await _seed_work_center(db_session, "SMT Line 1", capacity=100.0, efficiency=1.0)
    mps = MpsRecord(
        product_model="SSD-001",
        period_start=today,
        period_end=period_end,
        planned_quantity=200.0,
        status="planned",
    )
    db_session.add(mps)
    await db_session.flush()
    await db_session.commit()

    run_id = await CrpService.run_crp([mps], db_session)
    await db_session.commit()

    results = await CrpService.get_results(run_id, db_session)
    assert len(results) == 1
    assert results[0].available_capacity > 0
    assert results[0].utilization_pct > 0


@pytest.mark.asyncio
async def test_bottleneck_detection(db_session: AsyncSession) -> None:
    """Work center over 90% is flagged as bottleneck."""
    today = date.today()
    period_end = today + timedelta(days=6)

    # Low capacity work center
    wc = await _seed_work_center(db_session, "Bottleneck WC", capacity=10.0, efficiency=1.0)
    mps = MpsRecord(
        product_model="SSD-001",
        period_start=today,
        period_end=period_end,
        planned_quantity=500.0,  # Much more than capacity
        status="planned",
    )
    db_session.add(mps)
    await db_session.flush()
    await db_session.commit()

    run_id = await CrpService.run_crp([mps], db_session)
    await db_session.commit()

    bottlenecks = await CrpService.get_bottlenecks(run_id=run_id, db=db_session)
    assert len(bottlenecks) >= 1
    assert bottlenecks[0].is_bottleneck is True
    assert bottlenecks[0].utilization_pct > 90.0


# ===================================================================
# API Endpoint Tests
# ===================================================================


@pytest.mark.asyncio
async def test_mrp_run_endpoint(async_client: AsyncClient, db_session: AsyncSession) -> None:
    """POST /api/mrp/run returns run_id."""
    await _create_single_level_bom(db_session)
    today = date.today()
    await _seed_demand(db_session, "SSD-001", 100, today)
    await _seed_inventory(db_session, "CTRL-A01", on_hand=30)
    await _seed_inventory(db_session, "NAND-B01", on_hand=1000)
    await _seed_inventory(db_session, "PCB-C01", on_hand=1000)
    await db_session.commit()

    response = await async_client.post(
        "/api/mrp/run",
        json={"product_models": ["SSD-001"], "periods": 1, "period_length_days": 7},
    )
    assert response.status_code == 200
    data = response.json()
    assert "run_id" in data
    # Validate it's a valid UUID
    uuid.UUID(data["run_id"])


@pytest.mark.asyncio
async def test_mps_generate_endpoint(async_client: AsyncClient, db_session: AsyncSession) -> None:
    """POST /api/mrp/mps/generate returns records."""
    today = date.today()
    await _seed_demand(db_session, "SSD-001", 100, today)
    await db_session.commit()

    response = await async_client.post(
        "/api/mrp/mps/generate",
        json={"planning_horizon_weeks": 2},
    )
    assert response.status_code == 200
    data = response.json()
    assert isinstance(data, list)


@pytest.mark.asyncio
async def test_bom_expand_endpoint(async_client: AsyncClient, db_session: AsyncSession) -> None:
    """GET /api/mrp/bom/{model}/expand returns flat list."""
    await _create_single_level_bom(db_session)
    await db_session.commit()

    response = await async_client.get("/api/mrp/bom/SSD-001/expand?quantity=5")
    assert response.status_code == 200
    data = response.json()
    assert isinstance(data, list)
    assert len(data) == 3
    by_part = {item["part_number"]: item for item in data}
    assert by_part["CTRL-A01"]["total_quantity"] == pytest.approx(5.0)
    assert by_part["NAND-B01"]["total_quantity"] == pytest.approx(20.0)


@pytest.mark.asyncio
async def test_shortages_endpoint(async_client: AsyncClient, db_session: AsyncSession) -> None:
    """GET /api/mrp/shortages returns list of shortages."""
    await _create_single_level_bom(db_session)
    today = date.today()
    await _seed_demand(db_session, "SSD-001", 100, today)
    await _seed_inventory(db_session, "CTRL-A01", on_hand=10)
    await _seed_inventory(db_session, "NAND-B01", on_hand=10)
    await _seed_inventory(db_session, "PCB-C01", on_hand=10)
    await db_session.commit()

    # First run MRP
    run_resp = await async_client.post(
        "/api/mrp/run",
        json={"product_models": ["SSD-001"], "periods": 1, "period_length_days": 7},
    )
    assert run_resp.status_code == 200
    run_id = run_resp.json()["run_id"]

    response = await async_client.get(f"/api/mrp/shortages?run_id={run_id}")
    assert response.status_code == 200
    data = response.json()
    assert isinstance(data, list)
    assert len(data) > 0
    # All returned items should have net_requirement > 0
    for item in data:
        assert item["net_requirement"] > 0
