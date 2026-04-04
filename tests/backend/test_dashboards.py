from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone

import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.models import AuditLog, DataSource, ProductCombo, SyncConfig, SyncMode
from app.dashboards.pm_dashboard import PMDashboard
from app.dashboards.quality_dashboard import QualityDashboard, TestResult
from app.dashboards.mis_controls import MISControls
from app.dashboards.sync_dashboard import SyncDashboard
from app.mrp.models import (
    BomHeader,
    CrpResult,
    MpsRecord,
    MrpResult,
    WorkCenter,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _user_id() -> uuid.UUID:
    return uuid.uuid4()


async def _seed_mps(db: AsyncSession, model: str = "SSD-X100", status: str = "planned", combo_id=None):
    rec = MpsRecord(
        product_model=model,
        period_start=date.today(),
        period_end=date.today() + timedelta(days=7),
        planned_quantity=1000,
        confirmed_quantity=0,
        status=status,
        combo_id=combo_id,
    )
    db.add(rec)
    await db.flush()
    return rec


async def _seed_combo(db: AsyncSession, controller: str = "SSD-X100"):
    uid = _user_id()
    combo = ProductCombo(
        controller_model=controller,
        flash_model="NAND-A1",
        target_ratio=1.0,
        status="active",
        created_by=uid,
    )
    db.add(combo)
    await db.flush()
    return combo


async def _seed_work_center(db: AsyncSession, name: str = "SMT-Line-1"):
    wc = WorkCenter(name=name, capacity_per_day=100, efficiency=1.0, is_active=True)
    db.add(wc)
    await db.flush()
    return wc


async def _seed_crp_bottleneck(db: AsyncSession, wc_id: uuid.UUID, util_pct: float = 95.0):
    crp = CrpResult(
        run_id=uuid.uuid4(),
        work_center_id=wc_id,
        period_start=date.today(),
        period_end=date.today() + timedelta(days=7),
        required_capacity=950,
        available_capacity=1000,
        utilization_pct=util_pct,
        is_bottleneck=util_pct > 90,
    )
    db.add(crp)
    await db.flush()
    return crp


async def _seed_mrp_shortage(db: AsyncSession):
    r = MrpResult(
        run_id=uuid.uuid4(),
        part_number="CTRL-001",
        period_start=date.today(),
        period_end=date.today() + timedelta(days=7),
        gross_requirement=500,
        net_requirement=200,
        planned_order_release=200,
    )
    db.add(r)
    await db.flush()
    return r


async def _seed_test_result(
    db: AsyncSession,
    product_model: str = "SSD-X100",
    batch_id: str = "BATCH-001",
    fw_version: str = "v1.0",
    bom_version: int = 1,
    yield_rate: float = 95.0,
    test_type: str = "functional",
    test_date: date | None = None,
    total_units: int = 100,
):
    passed = int(total_units * yield_rate / 100)
    failed = total_units - passed
    tr = TestResult(
        batch_id=batch_id,
        product_model=product_model,
        fw_version=fw_version,
        bom_version=bom_version,
        test_type=test_type,
        total_units=total_units,
        passed_units=passed,
        failed_units=failed,
        yield_rate=yield_rate,
        test_date=test_date or date.today(),
    )
    db.add(tr)
    await db.flush()
    return tr


async def _seed_datasource(db: AsyncSession, name: str = "ERP-DB"):
    uid = _user_id()
    # Create a minimal user first
    from app.core.models import User
    user = User(
        id=uid,
        ad_username=f"user_{uuid.uuid4().hex[:8]}",
        display_name="Test User",
        role="admin",
    )
    db.add(user)
    await db.flush()

    ds = DataSource(
        name=name,
        db_type="postgresql",
        host="localhost",
        port=5432,
        database_name="testdb",
        username="test",
        encrypted_password=b"encrypted",
        is_active=True,
        rate_limit_per_min=60,
        created_by=uid,
    )
    db.add(ds)
    await db.flush()
    return ds, uid


async def _seed_sync_config(db: AsyncSession, ds_id: uuid.UUID, mode: str = "cdc", is_active: bool = True):
    sc = SyncConfig(
        data_source_id=ds_id,
        table_name=f"table_{uuid.uuid4().hex[:6]}",
        sync_mode=mode,
        is_active=is_active,
        last_sync_at=datetime.now(timezone.utc) - timedelta(seconds=60),
        last_sync_status="success",
    )
    db.add(sc)
    await db.flush()
    return sc


async def _seed_audit_log(db: AsyncSession, user_id: uuid.UUID, ds_id: uuid.UUID | None = None):
    log = AuditLog(
        user_id=user_id,
        action="query.execute",
        target_datasource_id=ds_id,
        response_time_ms=150,
    )
    db.add(log)
    await db.flush()
    return log


# ===========================================================================
# PM Dashboard Tests
# ===========================================================================


@pytest.mark.asyncio
async def test_project_overview_empty(db_session: AsyncSession):
    result = await PMDashboard.get_project_overview(db_session)
    assert result == []


@pytest.mark.asyncio
async def test_project_overview_with_data(db_session: AsyncSession):
    await _seed_combo(db_session, controller="SSD-X100")
    await _seed_mps(db_session, model="SSD-X100", status="confirmed")
    result = await PMDashboard.get_project_overview(db_session)
    assert len(result) == 1
    proj = result[0]
    assert proj["product_model"] == "SSD-X100"
    assert proj["overall_health"] in ("green", "yellow", "red")
    assert proj["combo_info"] is not None
    assert proj["combo_info"]["controller"] == "SSD-X100"


@pytest.mark.asyncio
async def test_kpi_summary(db_session: AsyncSession):
    await _seed_mps(db_session, status="confirmed")
    result = await PMDashboard.get_kpi_summary(db_session)
    assert "total_products" in result
    assert "active_mps_count" in result
    assert "avg_yield" in result
    assert "bottleneck_count" in result
    assert "on_track_pct" in result
    assert "at_risk_pct" in result
    assert "delayed_pct" in result
    assert result["total_products"] == 1
    assert result["active_mps_count"] == 1


@pytest.mark.asyncio
async def test_alerts_combined(db_session: AsyncSession):
    await _seed_mrp_shortage(db_session)
    wc = await _seed_work_center(db_session)
    await _seed_crp_bottleneck(db_session, wc.id, util_pct=95.0)
    result = await PMDashboard.get_alerts(db_session)
    types = {a["type"] for a in result}
    assert "mrp_shortage" in types
    assert "crp_bottleneck" in types


@pytest.mark.asyncio
async def test_pm_overview_endpoint(async_client: AsyncClient):
    resp = await async_client.get("/api/dashboards/pm/overview")
    assert resp.status_code == 200


# ===========================================================================
# Quality Dashboard Tests
# ===========================================================================


@pytest.mark.asyncio
async def test_yield_summary(db_session: AsyncSession):
    await _seed_test_result(db_session, yield_rate=90.0, batch_id="B1")
    await _seed_test_result(db_session, yield_rate=80.0, batch_id="B2")
    await _seed_test_result(db_session, yield_rate=100.0, batch_id="B3")
    result = await QualityDashboard.get_yield_summary(db=db_session)
    assert result["total_batches"] == 3
    assert result["min_yield"] == 80.0
    assert result["max_yield"] == 100.0
    assert 89.0 <= result["avg_yield"] <= 91.0  # ~90


@pytest.mark.asyncio
async def test_yield_trend_daily(db_session: AsyncSession):
    d1 = date.today() - timedelta(days=2)
    d2 = date.today() - timedelta(days=1)
    d3 = date.today()
    await _seed_test_result(db_session, batch_id="B1", test_date=d1, yield_rate=90.0)
    await _seed_test_result(db_session, batch_id="B2", test_date=d2, yield_rate=92.0)
    await _seed_test_result(db_session, batch_id="B3", test_date=d3, yield_rate=95.0)
    result = await QualityDashboard.get_yield_trend(product_model="SSD-X100", db=db_session)
    assert len(result) == 3
    assert result[0]["period"] == d1.isoformat()
    assert result[2]["period"] == d3.isoformat()


@pytest.mark.asyncio
async def test_compare_fw_versions(db_session: AsyncSession):
    await _seed_test_result(db_session, fw_version="v1.0", yield_rate=90.0, batch_id="B1")
    await _seed_test_result(db_session, fw_version="v1.0", yield_rate=88.0, batch_id="B2")
    await _seed_test_result(db_session, fw_version="v2.0", yield_rate=95.0, batch_id="B3")
    await _seed_test_result(db_session, fw_version="v2.0", yield_rate=97.0, batch_id="B4")
    result = await QualityDashboard.compare_fw_versions(
        product_model="SSD-X100", version_a="v1.0", version_b="v2.0", db=db_session
    )
    assert result["version_a"]["yield"] < result["version_b"]["yield"]
    assert result["diff"]["improved"] is True
    assert result["diff"]["yield_change"] > 0


@pytest.mark.asyncio
async def test_trace_defect(db_session: AsyncSession):
    await _seed_test_result(db_session, batch_id="TRACE-001", bom_version=1)
    result = await QualityDashboard.trace_defect(batch_id="TRACE-001", db=db_session)
    assert result["batch_id"] == "TRACE-001"
    assert result["product_model"] == "SSD-X100"
    assert len(result["test_results"]) == 1


@pytest.mark.asyncio
async def test_quality_alerts_low_yield(db_session: AsyncSession):
    await _seed_test_result(db_session, yield_rate=85.0, batch_id="LOW-1")
    await _seed_test_result(db_session, yield_rate=75.0, batch_id="LOW-2")
    result = await QualityDashboard.get_quality_alerts(db=db_session)
    assert len(result) >= 2
    types = {a["type"] for a in result}
    assert "low_yield" in types
    # 75% should be critical
    severities = {a["severity"] for a in result if a["type"] == "low_yield"}
    assert "critical" in severities


@pytest.mark.asyncio
async def test_quality_endpoint(async_client: AsyncClient):
    resp = await async_client.get("/api/dashboards/quality/yield-summary")
    assert resp.status_code == 200


# ===========================================================================
# MIS Controls Tests
# ===========================================================================


@pytest.mark.asyncio
async def test_connection_overview(db_session: AsyncSession):
    ds, uid = await _seed_datasource(db_session)
    await _seed_audit_log(db_session, user_id=uid, ds_id=ds.id)
    result = await MISControls.get_connection_overview(db_session)
    assert len(result) >= 1
    found = [r for r in result if r["id"] == str(ds.id)]
    assert len(found) == 1
    assert found[0]["current_load"] >= 1


@pytest.mark.asyncio
async def test_set_rate_limit(db_session: AsyncSession):
    ds, _ = await _seed_datasource(db_session)
    result = await MISControls.set_rate_limit(str(ds.id), 120, db_session)
    assert result["rate_limit_per_min"] == 120
    assert result["status"] == "updated"


@pytest.mark.asyncio
async def test_toggle_connection(db_session: AsyncSession):
    ds, _ = await _seed_datasource(db_session)
    assert ds.is_active is True
    result = await MISControls.toggle_connection(str(ds.id), False, db_session)
    assert result["is_active"] is False
    assert result["status"] == "updated"


@pytest.mark.asyncio
async def test_load_analysis(db_session: AsyncSession):
    ds, uid = await _seed_datasource(db_session)
    for _ in range(5):
        await _seed_audit_log(db_session, user_id=uid, ds_id=ds.id)
    result = await MISControls.get_load_analysis(str(ds.id), db_session, hours=24)
    assert result["total_queries"] == 5
    assert "hourly_breakdown" in result
    assert result["avg_response_time_ms"] == 150.0


# ===========================================================================
# Sync Dashboard Tests
# ===========================================================================


@pytest.mark.asyncio
async def test_sync_overview(db_session: AsyncSession):
    ds, _ = await _seed_datasource(db_session)
    await _seed_sync_config(db_session, ds.id, mode="cdc")
    await _seed_sync_config(db_session, ds.id, mode="batch")
    await _seed_sync_config(db_session, ds.id, mode="cdc")
    result = await SyncDashboard.get_overview(db_session)
    assert result["total_configs"] == 3
    assert result["active"] == 3
    assert result["by_mode"].get("cdc", 0) == 2
    assert result["by_mode"].get("batch", 0) == 1


@pytest.mark.asyncio
async def test_detailed_status(db_session: AsyncSession):
    ds, _ = await _seed_datasource(db_session)
    await _seed_sync_config(db_session, ds.id, mode="cdc", is_active=True)
    await _seed_sync_config(db_session, ds.id, mode="batch", is_active=False)
    result = await SyncDashboard.get_detailed_status(db_session)
    assert len(result) == 2
    healths = {r["health"] for r in result}
    assert "inactive" in healths
    assert "healthy" in healths


@pytest.mark.asyncio
async def test_sync_overview_endpoint(async_client: AsyncClient):
    resp = await async_client.get("/api/dashboards/sync/overview")
    assert resp.status_code == 200
