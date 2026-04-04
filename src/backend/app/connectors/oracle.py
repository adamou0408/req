from __future__ import annotations

import logging
from typing import Any

from app.connectors.base import ColumnInfo, DBConnector, FunctionInfo, TableInfo

logger = logging.getLogger(__name__)


class OracleConnector(DBConnector):
    """Connector for Oracle databases using cx_Oracle."""

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._conn: Any = None

    # ------------------------------------------------------------------
    # Connection lifecycle
    # ------------------------------------------------------------------

    def connect(self) -> bool:
        try:
            import cx_Oracle  # type: ignore[import-untyped]

            dsn = cx_Oracle.makedsn(self.host, self.port, service_name=self.database)
            self._conn = cx_Oracle.connect(user=self.username, password=self.password, dsn=dsn)
            return True
        except Exception:
            logger.exception("Oracle connection failed (%s:%s/%s)", self.host, self.port, self.database)
            return False

    def disconnect(self) -> None:
        if self._conn is not None:
            try:
                self._conn.close()
            except Exception:
                logger.exception("Error closing Oracle connection")
            finally:
                self._conn = None

    def test_connection(self) -> dict[str, Any]:
        try:
            if not self.connect():
                return {"success": False, "message": "Connection failed", "server_version": None}
            cursor = self._conn.cursor()
            cursor.execute("SELECT banner FROM v$version WHERE ROWNUM = 1")
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
        cursor = self._conn.cursor()
        owner_filter = schema.upper() if schema else self.username.upper()
        cursor.execute(
            "SELECT table_name, owner, num_rows FROM all_tables WHERE owner = :o ORDER BY table_name",
            {"o": owner_filter},
        )
        tables = [
            TableInfo(name=row[0], schema=row[1], row_count_estimate=row[2])
            for row in cursor.fetchall()
        ]
        cursor.close()
        return tables

    def list_columns(self, table_name: str, schema: str | None = None) -> list[ColumnInfo]:
        self._ensure_connected()
        cursor = self._conn.cursor()
        owner_filter = schema.upper() if schema else self.username.upper()

        # Primary keys
        cursor.execute(
            """
            SELECT cols.column_name
            FROM all_constraints cons
            JOIN all_cons_columns cols ON cons.constraint_name = cols.constraint_name
                AND cons.owner = cols.owner
            WHERE cons.constraint_type = 'P'
              AND cons.owner = :o
              AND cons.table_name = :t
            """,
            {"o": owner_filter, "t": table_name.upper()},
        )
        pk_cols = {row[0] for row in cursor.fetchall()}

        # Foreign keys
        cursor.execute(
            """
            SELECT cols.column_name
            FROM all_constraints cons
            JOIN all_cons_columns cols ON cons.constraint_name = cols.constraint_name
                AND cons.owner = cols.owner
            WHERE cons.constraint_type = 'R'
              AND cons.owner = :o
              AND cons.table_name = :t
            """,
            {"o": owner_filter, "t": table_name.upper()},
        )
        fk_cols = {row[0] for row in cursor.fetchall()}

        cursor.execute(
            """
            SELECT column_name, data_type, nullable
            FROM all_tab_columns
            WHERE owner = :o AND table_name = :t
            ORDER BY column_id
            """,
            {"o": owner_filter, "t": table_name.upper()},
        )
        columns = [
            ColumnInfo(
                name=row[0],
                data_type=row[1],
                nullable=row[2] == "Y",
                is_pk=row[0] in pk_cols,
                is_fk=row[0] in fk_cols,
            )
            for row in cursor.fetchall()
        ]
        cursor.close()
        return columns

    def list_functions(self, schema: str | None = None) -> list[FunctionInfo]:
        self._ensure_connected()
        cursor = self._conn.cursor()
        owner_filter = schema.upper() if schema else self.username.upper()
        cursor.execute(
            """
            SELECT object_name, owner, object_type
            FROM all_procedures
            WHERE owner = :o AND object_type IN ('FUNCTION', 'PROCEDURE')
            ORDER BY object_name
            """,
            {"o": owner_filter},
        )
        functions = [
            FunctionInfo(name=row[0], schema=row[1], return_type=row[2])
            for row in cursor.fetchall()
        ]
        cursor.close()
        return functions

    def preview_data(self, table_name: str, schema: str | None = None, limit: int = 10) -> list[dict[str, Any]]:
        self._ensure_connected()
        cursor = self._conn.cursor()
        owner = schema.upper() if schema else self.username.upper()
        qualified = f'"{owner}"."{table_name.upper()}"'
        cursor.execute(f"SELECT * FROM {qualified} WHERE ROWNUM <= :lim", {"lim": limit})
        col_names = [desc[0] for desc in cursor.description]
        rows = [dict(zip(col_names, row)) for row in cursor.fetchall()]
        cursor.close()
        return rows

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _ensure_connected(self) -> None:
        if self._conn is None:
            if not self.connect():
                raise RuntimeError("Cannot connect to Oracle database")
