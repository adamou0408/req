from __future__ import annotations

import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.asyncio


async def test_inventory_search_returns_expected_format(async_client: AsyncClient) -> None:
    """Inventory search returns list of dicts with required fields."""
    resp = await async_client.get("/api/inventory/search")
    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data, list)
    assert len(data) > 0
    item = data[0]
    assert "model" in item
    assert "warehouse" in item
    assert "quantity" in item
    assert "in_transit" in item
    assert "last_updated" in item


async def test_inventory_search_by_model(async_client: AsyncClient) -> None:
    """Filtering by model returns only matching items."""
    resp = await async_client.get("/api/inventory/search?model=FL-256A")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) > 0
    for item in data:
        assert "FL-256A" in item["model"].upper()


async def test_inventory_search_by_part_number(async_client: AsyncClient) -> None:
    """Filtering by part_number returns only matching items."""
    resp = await async_client.get("/api/inventory/search?part_number=PN-001")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) > 0
    for item in data:
        assert "PN-001" in item["part_number"].upper()


async def test_product_schedule(async_client: AsyncClient) -> None:
    """Product schedule returns list with required fields."""
    resp = await async_client.get("/api/inventory/product/CTRL-A100/schedule")
    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data, list)
    assert len(data) > 0
    entry = data[0]
    assert "product_model" in entry
    assert "scheduled_date" in entry
    assert "quantity" in entry
    assert "status" in entry
    assert entry["product_model"] == "CTRL-A100"


async def test_inventory_summary(async_client: AsyncClient) -> None:
    """Inventory summary returns aggregated data by product type."""
    resp = await async_client.get("/api/inventory/summary")
    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data, list)
    assert len(data) > 0
    types = {item["product_type"] for item in data}
    assert "controller" in types or "flash" in types
    for item in data:
        assert "total_quantity" in item
        assert "total_in_transit" in item
        assert "sku_count" in item
