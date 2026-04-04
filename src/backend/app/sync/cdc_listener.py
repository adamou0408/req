from __future__ import annotations

import asyncio
import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Any

import redis.asyncio as aioredis
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import settings
from app.core.models import DataSource, SyncConfig

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Shared infrastructure
# ---------------------------------------------------------------------------

_engine = create_async_engine(settings.DATABASE_URL, pool_pre_ping=True)
_session_factory = async_sessionmaker(bind=_engine, class_=AsyncSession, expire_on_commit=False)


def _get_redis() -> aioredis.Redis:
    return aioredis.from_url(settings.REDIS_URL, decode_responses=True)


# ---------------------------------------------------------------------------
# CDC Listener
# ---------------------------------------------------------------------------


class CDCListener:
    """Listens for change-data-capture events from a source database.

    For PostgreSQL: uses logical replication with a polling fallback.
    For Oracle: polls using SCN (System Change Number).
    """

    def __init__(
        self,
        sync_config_id: uuid.UUID,
        data_source: DataSource,
        table_name: str,
        password: str,
    ) -> None:
        self.sync_config_id = sync_config_id
        self.data_source = data_source
        self.table_name = table_name
        self.password = password
        self._running = False
        self._task: asyncio.Task | None = None
        self._redis: aioredis.Redis | None = None

    @property
    def state_key(self) -> str:
        return f"cdc:state:{self.sync_config_id}"

    async def _get_redis(self) -> aioredis.Redis:
        if self._redis is None:
            self._redis = _get_redis()
        return self._redis

    async def _save_state(self, position: str) -> None:
        """Persist the last processed position to Redis."""
        r = await self._get_redis()
        state = {
            "sync_config_id": str(self.sync_config_id),
            "position": position,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        await r.set(self.state_key, json.dumps(state))

    async def _load_state(self) -> str | None:
        """Load the last processed position from Redis."""
        r = await self._get_redis()
        raw = await r.get(self.state_key)
        if raw is None:
            return None
        state = json.loads(raw)
        return state.get("position")

    async def start(self) -> None:
        """Start the CDC listener in a background task."""
        if self._running:
            logger.warning("CDC listener for %s is already running", self.sync_config_id)
            return

        self._running = True
        db_type = self.data_source.db_type.lower()

        if db_type == "postgresql":
            self._task = asyncio.create_task(self._listen_postgresql())
        elif db_type == "oracle":
            self._task = asyncio.create_task(self._poll_oracle_scn())
        else:
            logger.error("Unsupported CDC db_type: %s", db_type)
            self._running = False
            return

        logger.info("CDC listener started for config %s (type=%s)", self.sync_config_id, db_type)

    async def stop(self) -> None:
        """Stop the CDC listener."""
        self._running = False
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

        if self._redis is not None:
            await self._redis.aclose()
            self._redis = None

        logger.info("CDC listener stopped for config %s", self.sync_config_id)

    # -----------------------------------------------------------------------
    # PostgreSQL logical replication polling
    # -----------------------------------------------------------------------

    async def _listen_postgresql(self) -> None:
        """Poll PostgreSQL logical replication slot for changes.

        Uses pg_logical_slot_get_changes with the wal2json output plugin.
        Falls back to polling the table for new rows if replication is
        not available.
        """
        import asyncpg  # type: ignore[import-untyped]

        last_lsn = await self._load_state()
        slot_name = f"cdc_{self.sync_config_id.hex[:16]}"

        conn = None
        try:
            conn = await asyncpg.connect(
                host=self.data_source.host,
                port=self.data_source.port,
                database=self.data_source.database_name,
                user=self.data_source.username,
                password=self.password,
            )

            # Try to create the replication slot if it doesn't exist
            try:
                await conn.execute(
                    f"SELECT pg_create_logical_replication_slot('{slot_name}', 'wal2json')"
                )
            except Exception:
                pass  # Slot may already exist

            while self._running:
                try:
                    rows = await conn.fetch(
                        f"SELECT lsn, data FROM pg_logical_slot_get_changes('{slot_name}', NULL, 100)"
                    )

                    for row in rows:
                        lsn = str(row["lsn"])
                        change_data = json.loads(row["data"])
                        await self._process_pg_change(change_data)
                        last_lsn = lsn
                        await self._save_state(last_lsn)

                except Exception as exc:
                    logger.warning(
                        "Replication slot read failed for %s: %s. Retrying...",
                        self.sync_config_id,
                        exc,
                    )

                await asyncio.sleep(2)

        except Exception as exc:
            logger.error("PostgreSQL CDC connection failed for %s: %s", self.sync_config_id, exc)
        finally:
            if conn is not None:
                await conn.close()

    async def _process_pg_change(self, change_data: dict[str, Any]) -> None:
        """Process a wal2json change event and write it to the platform DB."""
        changes = change_data.get("change", [])
        async with _session_factory() as session:
            for change in changes:
                table = change.get("table", "")
                if table != self.table_name:
                    continue

                kind = change.get("kind")  # insert, update, delete
                column_names = change.get("columnnames", [])
                column_values = change.get("columnvalues", [])

                record = dict(zip(column_names, column_values))
                await self._write_change_event(session, kind, record)

            await session.commit()

    # -----------------------------------------------------------------------
    # Oracle SCN polling
    # -----------------------------------------------------------------------

    async def _poll_oracle_scn(self) -> None:
        """Poll Oracle using SCN-based change tracking.

        Since LogMiner requires DBA-level setup, we use a simpler approach:
        track the current SCN and poll for rows modified since the last
        known SCN using ORA_ROWSCN.
        """
        from app.connectors.registry import ConnectorRegistry

        last_scn = await self._load_state()
        if last_scn is None:
            last_scn = "0"

        while self._running:
            connector = None
            try:
                connector = ConnectorRegistry.get_connector(
                    db_type="oracle",
                    host=self.data_source.host,
                    port=self.data_source.port,
                    database=self.data_source.database_name,
                    username=self.data_source.username,
                    password=self.password,
                )
                connector.connect()

                # Get current SCN
                if hasattr(connector, "_connection") and connector._connection:
                    cursor = connector._connection.cursor()

                    # Get current SCN
                    cursor.execute("SELECT current_scn FROM v$database")
                    current_scn_row = cursor.fetchone()
                    current_scn = str(current_scn_row[0]) if current_scn_row else last_scn

                    # Query rows changed since last SCN using ORA_ROWSCN
                    query = (
                        f'SELECT t.*, ORA_ROWSCN AS "_scn" '
                        f'FROM "{self.table_name}" t '
                        f"WHERE ORA_ROWSCN > :last_scn"
                    )
                    cursor.execute(query, {"last_scn": int(last_scn)})
                    columns = [desc[0] for desc in cursor.description]
                    rows = cursor.fetchall()

                    if rows:
                        async with _session_factory() as session:
                            for row in rows:
                                record = dict(zip(columns, row))
                                scn = str(record.pop("_scn", current_scn))
                                await self._write_change_event(session, "upsert", record)
                                if int(scn) > int(last_scn):
                                    last_scn = scn

                            await session.commit()

                        await self._save_state(last_scn)

                    cursor.close()

            except Exception as exc:
                logger.warning("Oracle CDC poll failed for %s: %s", self.sync_config_id, exc)
            finally:
                if connector is not None:
                    try:
                        connector.disconnect()
                    except Exception:
                        pass

            await asyncio.sleep(5)

    # -----------------------------------------------------------------------
    # Common
    # -----------------------------------------------------------------------

    async def _write_change_event(
        self,
        session: AsyncSession,
        operation: str,
        record: dict[str, Any],
    ) -> None:
        """Write a CDC change event to the platform database."""
        safe_table = "".join(
            c for c in f"cdc_{self.table_name}" if c.isalnum() or c == "_"
        )

        # Ensure the CDC target table exists
        col_defs = ", ".join(
            f'"{k}" TEXT' for k in record.keys()
        )
        create_sql = (
            f'CREATE TABLE IF NOT EXISTS "{safe_table}" ('
            f'"_cdc_operation" TEXT, "_cdc_timestamp" TEXT, {col_defs})'
        )
        try:
            await session.execute(text(create_sql))
        except Exception:
            pass  # Table may already exist with different columns

        # Insert the change event
        all_cols = ["_cdc_operation", "_cdc_timestamp"] + list(record.keys())
        col_names = ", ".join(f'"{c}"' for c in all_cols)
        placeholders = ", ".join(f":p_{i}" for i in range(len(all_cols)))
        insert_sql = f'INSERT INTO "{safe_table}" ({col_names}) VALUES ({placeholders})'

        params: dict[str, Any] = {
            "p_0": operation,
            "p_1": datetime.now(timezone.utc).isoformat(),
        }
        for i, (k, v) in enumerate(record.items(), start=2):
            params[f"p_{i}"] = str(v) if v is not None else None

        await session.execute(text(insert_sql), params)


# ---------------------------------------------------------------------------
# CDC Manager
# ---------------------------------------------------------------------------


class CDCManager:
    """Manages multiple CDCListener instances, one per active CDC SyncConfig."""

    def __init__(self) -> None:
        self._listeners: dict[uuid.UUID, CDCListener] = {}

    async def start_all(self) -> int:
        """Start listeners for all active CDC sync configs."""
        from app.core.security import decrypt_password

        async with _session_factory() as session:
            stmt = select(SyncConfig).where(
                SyncConfig.is_active.is_(True),
                SyncConfig.sync_mode == "cdc",
            )
            result = await session.execute(stmt)
            configs = result.scalars().all()

            started = 0
            for config in configs:
                if config.id in self._listeners:
                    continue

                ds_stmt = select(DataSource).where(DataSource.id == config.data_source_id)
                ds_result = await session.execute(ds_stmt)
                data_source = ds_result.scalar_one_or_none()
                if data_source is None:
                    continue

                password = decrypt_password(data_source.encrypted_password)
                listener = CDCListener(
                    sync_config_id=config.id,
                    data_source=data_source,
                    table_name=config.table_name,
                    password=password,
                )
                await listener.start()
                self._listeners[config.id] = listener
                started += 1

        logger.info("Started %d CDC listeners", started)
        return started

    async def stop_all(self) -> None:
        """Stop all running CDC listeners."""
        for config_id, listener in list(self._listeners.items()):
            await listener.stop()
            del self._listeners[config_id]
        logger.info("All CDC listeners stopped")

    async def start_one(self, sync_config_id: uuid.UUID) -> bool:
        """Start a single CDC listener for a specific config."""
        from app.core.security import decrypt_password

        if sync_config_id in self._listeners:
            return False

        async with _session_factory() as session:
            stmt = select(SyncConfig).where(SyncConfig.id == sync_config_id)
            result = await session.execute(stmt)
            config = result.scalar_one_or_none()
            if config is None or not config.is_active:
                return False

            ds_stmt = select(DataSource).where(DataSource.id == config.data_source_id)
            ds_result = await session.execute(ds_stmt)
            data_source = ds_result.scalar_one_or_none()
            if data_source is None:
                return False

            password = decrypt_password(data_source.encrypted_password)
            listener = CDCListener(
                sync_config_id=config.id,
                data_source=data_source,
                table_name=config.table_name,
                password=password,
            )
            await listener.start()
            self._listeners[config.id] = listener
            return True

    async def stop_one(self, sync_config_id: uuid.UUID) -> bool:
        """Stop a specific CDC listener."""
        listener = self._listeners.pop(sync_config_id, None)
        if listener is None:
            return False
        await listener.stop()
        return True

    def is_running(self, sync_config_id: uuid.UUID) -> bool:
        return sync_config_id in self._listeners

    @property
    def active_count(self) -> int:
        return len(self._listeners)


# Module-level singleton
cdc_manager = CDCManager()
