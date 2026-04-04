from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any


@dataclass
class TableInfo:
    name: str
    schema: str | None = None
    row_count_estimate: int | None = None
    comment: str | None = None


@dataclass
class ColumnInfo:
    name: str
    data_type: str
    nullable: bool = True
    is_pk: bool = False
    is_fk: bool = False
    comment: str | None = None


@dataclass
class FunctionInfo:
    name: str
    schema: str | None = None
    parameters: str | None = None
    return_type: str | None = None


class DBConnector(ABC):
    """Abstract base class for database connectors used to explore external databases."""

    def __init__(self, host: str, port: int, database: str, username: str, password: str, **kwargs: Any) -> None:
        self.host = host
        self.port = port
        self.database = database
        self.username = username
        self.password = password
        self.extra = kwargs

    @abstractmethod
    def connect(self) -> bool:
        """Establish a connection. Return ``True`` on success."""

    @abstractmethod
    def disconnect(self) -> None:
        """Close the connection."""

    @abstractmethod
    def test_connection(self) -> dict[str, Any]:
        """Test connectivity and return ``{success, message, server_version}``."""

    @abstractmethod
    def list_tables(self, schema: str | None = None) -> list[TableInfo]:
        """List tables in the database or a specific schema."""

    @abstractmethod
    def list_columns(self, table_name: str, schema: str | None = None) -> list[ColumnInfo]:
        """List columns for a given table."""

    @abstractmethod
    def list_functions(self, schema: str | None = None) -> list[FunctionInfo]:
        """List stored functions / procedures."""

    @abstractmethod
    def preview_data(self, table_name: str, schema: str | None = None, limit: int = 10) -> list[dict[str, Any]]:
        """Return a sample of rows from the table."""
