from __future__ import annotations

import uuid
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.models import DataSource, FieldMapping, SyncConfig, SyncMode
from app.core.security import encrypt_password
from app.sync.mapping import FieldMappingService, safe_eval

# Note: routers define their own prefix AND main.py adds a prefix, so the
# effective path is doubled (same pattern as test_connections_api.py).
SYNC_BASE = "/api/sync/api/sync"
MAPPINGS_BASE = "/api/mappings/api/mappings"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _create_datasource(db: AsyncSession) -> DataSource:
    """Insert a minimal DataSource for FK references."""
    from tests.backend.conftest import MOCK_USER_ID

    ds = DataSource(
        name="Test DS",
        db_type="postgresql",
        host="localhost",
        port=5432,
        database_name="testdb",
        username="user",
        encrypted_password=encrypt_password("pass"),
        created_by=uuid.UUID(MOCK_USER_ID),
    )
    db.add(ds)
    await db.flush()
    await db.refresh(ds)
    return ds


async def _create_sync_config(
    db: AsyncSession,
    ds: DataSource,
    sync_mode: str = "batch",
    is_active: bool = True,
) -> SyncConfig:
    """Insert a SyncConfig for test purposes."""
    sc = SyncConfig(
        data_source_id=ds.id,
        table_name="test_table",
        sync_mode=SyncMode(sync_mode),
        cron_expression="*/5 * * * *" if sync_mode == "batch" else None,
        is_active=is_active,
    )
    db.add(sc)
    await db.flush()
    await db.refresh(sc)
    return sc


# ---------------------------------------------------------------------------
# FieldMappingService.apply_mapping tests
# ---------------------------------------------------------------------------


class TestApplyMapping:
    """Test the FieldMappingService.apply_mapping method with various transforms."""

    def _make_mapping(
        self,
        source_field: str,
        target_field: str,
        transform_rule: dict[str, Any] | None = None,
    ) -> FieldMapping:
        return FieldMapping(
            id=uuid.uuid4(),
            name="test",
            version=1,
            source_datasource_id=uuid.uuid4(),
            source_table="src",
            source_field=source_field,
            target_field=target_field,
            transform_rule=transform_rule,
        )

    def test_rename_transform(self) -> None:
        """Rename transform passes value through to the new field name."""
        mappings = [
            self._make_mapping("old_name", "new_name", {"type": "rename"}),
        ]
        source = [{"old_name": "hello"}]
        result = FieldMappingService.apply_mapping(mappings, source)
        assert result == [{"new_name": "hello"}]

    def test_type_cast_int(self) -> None:
        """type_cast to int converts string values."""
        mappings = [
            self._make_mapping("qty", "quantity", {"type": "type_cast", "target": "int"}),
        ]
        source = [{"qty": "42"}, {"qty": "100"}]
        result = FieldMappingService.apply_mapping(mappings, source)
        assert result == [{"quantity": 42}, {"quantity": 100}]

    def test_type_cast_float(self) -> None:
        """type_cast to float converts string values."""
        mappings = [
            self._make_mapping("price", "price_float", {"type": "type_cast", "target": "float"}),
        ]
        source = [{"price": "19.99"}]
        result = FieldMappingService.apply_mapping(mappings, source)
        assert result == [{"price_float": 19.99}]

    def test_type_cast_none_passthrough(self) -> None:
        """type_cast on None value returns None."""
        mappings = [
            self._make_mapping("val", "out", {"type": "type_cast", "target": "int"}),
        ]
        source = [{"val": None}]
        result = FieldMappingService.apply_mapping(mappings, source)
        assert result == [{"out": None}]

    def test_value_map(self) -> None:
        """value_map transforms discrete values."""
        mappings = [
            self._make_mapping(
                "status",
                "status_label",
                {
                    "type": "value_map",
                    "mapping": {"1": "Active", "0": "Inactive"},
                    "default": "Unknown",
                },
            ),
        ]
        source = [{"status": "1"}, {"status": "0"}, {"status": "99"}]
        result = FieldMappingService.apply_mapping(mappings, source)
        assert result == [
            {"status_label": "Active"},
            {"status_label": "Inactive"},
            {"status_label": "Unknown"},
        ]

    def test_expression_transform(self) -> None:
        """expression transform evaluates a safe expression."""
        mappings = [
            self._make_mapping(
                "price",
                "price_with_tax",
                {"type": "expression", "expr": "value * 1.1"},
            ),
        ]
        source = [{"price": 100}]
        result = FieldMappingService.apply_mapping(mappings, source)
        assert result[0]["price_with_tax"] == pytest.approx(110.0)

    def test_default_transform(self) -> None:
        """default transform fills in missing values."""
        mappings = [
            self._make_mapping("color", "color", {"type": "default", "value": "red"}),
        ]
        source = [{"color": None}, {"color": "blue"}]
        result = FieldMappingService.apply_mapping(mappings, source)
        assert result == [{"color": "red"}, {"color": "blue"}]

    def test_no_transform(self) -> None:
        """No transform_rule passes value through unchanged."""
        mappings = [
            self._make_mapping("a", "b", None),
        ]
        source = [{"a": "test"}]
        result = FieldMappingService.apply_mapping(mappings, source)
        assert result == [{"b": "test"}]

    def test_multiple_mappings(self) -> None:
        """Multiple mappings applied to the same row."""
        mappings = [
            self._make_mapping("name", "full_name", {"type": "rename"}),
            self._make_mapping("age", "age_int", {"type": "type_cast", "target": "int"}),
        ]
        source = [{"name": "Alice", "age": "30"}]
        result = FieldMappingService.apply_mapping(mappings, source)
        assert result == [{"full_name": "Alice", "age_int": 30}]


# ---------------------------------------------------------------------------
# safe_eval tests
# ---------------------------------------------------------------------------


class TestSafeEval:
    def test_arithmetic(self) -> None:
        assert safe_eval("value + 10", {"value": 5}) == 15

    def test_comparison(self) -> None:
        assert safe_eval("value > 0", {"value": 5}) is True

    def test_conditional(self) -> None:
        assert safe_eval("'yes' if value > 0 else 'no'", {"value": 5}) == "yes"

    def test_function_call(self) -> None:
        assert safe_eval("abs(value)", {"value": -5}) == 5

    def test_disallowed_name(self) -> None:
        with pytest.raises(ValueError, match="not allowed"):
            safe_eval("__import__('os')", {})


# ---------------------------------------------------------------------------
# Monitoring tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_sync_status_empty(db_session: AsyncSession) -> None:
    """get_sync_status returns an empty list when no configs exist."""
    from app.sync.monitoring import get_sync_status

    statuses = await get_sync_status(db_session)
    assert isinstance(statuses, list)
    assert len(statuses) == 0


@pytest.mark.asyncio
async def test_get_sync_status_format(db_session: AsyncSession) -> None:
    """get_sync_status returns correct format for existing configs."""
    from app.sync.monitoring import get_sync_status

    ds = await _create_datasource(db_session)
    sc = await _create_sync_config(db_session, ds)
    await db_session.commit()

    statuses = await get_sync_status(db_session)
    assert len(statuses) == 1
    entry = statuses[0]
    assert entry["id"] == str(sc.id)
    assert entry["table_name"] == "test_table"
    assert entry["sync_mode"] == "batch"
    assert entry["is_active"] is True
    assert "lag_seconds" in entry
    assert "last_sync_at" in entry
    assert "last_sync_status" in entry


@pytest.mark.asyncio
async def test_detect_sync_lag(db_session: AsyncSession) -> None:
    """detect_sync_lag flags configs that have never synced."""
    from app.sync.monitoring import detect_sync_lag

    ds = await _create_datasource(db_session)
    await _create_sync_config(db_session, ds)
    await db_session.commit()

    lagging = await detect_sync_lag(db_session, threshold_seconds=60)
    assert len(lagging) == 1


# ---------------------------------------------------------------------------
# Sync API endpoint tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_sync_status_endpoint(async_client: AsyncClient) -> None:
    """GET /api/sync/status returns 200 with expected structure."""
    resp = await async_client.get(f"{SYNC_BASE}/status")
    assert resp.status_code == 200
    data = resp.json()
    assert "configs" in data
    assert "lagging_count" in data
    assert isinstance(data["configs"], list)


@pytest.mark.asyncio
async def test_sync_configs_list_empty(async_client: AsyncClient) -> None:
    """GET /api/sync/configs returns empty list initially."""
    resp = await async_client.get(f"{SYNC_BASE}/configs")
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.asyncio
async def test_sync_config_crud(async_client: AsyncClient, db_session: AsyncSession) -> None:
    """Test create and list sync configs through the API."""
    # First create a data source so we have a valid FK
    ds = await _create_datasource(db_session)
    await db_session.commit()

    # Create sync config
    payload = {
        "data_source_id": str(ds.id),
        "table_name": "orders",
        "sync_mode": "batch",
        "cron_expression": "0 * * * *",
    }
    create_resp = await async_client.post(f"{SYNC_BASE}/configs", json=payload)
    assert create_resp.status_code == 201
    created = create_resp.json()
    assert created["table_name"] == "orders"
    assert created["sync_mode"] == "batch"
    config_id = created["id"]

    # List configs
    list_resp = await async_client.get(f"{SYNC_BASE}/configs")
    assert list_resp.status_code == 200
    configs = list_resp.json()
    assert len(configs) >= 1

    # Delete (deactivate)
    del_resp = await async_client.delete(f"{SYNC_BASE}/configs/{config_id}")
    assert del_resp.status_code == 204


@pytest.mark.asyncio
async def test_sync_config_not_found(async_client: AsyncClient) -> None:
    """GET/PUT/DELETE on a nonexistent config returns 404."""
    fake_id = str(uuid.uuid4())
    resp = await async_client.get(f"{SYNC_BASE}/history/{fake_id}")
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Mappings API endpoint tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_mappings_list_empty(async_client: AsyncClient) -> None:
    """GET /api/mappings/ returns empty list initially."""
    resp = await async_client.get(f"{MAPPINGS_BASE}/")
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.asyncio
async def test_mappings_preview(async_client: AsyncClient) -> None:
    """POST /api/mappings/preview transforms sample data."""
    payload = {
        "mappings": [
            {
                "source_field": "name",
                "target_field": "full_name",
                "transform_rule": {"type": "rename"},
            },
            {
                "source_field": "age",
                "target_field": "age_num",
                "transform_rule": {"type": "type_cast", "target": "int"},
            },
        ],
        "sample_data": [
            {"name": "Alice", "age": "30"},
            {"name": "Bob", "age": "25"},
        ],
    }
    resp = await async_client.post(f"{MAPPINGS_BASE}/preview", json=payload)
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 2
    assert data[0] == {"full_name": "Alice", "age_num": 30}
    assert data[1] == {"full_name": "Bob", "age_num": 25}


@pytest.mark.asyncio
async def test_mappings_crud(async_client: AsyncClient, db_session: AsyncSession) -> None:
    """Test create mapping and get history through the API."""
    ds = await _create_datasource(db_session)
    await db_session.commit()

    # Create mapping
    payload = {
        "name": "order_mapping",
        "source_datasource_id": str(ds.id),
        "source_table": "orders",
        "mappings": [
            {
                "source_field": "order_id",
                "target_field": "id",
                "transform_rule": None,
            },
            {
                "source_field": "total",
                "target_field": "amount",
                "transform_rule": {"type": "type_cast", "target": "float"},
            },
        ],
    }
    create_resp = await async_client.post(f"{MAPPINGS_BASE}/", json=payload)
    assert create_resp.status_code == 201
    created = create_resp.json()
    assert len(created) == 2
    assert created[0]["name"] == "order_mapping"
    assert created[0]["version"] == 1

    # List mappings
    list_resp = await async_client.get(f"{MAPPINGS_BASE}/")
    assert list_resp.status_code == 200
    listing = list_resp.json()
    assert len(listing) >= 1

    # Get single mapping
    mapping_id = created[0]["id"]
    get_resp = await async_client.get(f"{MAPPINGS_BASE}/{mapping_id}")
    assert get_resp.status_code == 200
    assert get_resp.json()["id"] == mapping_id
