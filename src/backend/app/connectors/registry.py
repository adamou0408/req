from __future__ import annotations

from typing import Any, Type

from app.connectors.base import DBConnector


class ConnectorRegistry:
    """Registry mapping database type strings to connector classes."""

    _registry: dict[str, Type[DBConnector]] = {}

    @classmethod
    def register(cls, db_type: str, connector_class: Type[DBConnector]) -> None:
        cls._registry[db_type.lower()] = connector_class

    @classmethod
    def get_connector(cls, db_type: str, **connection_params: Any) -> DBConnector:
        """Instantiate and return a connector for the given *db_type*."""
        key = db_type.lower()
        if key not in cls._registry:
            raise ValueError(f"Unsupported database type: '{db_type}'. Supported: {cls.list_supported_types()}")
        return cls._registry[key](**connection_params)

    @classmethod
    def list_supported_types(cls) -> list[str]:
        return sorted(cls._registry.keys())


# Pre-register built-in connectors
def _bootstrap() -> None:
    from app.connectors.oracle import OracleConnector
    from app.connectors.postgresql import PostgreSQLConnector

    ConnectorRegistry.register("oracle", OracleConnector)
    ConnectorRegistry.register("postgresql", PostgreSQLConnector)


_bootstrap()
