from __future__ import annotations

import logging
import uuid
from typing import Optional

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.models import AuditLog

logger = logging.getLogger(__name__)


class AuditLogger:
    """Writes structured audit records to the ``audit_logs`` table."""

    @staticmethod
    async def log(
        user_id: uuid.UUID,
        action: str,
        target_datasource_id: uuid.UUID | None = None,
        query_text: str | None = None,
        response_time_ms: int | None = None,
        ip_address: str | None = None,
        db: AsyncSession | None = None,
    ) -> None:
        """Persist a single audit event.

        Parameters
        ----------
        user_id:
            The ID of the user who performed the action.
        action:
            Short description of what happened (e.g. ``"schema.list_tables"``).
        target_datasource_id:
            Optional FK to the data source involved.
        query_text:
            Optional raw query or search text.
        response_time_ms:
            Optional elapsed time in milliseconds.
        ip_address:
            Optional client IP address.
        db:
            An active async database session.  If ``None`` the event is only
            logged to the standard Python logger (useful during startup / tests).
        """
        if db is None:
            logger.warning(
                "AuditLogger.log called without db session – action='%s' user_id='%s'",
                action,
                user_id,
            )
            return

        entry = AuditLog(
            user_id=user_id,
            action=action,
            target_datasource_id=target_datasource_id,
            query_text=query_text,
            response_time_ms=response_time_ms,
            ip_address=ip_address,
        )
        db.add(entry)
        await db.flush()
        logger.debug("Audit log recorded: action='%s' user_id='%s'", action, user_id)
