from __future__ import annotations

import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.asyncio


async def test_sales_trend_combo_format(async_client: AsyncClient) -> None:
    """Sales trend grouped by combo returns expected format."""
    resp = await async_client.get("/api/reports/sales-trend?group_by=combo")
    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data, list)
    assert len(data) > 0
    item = data[0]
    assert "combo" in item
    assert "period" in item
    assert "units_sold" in item
    assert "revenue" in item


async def test_sales_trend_region_format(async_client: AsyncClient) -> None:
    """Sales trend grouped by region returns expected format."""
    resp = await async_client.get("/api/reports/sales-trend?group_by=region")
    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data, list)
    assert len(data) > 0
    item = data[0]
    assert "region" in item
    assert "units_sold" in item
    assert "revenue" in item


async def test_sales_trend_month_format(async_client: AsyncClient) -> None:
    """Sales trend grouped by month returns expected format."""
    resp = await async_client.get("/api/reports/sales-trend?group_by=month")
    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data, list)
    assert len(data) > 0
    item = data[0]
    assert "month" in item
    assert "units_sold" in item


async def test_combo_performance(async_client: AsyncClient) -> None:
    """Combo performance returns list with trend info."""
    resp = await async_client.get("/api/reports/combo-performance")
    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data, list)
    assert len(data) > 0
    item = data[0]
    assert "combo" in item
    assert "total_units" in item
    assert "total_revenue" in item
    assert "trend" in item
    assert "trend_pct" in item


async def test_export_excel(async_client: AsyncClient) -> None:
    """Excel export returns a downloadable file."""
    resp = await async_client.get("/api/reports/export/excel?group_by=combo")
    assert resp.status_code == 200
    assert "spreadsheetml" in resp.headers.get("content-type", "")
    assert len(resp.content) > 0


async def test_export_pdf(async_client: AsyncClient) -> None:
    """PDF export returns a downloadable file."""
    resp = await async_client.get("/api/reports/export/pdf?group_by=combo")
    assert resp.status_code == 200
    assert "pdf" in resp.headers.get("content-type", "")
    assert len(resp.content) > 0
