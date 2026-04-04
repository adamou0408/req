from __future__ import annotations

import logging
from typing import Any

from app.connectors.base import ColumnInfo, DBConnector, FunctionInfo, TableInfo

logger = logging.getLogger(__name__)


class PostgreSQLConnector(DBConnector):
    """Connector for PostgreSQL databases using psycopg (sync)."""

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._conn: Any = None

    # ------------------------------------------------------------------
    # Connection lifecycle
    # ------------------------------------------------------------------

    def connect(self) -> bool:
        try:
            import psycopg  # type: ignore[import-untyped]

            self._conn = psycopg.connect(
                host=self.host,
                port=self.port,
                dbname=self.database,
                user=self.username,
                password=self.password,
                autocommit=True,
            )
            return True
        except Exception:
            logger.exception("PostgreSQL connection failed (%s:%s/%s)", self.host, self.port, self.database)
            return False

    def disconnect(self) -> None:
        if self._conn is not None:
            try:
                self._conn.close()
            except Exception:
                logger.exception("Error closing PostgreSQL connection")
            finally:
                self._conn = None

    def test_connection(self) -> dict[str, Any]:
        try:
            if not self.connect():
                return {"success": False, "message": "Connection failed", "server_version": None}
            cursor = self._conn.cursor()
            cursor.execute("SELECT version()")
            row = cursor.fetchone()
            version = row[0] if row else "unknown"
            cursor.close()
            self.disconnect()
            return {"success": True, "message": "OK", "server_version": version}
        except Exception as exc:
            return {"success": False, "message": str(exc), "server_version": None}

    # ------------------------------------------------------------------
    # Schema introspection
    # ------------------------------------------------------------------

    def list_tables(self, schema: str | None = None) -> list[TableInfo]:
        self._ensure_connected()
        schema = schema or "public"
        cursor = self._conn.cursor()
        cursor.execute(
            """
            SELECT t.table_name,
                   t.table_schema,
                   s.n_live_tup AS row_estimate,
                   obj_description(c.oid) AS comment
            FROM information_schema.tables t
            LEFT JOIN pg_stat_user_tables s
                ON s.relname = t.table_name AND s.schemaname = t.table_schema
            LEFT JOIN pg_class c
                ON c.relname = t.table_name
            LEFT JOIN pg_namespace n
                ON n.oid = c.relnamespace AND n.nspname = t.table_schema
            WHERE t.table_schema = %s AND t.table_type = 'BASE TABLE'
            ORDER BY t.table_name
            """,
            (schema,),
        )
        tables = [
            TableInfo(
                name=row[0],
                schema=row[1],
                row_count_estimate=row[2],
                comment=row[3],
            )
            for row in cursor.fetchall()
        ]
        cursor.close()
        return tables

    def list_columns(self, table_name: str, schema: str | None = None) -> list[ColumnInfo]:
        self._ensure_connected()
        schema = schema or "public"
        cursor = self._conn.cursor()

        # Primary key columns
        cursor.execute(
            """
            SELECT kcu.column_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
                ON tc.constraint_name = kcu.constraint_name
                AND tc.table_schema = kcu.table_schema
            WHERE tc.constraint_type = 'PRIMARY KEY'
              AND tc.table_schema = %s
              AND tc.table_name = %s
            """,
            (schema, table_name),
        )
        pk_cols = {row[0] for row in cursor.fetchall()}

        # Foreign key columns
        cursor.execute(
            """
            SELECT kcu.column_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
                ON tc.constraint_name = kcu.constraint_name
                AND tc.table_schema = kcu.table_schema
            WHERE tc.constraint_type = 'FOREIGN KEY'
              AND tc.table_schema = %s
              AND tc.table_name = %s
            """,
            (schema, table_name),
        )
        fk_cols = {row[0] for row in cursor.fetchall()}

        cursor.execute(
            """
            SELECT column_name, data_type, is_nullable,
                   col_description(
                       (SELECT oid FROM pg_class WHERE relname = %s), ordinal_position
                   ) AS comment
            FROM information_schema.columns
            WHERE table_schema = %s AND table_name = %s
            ORDER BY ordinal_position
            """,
            (table_name, schema, table_name),
        )
        columns = [
            ColumnInfo(
                name=row[0],
                data_type=row[1],
                nullable=row[2] == "YES",
                is_pk=row[0] in pk_cols,
                is_fk=row[0] in fk_cols,
                comment=row[3],
            )
            for row in cursor.fetchall()
        ]
        cursor.close()
        return columns

    def list_functions(self, schema: str | None = None) -> list[FunctionInfo]:
        self._ensure_connected()
        schema = schema or "public"
        cursor = self._conn.cursor()
        cursor.execute(
            """
            SELECT routine_name, routine_schema,
                   pg_get_function_arguments(p.oid) AS parameters,
                   data_type AS return_type
            FROM information_schema.routines r
            LEFT JOIN pg_proc p ON p.proname = r.routine_name
            LEFT JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = r.routine_schema
            WHERE r.routine_schema = %s
            ORDER BY r.routine_name
            """,
            (schema,),
        )
        functions = [
            FunctionInfo(name=row[0], schema=row[1], parameters=row[2], return_type=row[3])
            for row in cursor.fetchall()
        ]
        cursor.close()
        return functions

    def preview_data(self, table_name: str, schema: str | None = None, limit: int = 10) -> list[dict[str, Any]]:
        self._ensure_connected()
        schema = schema or "public"
        cursor = self._conn.cursor()
        # Use identifier quoting to prevent SQL injection
        qualified = f'"{schema}"."{table_name}"'
        cursor.execute(f"SELECT * FROM {qualified} LIMIT %s", (limit,))
        col_names = [desc.name for desc in cursor.description]
        rows = [dict(zip(col_names, row)) for row in cursor.fetchall()]
        cursor.close()
        return rows

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _ensure_connected(self) -> None:
        if self._conn is None:
            if not self.connect():
                raise RuntimeError("Cannot connect to PostgreSQL database")
