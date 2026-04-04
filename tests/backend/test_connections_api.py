from __future__ import annotations

import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_supported_types(async_client: AsyncClient) -> None:
    """GET /api/connections/supported-types returns oracle and postgresql."""
    response = await async_client.get("/api/connections/supported-types")
    assert response.status_code == 200
    data = response.json()
    assert "types" in data
    assert "oracle" in data["types"]
    assert "postgresql" in data["types"]


@pytest.mark.asyncio
async def test_create_connection(async_client: AsyncClient) -> None:
    """POST /api/connections/ creates a data source."""
    payload = {
        "name": "Test PG",
        "db_type": "postgresql",
        "host": "db.example.com",
        "port": 5432,
        "database_name": "mydb",
        "username": "dbuser",
        "password": "supersecret",
    }
    response = await async_client.post("/api/connections/", json=payload)
    assert response.status_code == 201
    data = response.json()
    assert data["name"] == "Test PG"
    assert data["db_type"] == "postgresql"
    assert data["host"] == "db.example.com"
    assert data["port"] == 5432
    assert data["username"] == "dbuser"
    assert data["is_active"] is True
    # The response model should NOT include encrypted_password or plain password
    assert "password" not in data
    assert "encrypted_password" not in data


@pytest.mark.asyncio
async def test_list_connections_after_create(async_client: AsyncClient) -> None:
    """GET /api/connections/ returns previously created data sources."""
    payload = {
        "name": "List Test DB",
        "db_type": "oracle",
        "host": "oracle.local",
        "port": 1521,
        "database_name": "orcl",
        "username": "orauser",
        "password": "orapass",
    }
    create_resp = await async_client.post("/api/connections/", json=payload)
    assert create_resp.status_code == 201

    list_resp = await async_client.get("/api/connections/")
    assert list_resp.status_code == 200
    items = list_resp.json()
    assert isinstance(items, list)
    assert len(items) >= 1
    # Verify no password leakage in list response
    for item in items:
        assert "password" not in item
        assert "encrypted_password" not in item


@pytest.mark.asyncio
async def test_create_connection_missing_field(async_client: AsyncClient) -> None:
    """POST /api/connections/ with missing required fields returns 422."""
    payload = {
        "name": "Incomplete",
        # missing db_type, host, port, etc.
    }
    response = await async_client.post("/api/connections/", json=payload)
    assert response.status_code == 422
