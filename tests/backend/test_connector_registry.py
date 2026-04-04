from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock

import pytest

from app.connectors.base import ColumnInfo, DBConnector, FunctionInfo, TableInfo
from app.connectors.postgresql import PostgreSQLConnector
from app.connectors.registry import ConnectorRegistry


class TestConnectorRegistry:
    """Tests for ConnectorRegistry."""

    def test_list_supported_types(self) -> None:
        types = ConnectorRegistry.list_supported_types()
        assert "oracle" in types
        assert "postgresql" in types

    def test_list_supported_types_sorted(self) -> None:
        types = ConnectorRegistry.list_supported_types()
        assert types == sorted(types)

    def test_get_postgresql_connector(self) -> None:
        connector = ConnectorRegistry.get_connector(
            "postgresql",
            host="localhost",
            port=5432,
            database="testdb",
            username="user",
            password="pass",
        )
        assert isinstance(connector, PostgreSQLConnector)
        assert connector.host == "localhost"
        assert connector.port == 5432

    def test_get_connector_case_insensitive(self) -> None:
        connector = ConnectorRegistry.get_connector(
            "PostgreSQL",
            host="localhost",
            port=5432,
            database="testdb",
            username="user",
            password="pass",
        )
        assert isinstance(connector, PostgreSQLConnector)

    def test_unknown_db_type_raises(self) -> None:
        with pytest.raises(ValueError, match="Unsupported database type"):
            ConnectorRegistry.get_connector(
                "unknown_db",
                host="localhost",
                port=1234,
                database="db",
                username="u",
                password="p",
            )

    def test_register_custom_connector(self) -> None:
        """Register a mock connector and verify it becomes available."""

        class MockConnector(DBConnector):
            def connect(self) -> bool:
                return True

            def disconnect(self) -> None:
                pass

            def test_connection(self) -> dict[str, Any]:
                return {"success": True, "message": "OK", "server_version": "mock"}

            def list_tables(self, schema: str | None = None) -> list[TableInfo]:
                return []

            def list_columns(self, table_name: str, schema: str | None = None) -> list[ColumnInfo]:
                return []

            def list_functions(self, schema: str | None = None) -> list[FunctionInfo]:
                return []

            def preview_data(self, table_name: str, schema: str | None = None, limit: int = 10) -> list[dict[str, Any]]:
                return []

        ConnectorRegistry.register("mockdb", MockConnector)
        try:
            assert "mockdb" in ConnectorRegistry.list_supported_types()
            connector = ConnectorRegistry.get_connector(
                "mockdb",
                host="h",
                port=0,
                database="d",
                username="u",
                password="p",
            )
            assert isinstance(connector, MockConnector)
            assert connector.connect() is True
        finally:
            # Clean up so other tests are not affected
            ConnectorRegistry._registry.pop("mockdb", None)
