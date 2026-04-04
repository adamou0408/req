from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from typing import Any

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import BigInteger, Integer, event
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.core.database import Base, get_db
from app.core.security import get_current_user
from app.main import app

# ---------------------------------------------------------------------------
# Test database - in-memory SQLite via aiosqlite
# ---------------------------------------------------------------------------

TEST_DATABASE_URL = "sqlite+aiosqlite:///:memory:"

test_engine = create_async_engine(TEST_DATABASE_URL, echo=False)
test_session_factory = async_sessionmaker(
    bind=test_engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


# SQLite does not support BigInteger autoincrement the same way as PostgreSQL.
# Swap BigInteger -> Integer at DDL time so that autoincrement works.
@event.listens_for(Base.metadata, "column_reflect")
def _fix_bigint(inspector, table, column_info):
    if isinstance(column_info.get("type"), BigInteger):
        column_info["type"] = Integer()


async def _override_get_db() -> AsyncIterator[AsyncSession]:
    async with test_session_factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


# ---------------------------------------------------------------------------
# Mock authenticated user (big_data role by default)
# ---------------------------------------------------------------------------

MOCK_USER_ID = str(uuid.uuid4())


def _mock_current_user() -> dict[str, Any]:
    return {
        "sub": "testuser",
        "user_id": MOCK_USER_ID,
        "role": "big_data",
    }


async def _override_get_current_user() -> dict[str, Any]:
    return _mock_current_user()


# ---------------------------------------------------------------------------
# Override dependencies
# ---------------------------------------------------------------------------

app.dependency_overrides[get_db] = _override_get_db
app.dependency_overrides[get_current_user] = _override_get_current_user


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture(autouse=True)
async def _setup_database() -> AsyncIterator[None]:
    """Create all tables before each test and drop them afterwards."""
    # Replace BigInteger with Integer for SQLite compatibility
    for table in Base.metadata.tables.values():
        for column in table.columns:
            if isinstance(column.type, BigInteger):
                column.type = Integer()

    async with test_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield
    async with test_engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)


@pytest_asyncio.fixture
async def async_client() -> AsyncIterator[AsyncClient]:
    """Provide an httpx.AsyncClient wired to the FastAPI test app."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        yield client


@pytest_asyncio.fixture
async def db_session() -> AsyncIterator[AsyncSession]:
    """Provide a raw async DB session for direct ORM operations in tests."""
    async with test_session_factory() as session:
        yield session


@pytest.fixture
def mock_user() -> dict[str, Any]:
    """Return the mock authenticated user dict."""
    return _mock_current_user()
