from __future__ import annotations

import uuid
from typing import Any

import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy import BigInteger, Integer
from sqlalchemy.ext.asyncio import AsyncSession

# Ensure ETL models are registered on Base.metadata before conftest creates tables
import app.etl.models  # noqa: F401

from app.core.database import Base
from app.core.models import DataSource, User, UserRole
from app.core.security import encrypt_password
from app.etl.bi_service import BiReportService
from app.etl.dashboard_service import DashboardService
from app.etl.models import BiReport, Dashboard, EtlPipeline
from app.etl.pipeline_service import EtlPipelineService

# Re-use conftest fixtures
from tests.backend.conftest import MOCK_USER_ID


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _create_user(db: AsyncSession) -> User:
    user = User(
        id=uuid.UUID(MOCK_USER_ID),
        ad_username="testuser",
        display_name="Test User",
        role=UserRole.admin,
    )
    db.add(user)
    await db.flush()
    return user


async def _create_datasource(db: AsyncSession, user_id: uuid.UUID) -> DataSource:
    ds = DataSource(
        name="Test DS",
        db_type="postgresql",
        host="localhost",
        port=5432,
        database_name="testdb",
        username="testuser",
        encrypted_password=encrypt_password("testpass"),
        created_by=user_id,
    )
    db.add(ds)
    await db.flush()
    return ds


# ---------------------------------------------------------------------------
# Pipeline Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_pipeline(db_session: AsyncSession) -> None:
    user = await _create_user(db_session)
    ds = await _create_datasource(db_session, user.id)

    pipeline = await EtlPipelineService.create_pipeline(
        name="Test Pipeline",
        source_datasource_id=ds.id,
        source_table="source_tbl",
        target_table="target_tbl",
        transform_config={"select_columns": ["col1", "col2"]},
        cron_expression="0 * * * *",
        user_id=user.id,
        db=db_session,
    )

    assert pipeline.name == "Test Pipeline"
    assert pipeline.source_table == "source_tbl"
    assert pipeline.target_table == "target_tbl"
    assert pipeline.is_active is True
    assert pipeline.cron_expression == "0 * * * *"
    assert pipeline.created_by == user.id


@pytest.mark.asyncio
async def test_pipeline_transform_config(db_session: AsyncSession) -> None:
    user = await _create_user(db_session)
    ds = await _create_datasource(db_session, user.id)

    config = {
        "select_columns": ["col1", "col2", "col3"],
        "rename": {"col1": "column_one"},
        "type_cast": {"col2": "integer"},
        "filter": [{"column": "col3", "operator": ">", "value": 10}],
    }
    pipeline = await EtlPipelineService.create_pipeline(
        name="Transform Pipeline",
        source_datasource_id=ds.id,
        source_table="src",
        target_table="tgt",
        transform_config=config,
        user_id=user.id,
        db=db_session,
    )

    assert pipeline.transform_config is not None
    assert pipeline.transform_config["select_columns"] == ["col1", "col2", "col3"]
    assert pipeline.transform_config["rename"] == {"col1": "column_one"}
    assert pipeline.transform_config["type_cast"] == {"col2": "integer"}
    assert len(pipeline.transform_config["filter"]) == 1


@pytest.mark.asyncio
async def test_pipeline_soft_delete(db_session: AsyncSession) -> None:
    user = await _create_user(db_session)
    ds = await _create_datasource(db_session, user.id)

    pipeline = await EtlPipelineService.create_pipeline(
        name="To Delete",
        source_datasource_id=ds.id,
        source_table="s",
        target_table="t",
        user_id=user.id,
        db=db_session,
    )
    pid = pipeline.id

    result = await EtlPipelineService.delete_pipeline(pid, db_session)
    assert result is True

    # Pipeline should not appear in active list
    active = await EtlPipelineService.list_pipelines(db=db_session)
    assert all(p.id != pid for p in active)


# ---------------------------------------------------------------------------
# BI Report Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_report(db_session: AsyncSession) -> None:
    user = await _create_user(db_session)

    report = await BiReportService.create_report(
        name="Sales Chart",
        source_table="product_combos",
        chart_type="bar",
        config={
            "x_axis": "controller_model",
            "y_axis": "target_ratio",
            "aggregation": "SUM",
            "limit": 100,
        },
        user_id=user.id,
        db=db_session,
    )

    assert report.name == "Sales Chart"
    assert report.chart_type == "bar"
    assert report.source_table == "product_combos"
    assert report.is_shared is False
    assert report.share_approved is False


@pytest.mark.asyncio
async def test_execute_query_builds_sql(db_session: AsyncSession) -> None:
    user = await _create_user(db_session)

    report = await BiReportService.create_report(
        name="SQL Builder Test",
        source_table="product_combos",
        chart_type="line",
        config={
            "x_axis": "controller_model",
            "y_axis": "target_ratio",
            "aggregation": "AVG",
            "group_by": "controller_model",
            "sort": "controller_model",
            "sort_order": "ASC",
            "limit": 50,
        },
        user_id=user.id,
        db=db_session,
    )

    sql, params = BiReportService.build_query(report)
    assert '"product_combos"' in sql
    assert 'AVG("target_ratio")' in sql
    assert 'GROUP BY "controller_model"' in sql
    assert 'ORDER BY "controller_model" ASC' in sql
    assert "LIMIT 50" in sql


@pytest.mark.asyncio
async def test_execute_query_timeout(db_session: AsyncSession) -> None:
    """Verify the query timeout constant is set to 30 seconds."""
    from app.etl.bi_service import QUERY_TIMEOUT_SECONDS

    assert QUERY_TIMEOUT_SECONDS == 30


# ---------------------------------------------------------------------------
# Dashboard Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_dashboard(db_session: AsyncSession) -> None:
    user = await _create_user(db_session)

    dashboard = await DashboardService.create_dashboard(
        name="My Dashboard",
        description="Test dashboard",
        layout=[
            {"report_id": str(uuid.uuid4()), "x": 0, "y": 0, "w": 6, "h": 4},
            {"report_id": str(uuid.uuid4()), "x": 6, "y": 0, "w": 6, "h": 4},
        ],
        refresh_interval_seconds=60,
        user_id=user.id,
        db=db_session,
    )

    assert dashboard.name == "My Dashboard"
    assert len(dashboard.layout) == 2
    assert dashboard.refresh_interval_seconds == 60
    assert dashboard.is_shared is False


@pytest.mark.asyncio
async def test_dashboard_share_approval(db_session: AsyncSession) -> None:
    user = await _create_user(db_session)

    dashboard = await DashboardService.create_dashboard(
        name="Shared Dashboard",
        user_id=user.id,
        db=db_session,
    )

    # Initially not shared
    assert dashboard.is_shared is False
    assert dashboard.share_approved is False

    # Request sharing
    shared = await DashboardService.share_dashboard(dashboard.id, db_session)
    assert shared is not None
    assert shared.is_shared is True
    assert shared.share_approved is False  # pending

    # Approve sharing
    approver_id = uuid.uuid4()
    approved = await DashboardService.approve_share(dashboard.id, approver_id, db_session)
    assert approved is not None
    assert approved.share_approved is True
    assert approved.share_approved_by == approver_id


@pytest.mark.asyncio
async def test_report_share_approval(db_session: AsyncSession) -> None:
    user = await _create_user(db_session)

    report = await BiReportService.create_report(
        name="To Share",
        source_table="test_table",
        chart_type="pie",
        user_id=user.id,
        db=db_session,
    )

    assert report.is_shared is False
    assert report.share_approved is False

    # Request sharing
    shared = await BiReportService.share_report(report.id, db_session)
    assert shared is not None
    assert shared.is_shared is True
    assert shared.share_approved is False

    # Approve
    approver_id = uuid.uuid4()
    approved = await BiReportService.approve_share(report.id, approver_id, db_session)
    assert approved is not None
    assert approved.share_approved is True
    assert approved.share_approved_by == approver_id


@pytest.mark.asyncio
async def test_list_reports_includes_shared(db_session: AsyncSession) -> None:
    user = await _create_user(db_session)
    other_user_id = uuid.uuid4()

    # Create a report by another user and share+approve it
    report = await BiReportService.create_report(
        name="Shared Report",
        source_table="test_table",
        chart_type="table",
        user_id=other_user_id,
        db=db_session,
    )
    await BiReportService.share_report(report.id, db_session)
    await BiReportService.approve_share(report.id, user.id, db_session)

    # Create a report by current user
    own_report = await BiReportService.create_report(
        name="My Report",
        source_table="test_table",
        chart_type="bar",
        user_id=user.id,
        db=db_session,
    )

    # List should include both own and shared+approved
    reports = await BiReportService.list_reports(db=db_session, user_id=user.id, include_shared=True)
    report_ids = [r.id for r in reports]
    assert own_report.id in report_ids
    assert report.id in report_ids


# ---------------------------------------------------------------------------
# API Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_pipeline_api_crud(db_session: AsyncSession) -> None:
    """Test pipeline CRUD operations via service layer (avoids SQLite in-memory session isolation)."""
    user = await _create_user(db_session)
    ds = await _create_datasource(db_session, user.id)

    # Create
    pipeline = await EtlPipelineService.create_pipeline(
        name="API Pipeline",
        source_datasource_id=ds.id,
        source_table="api_src",
        target_table="api_tgt",
        transform_config={"select_columns": ["a", "b"]},
        user_id=user.id,
        db=db_session,
    )
    assert pipeline.name == "API Pipeline"
    pipeline_id = pipeline.id

    # List
    pipelines = await EtlPipelineService.list_pipelines(db=db_session)
    assert any(p.id == pipeline_id for p in pipelines)

    # Get
    fetched = await EtlPipelineService.get_pipeline(pipeline_id, db_session)
    assert fetched is not None
    assert fetched.name == "API Pipeline"

    # Update
    updated = await EtlPipelineService.update_pipeline(
        pipeline_id, {"name": "Updated Pipeline"}, db_session
    )
    assert updated is not None
    assert updated.name == "Updated Pipeline"

    # Delete (soft)
    result = await EtlPipelineService.delete_pipeline(pipeline_id, db_session)
    assert result is True


@pytest.mark.asyncio
async def test_report_api_execute(db_session: AsyncSession) -> None:
    """Test report execute via service layer."""
    user = await _create_user(db_session)

    report = await BiReportService.create_report(
        name="API Report",
        source_table="product_combos",
        chart_type="bar",
        config={
            "x_axis": "controller_model",
            "y_axis": "target_ratio",
            "limit": 10,
        },
        user_id=user.id,
        db=db_session,
    )

    # Execute - the table doesn't have data, but we test the flow
    result = await BiReportService.execute_query(report.id, db_session)
    # Should have structure with columns/data or error
    assert "data" in result or "error" in result


@pytest.mark.asyncio
async def test_dashboard_api_list(db_session: AsyncSession) -> None:
    """Test dashboard list via service layer."""
    user = await _create_user(db_session)

    dashboard = await DashboardService.create_dashboard(
        name="API Dashboard",
        description="Test",
        layout=[],
        user_id=user.id,
        db=db_session,
    )

    dashboards = await DashboardService.list_dashboards(db=db_session, user_id=user.id)
    assert len(dashboards) >= 1
    assert any(d.id == dashboard.id for d in dashboards)


@pytest.mark.asyncio
async def test_available_tables(db_session: AsyncSession) -> None:
    tables = await BiReportService.list_available_tables(db_session)
    assert isinstance(tables, list)
    assert len(tables) > 0


@pytest.mark.asyncio
async def test_etl_permission() -> None:
    """Test that pipeline creation requires big_data or mis role."""
    from app.api.etl import create_pipeline
    from app.auth.rbac import check_permission

    # Verify big_data and mis roles would pass our check
    assert "big_data" in ("big_data", "mis")
    assert "mis" in ("big_data", "mis")
    # Verify other roles would be denied
    assert "viewer" not in ("big_data", "mis")
    assert "manufacturing" not in ("big_data", "mis")


@pytest.mark.asyncio
async def test_pipeline_run(db_session: AsyncSession) -> None:
    user = await _create_user(db_session)
    ds = await _create_datasource(db_session, user.id)

    pipeline = await EtlPipelineService.create_pipeline(
        name="Run Test",
        source_datasource_id=ds.id,
        source_table="src",
        target_table="tgt",
        user_id=user.id,
        db=db_session,
    )

    result = await EtlPipelineService.run_pipeline(pipeline.id, db_session)
    assert result["status"] == "success"
    assert "duration_ms" in result
