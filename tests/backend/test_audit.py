from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit.logger import AuditLogger
from app.core.models import AuditLog, User, UserRole


async def _create_test_user(db: AsyncSession) -> User:
    """Insert a minimal user for FK constraints and return it."""
    user = User(
        id=uuid.uuid4(),
        ad_username=f"testuser_{uuid.uuid4().hex[:8]}",
        display_name="Test User",
        role=UserRole.admin,
    )
    db.add(user)
    await db.flush()
    return user


class TestAuditLogger:
    """Tests for AuditLogger.log()."""

    @pytest.mark.asyncio
    async def test_log_creates_record(self, db_session: AsyncSession) -> None:
        user = await _create_test_user(db_session)
        await AuditLogger.log(
            user_id=user.id,
            action="test.action",
            db=db_session,
        )
        await db_session.flush()

        result = await db_session.execute(select(AuditLog))
        logs = result.scalars().all()
        assert len(logs) == 1
        assert logs[0].action == "test.action"
        assert logs[0].user_id == user.id

    @pytest.mark.asyncio
    async def test_log_with_query_text(self, db_session: AsyncSession) -> None:
        user = await _create_test_user(db_session)
        await AuditLogger.log(
            user_id=user.id,
            action="schema.list_tables",
            query_text="SELECT * FROM pg_tables",
            db=db_session,
        )
        await db_session.flush()

        result = await db_session.execute(select(AuditLog))
        log = result.scalars().first()
        assert log is not None
        assert log.query_text == "SELECT * FROM pg_tables"

    @pytest.mark.asyncio
    async def test_log_with_response_time(self, db_session: AsyncSession) -> None:
        user = await _create_test_user(db_session)
        await AuditLogger.log(
            user_id=user.id,
            action="data.preview",
            response_time_ms=42,
            db=db_session,
        )
        await db_session.flush()

        result = await db_session.execute(select(AuditLog))
        log = result.scalars().first()
        assert log is not None
        assert log.response_time_ms == 42

    @pytest.mark.asyncio
    async def test_log_with_ip_address(self, db_session: AsyncSession) -> None:
        user = await _create_test_user(db_session)
        await AuditLogger.log(
            user_id=user.id,
            action="auth.login",
            ip_address="192.168.1.100",
            db=db_session,
        )
        await db_session.flush()

        result = await db_session.execute(select(AuditLog))
        log = result.scalars().first()
        assert log is not None
        assert log.ip_address == "192.168.1.100"

    @pytest.mark.asyncio
    async def test_log_without_db_session_does_not_raise(self) -> None:
        """When db=None, the logger only writes to Python logging."""
        await AuditLogger.log(
            user_id=uuid.uuid4(),
            action="test.no_db",
            db=None,
        )
        # Should not raise

    @pytest.mark.asyncio
    async def test_multiple_actions(self, db_session: AsyncSession) -> None:
        user = await _create_test_user(db_session)
        actions = [
            "auth.login",
            "schema.list_tables",
            "data.preview",
            "connection.create",
            "auth.logout",
        ]
        for action in actions:
            await AuditLogger.log(user_id=user.id, action=action, db=db_session)
        await db_session.flush()

        result = await db_session.execute(select(AuditLog))
        logs = result.scalars().all()
        assert len(logs) == len(actions)
        logged_actions = {log.action for log in logs}
        assert logged_actions == set(actions)
