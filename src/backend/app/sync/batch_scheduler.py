from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

from celery import Celery
from celery.schedules import crontab
from cryptography.fernet import Fernet
from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import settings

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Celery application
# ---------------------------------------------------------------------------

celery_app = Celery(
    "data_sync",
    broker=settings.REDIS_URL,
    backend=settings.REDIS_URL,
)

celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
    task_track_started=True,
    task_acks_late=True,
    worker_prefetch_multiplier=1,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_engine = create_async_engine(settings.DATABASE_URL, pool_pre_ping=True)
_session_factory = async_sessionmaker(bind=_engine, class_=AsyncSession, expire_on_commit=False)


def _decrypt_password(encrypted: bytes) -> str:
    """Decrypt a Fernet-encrypted password."""
    f = Fernet(settings.fernet_key)
    return f.decrypt(encrypted).decode("utf-8")


def _parse_cron(expression: str) -> dict:
    """Parse a 5-field cron expression into celery crontab kwargs."""
    parts = expression.strip().split()
    if len(parts) != 5:
        raise ValueError(f"Invalid cron expression: {expression!r}")
    return {
        "minute": parts[0],
        "hour": parts[1],
        "day_of_month": parts[2],
        "month_of_year": parts[3],
        "day_of_week": parts[4],
    }


# ---------------------------------------------------------------------------
# Tasks
# ---------------------------------------------------------------------------


@celery_app.task(
    bind=True,
    max_retries=3,
    default_retry_delay=10,
    autoretry_for=(Exception,),
    retry_backoff=True,
    retry_backoff_max=300,
    retry_jitter=True,
)
def run_batch_sync(self, sync_config_id: str) -> dict:
    """Execute a batch sync for a given SyncConfig.

    Steps:
    1. Load SyncConfig and associated DataSource from the DB.
    2. Decrypt the password and create a connector via the registry.
    3. Extract data from the source table.
    4. Load into the platform DB via a staging table pattern.
    5. Update SyncConfig with sync status.
    """
    import asyncio

    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(_run_batch_sync_async(sync_config_id))
    finally:
        loop.close()


async def _run_batch_sync_async(sync_config_id: str) -> dict:
    """Async implementation of batch sync."""
    from app.connectors.registry import ConnectorRegistry
    from app.core.models import DataSource, SyncConfig

    config_uuid = uuid.UUID(sync_config_id)

    async with _session_factory() as session:
        # Load SyncConfig
        stmt = select(SyncConfig).where(SyncConfig.id == config_uuid)
        result = await session.execute(stmt)
        sync_config = result.scalar_one_or_none()

        if sync_config is None:
            logger.error("SyncConfig %s not found", sync_config_id)
            return {"status": "error", "detail": "SyncConfig not found"}

        if not sync_config.is_active:
            logger.info("SyncConfig %s is inactive, skipping", sync_config_id)
            return {"status": "skipped", "detail": "SyncConfig is inactive"}

        # Load DataSource
        ds_stmt = select(DataSource).where(DataSource.id == sync_config.data_source_id)
        ds_result = await session.execute(ds_stmt)
        data_source = ds_result.scalar_one_or_none()

        if data_source is None:
            await _update_sync_status(session, config_uuid, "error")
            return {"status": "error", "detail": "DataSource not found"}

        try:
            # Decrypt password and create connector
            password = _decrypt_password(data_source.encrypted_password)
            connector = ConnectorRegistry.get_connector(
                db_type=data_source.db_type,
                host=data_source.host,
                port=data_source.port,
                database=data_source.database_name,
                username=data_source.username,
                password=password,
            )

            # Connect and extract data
            connector.connect()
            try:
                rows = connector.preview_data(
                    table_name=sync_config.table_name,
                    limit=100_000,
                )
            finally:
                connector.disconnect()

            if not rows:
                await _update_sync_status(session, config_uuid, "success")
                return {"status": "success", "rows_synced": 0}

            # Load into platform DB using staging table pattern
            staging_table = f"stg_{sync_config.table_name}_{config_uuid.hex[:8]}"
            await _load_to_staging(session, staging_table, rows)

            await _update_sync_status(session, config_uuid, "success")
            await session.commit()

            logger.info(
                "Batch sync completed for %s: %d rows synced",
                sync_config_id,
                len(rows),
            )
            return {"status": "success", "rows_synced": len(rows)}

        except Exception as exc:
            logger.exception("Batch sync failed for %s", sync_config_id)
            await session.rollback()
            async with _session_factory() as err_session:
                await _update_sync_status(err_session, config_uuid, "error")
                await err_session.commit()
            raise


async def _update_sync_status(
    session: AsyncSession,
    config_id: uuid.UUID,
    status: str,
) -> None:
    """Update last_sync_at and last_sync_status on a SyncConfig."""
    from app.core.models import SyncConfig

    stmt = (
        update(SyncConfig)
        .where(SyncConfig.id == config_id)
        .values(
            last_sync_at=datetime.now(timezone.utc),
            last_sync_status=status,
        )
    )
    await session.execute(stmt)
    await session.flush()


async def _load_to_staging(
    session: AsyncSession,
    staging_table: str,
    rows: list[dict],
) -> None:
    """Load rows into a staging table using raw SQL.

    Creates the table if it doesn't exist, truncates, then inserts.
    """
    if not rows:
        return

    # Sanitize table name (alphanumeric and underscores only)
    safe_table = "".join(c for c in staging_table if c.isalnum() or c == "_")
    columns = list(rows[0].keys())
    safe_columns = ["".join(c for c in col if c.isalnum() or c == "_") for col in columns]

    # Create table with TEXT columns for staging
    col_defs = ", ".join(f'"{col}" TEXT' for col in safe_columns)
    create_sql = f'CREATE TABLE IF NOT EXISTS "{safe_table}" ({col_defs})'
    await session.execute(text(create_sql))

    # Truncate existing data
    await session.execute(text(f'DELETE FROM "{safe_table}"'))

    # Insert rows
    placeholders = ", ".join(f":col_{i}" for i in range(len(safe_columns)))
    col_names = ", ".join(f'"{col}"' for col in safe_columns)
    insert_sql = f'INSERT INTO "{safe_table}" ({col_names}) VALUES ({placeholders})'

    for row in rows:
        params = {f"col_{i}": str(row.get(col, "")) for i, col in enumerate(columns)}
        await session.execute(text(insert_sql), params)

    await session.flush()


# ---------------------------------------------------------------------------
# Beat scheduling
# ---------------------------------------------------------------------------


@celery_app.task
def schedule_all_batch_syncs() -> dict:
    """Query all active batch SyncConfigs and register them with Celery Beat."""
    import asyncio

    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(_schedule_all_async())
    finally:
        loop.close()


async def _schedule_all_async() -> dict:
    """Async implementation of batch schedule registration."""
    from app.core.models import SyncConfig

    async with _session_factory() as session:
        stmt = select(SyncConfig).where(
            SyncConfig.is_active.is_(True),
            SyncConfig.sync_mode == "batch",
        )
        result = await session.execute(stmt)
        configs = result.scalars().all()

        beat_schedule = {}
        for config in configs:
            if not config.cron_expression:
                continue

            try:
                cron_kwargs = _parse_cron(config.cron_expression)
            except ValueError:
                logger.warning(
                    "Invalid cron expression for SyncConfig %s: %s",
                    config.id,
                    config.cron_expression,
                )
                continue

            task_name = f"batch-sync-{config.id}"
            beat_schedule[task_name] = {
                "task": "app.sync.batch_scheduler.run_batch_sync",
                "schedule": crontab(**cron_kwargs),
                "args": [str(config.id)],
            }

        celery_app.conf.beat_schedule = beat_schedule
        logger.info("Registered %d batch sync schedules", len(beat_schedule))
        return {"scheduled": len(beat_schedule)}
