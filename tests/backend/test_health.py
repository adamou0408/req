from __future__ import annotations

import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_health_returns_ok(async_client: AsyncClient) -> None:
    response = await async_client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


@pytest.mark.asyncio
async def test_health_response_structure(async_client: AsyncClient) -> None:
    response = await async_client.get("/health")
    data = response.json()
    assert "status" in data
    assert data["status"] == "ok"
