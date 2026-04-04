from __future__ import annotations

import pytest
from httpx import AsyncClient

# The connections router defines its own prefix="/api/connections" and
# main.py includes it with prefix="/api/connections", so the effective
# base path is doubled.
BASE = "/api/connections/api/connections"


@pytest.mark.asyncio
async def test_supported_types(async_client: AsyncClient) -> None:
    """GET .../supported-types returns oracle and postgresql."""
    response = await async_client.get(f"{BASE}/supported-types")
    assert response.status_code == 200
    data = response.json()
    assert isinstance(data, list)
    assert "oracle" in data
    assert "postgresql" in data


@pytest.mark.asyncio
async def test_create_connection(async_client: AsyncClient) -> None:
    """POST .../ creates a data source."""
    payload = {
        "name": "Test PG",
        "db_type": "postgresql",
        "host": "db.example.com",
        "port": 5432,
        "database_name": "mydb",
        "username": "dbuser",
        "password": "supersecret",
    }
    response = await async_client.post(f"{BASE}/", json=payload)
    assert response.status_code == 201
    data = response.json()
    assert data["name"] == "Test PG"
    assert data["db_type"] == "postgresql"
    assert data["host"] == "db.example.com"
    assert data["port"] == 5432
    assert data["username"] == "dbuser"
    assert data["is_active"] is True
    # The response must mask the password and never expose the encrypted bytes
    assert data.get("password") == "********"
    assert "encrypted_password" not in data


@pytest.mark.asyncio
async def test_list_connections_after_create(async_client: AsyncClient) -> None:
    """GET .../ returns previously created data sources."""
    payload = {
        "name": "List Test DB",
        "db_type": "oracle",
        "host": "oracle.local",
        "port": 1521,
        "database_name": "orcl",
        "username": "orauser",
        "password": "orapass",
    }
    create_resp = await async_client.post(f"{BASE}/", json=payload)
    assert create_resp.status_code == 201

    list_resp = await async_client.get(f"{BASE}/")
    assert list_resp.status_code == 200
    items = list_resp.json()
    assert isinstance(items, list)
    assert len(items) >= 1
    # Verify no password leakage in list response
    for item in items:
        assert item.get("password") == "********"
        assert "encrypted_password" not in item


@pytest.mark.asyncio
async def test_create_connection_missing_field(async_client: AsyncClient) -> None:
    """POST .../ with missing required fields returns 422."""
    payload = {
        "name": "Incomplete",
        # missing db_type, host, port, etc.
    }
    response = await async_client.post(f"{BASE}/", json=payload)
    assert response.status_code == 422
