from __future__ import annotations

import ast
import logging
import operator
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.models import FieldMapping

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Safe expression evaluation
# ---------------------------------------------------------------------------

_SAFE_OPERATORS: dict[type, Any] = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.FloorDiv: operator.floordiv,
    ast.Mod: operator.mod,
    ast.Pow: operator.pow,
    ast.USub: operator.neg,
    ast.UAdd: operator.pos,
}

_SAFE_FUNCTIONS: dict[str, Any] = {
    "int": int,
    "float": float,
    "str": str,
    "bool": bool,
    "abs": abs,
    "round": round,
    "len": len,
    "min": min,
    "max": max,
    "upper": str.upper,
    "lower": str.lower,
    "strip": str.strip,
}


def _safe_eval_node(node: ast.AST, variables: dict[str, Any]) -> Any:
    """Recursively evaluate an AST node with a strict whitelist."""
    if isinstance(node, ast.Expression):
        return _safe_eval_node(node.body, variables)
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.Name):
        if node.id in variables:
            return variables[node.id]
        if node.id in _SAFE_FUNCTIONS:
            return _SAFE_FUNCTIONS[node.id]
        raise ValueError(f"Name '{node.id}' is not allowed")
    if isinstance(node, ast.BinOp):
        op_type = type(node.op)
        if op_type not in _SAFE_OPERATORS:
            raise ValueError(f"Operator {op_type.__name__} is not allowed")
        left = _safe_eval_node(node.left, variables)
        right = _safe_eval_node(node.right, variables)
        return _SAFE_OPERATORS[op_type](left, right)
    if isinstance(node, ast.UnaryOp):
        op_type = type(node.op)
        if op_type not in _SAFE_OPERATORS:
            raise ValueError(f"Unary operator {op_type.__name__} is not allowed")
        operand = _safe_eval_node(node.operand, variables)
        return _SAFE_OPERATORS[op_type](operand)
    if isinstance(node, ast.Call):
        func_obj = _safe_eval_node(node.func, variables)
        if func_obj not in _SAFE_FUNCTIONS.values():
            raise ValueError("Function call not allowed")
        args = [_safe_eval_node(a, variables) for a in node.args]
        return func_obj(*args)
    if isinstance(node, ast.IfExp):
        test = _safe_eval_node(node.test, variables)
        return (
            _safe_eval_node(node.body, variables)
            if test
            else _safe_eval_node(node.orelse, variables)
        )
    if isinstance(node, ast.Compare):
        left = _safe_eval_node(node.left, variables)
        for op, comparator in zip(node.ops, node.comparators):
            right = _safe_eval_node(comparator, variables)
            if isinstance(op, ast.Eq):
                result = left == right
            elif isinstance(op, ast.NotEq):
                result = left != right
            elif isinstance(op, ast.Lt):
                result = left < right
            elif isinstance(op, ast.LtE):
                result = left <= right
            elif isinstance(op, ast.Gt):
                result = left > right
            elif isinstance(op, ast.GtE):
                result = left >= right
            else:
                raise ValueError(f"Comparison {type(op).__name__} not allowed")
            if not result:
                return False
            left = right
        return True
    raise ValueError(f"AST node type {type(node).__name__} is not allowed")


def safe_eval(expression: str, variables: dict[str, Any]) -> Any:
    """Evaluate a simple Python expression with whitelisted operations only."""
    tree = ast.parse(expression, mode="eval")
    return _safe_eval_node(tree, variables)


# ---------------------------------------------------------------------------
# Transform helpers
# ---------------------------------------------------------------------------

_TYPE_CAST_MAP: dict[str, type] = {
    "int": int,
    "float": float,
    "str": str,
    "bool": bool,
}


def _apply_transform(value: Any, rule: dict[str, Any], full_row: dict[str, Any]) -> Any:
    """Apply a single transform rule to a value."""
    rule_type = rule.get("type")

    if rule_type == "type_cast":
        target_type = rule.get("target")
        cast_fn = _TYPE_CAST_MAP.get(target_type)  # type: ignore[arg-type]
        if cast_fn is None:
            raise ValueError(f"Unknown type_cast target: {target_type}")
        if value is None:
            return None
        return cast_fn(value)

    if rule_type == "value_map":
        mapping = rule.get("mapping", {})
        default = rule.get("default", value)
        str_value = str(value) if value is not None else None
        return mapping.get(str_value, default)

    if rule_type == "rename":
        # Rename is handled at the field level, value passes through
        return value

    if rule_type == "expression":
        expr = rule.get("expr", "")
        variables = {"value": value, "row": full_row}
        return safe_eval(expr, variables)

    if rule_type == "default":
        default_value = rule.get("value")
        return default_value if value is None else value

    raise ValueError(f"Unknown transform rule type: {rule_type}")


# ---------------------------------------------------------------------------
# FieldMappingService
# ---------------------------------------------------------------------------


class FieldMappingService:
    """Service for creating, applying, and managing versioned field mappings."""

    @staticmethod
    async def create_mapping(
        name: str,
        source_ds_id: uuid.UUID,
        source_table: str,
        mappings: list[dict[str, Any]],
        db: AsyncSession,
    ) -> list[FieldMapping]:
        """Create a new field mapping (version 1).

        Each entry in *mappings* should have:
            - source_field: str
            - target_field: str
            - transform_rule: dict | None
        """
        created: list[FieldMapping] = []
        for m in mappings:
            fm = FieldMapping(
                name=name,
                version=1,
                source_datasource_id=source_ds_id,
                source_table=source_table,
                source_field=m["source_field"],
                target_field=m["target_field"],
                transform_rule=m.get("transform_rule"),
            )
            db.add(fm)
            created.append(fm)

        await db.flush()
        for fm in created:
            await db.refresh(fm)
        return created

    @staticmethod
    async def update_mapping(
        name: str,
        source_ds_id: uuid.UUID,
        source_table: str,
        mappings: list[dict[str, Any]],
        db: AsyncSession,
    ) -> list[FieldMapping]:
        """Create a new version of an existing mapping."""
        # Determine next version
        stmt = (
            select(func.max(FieldMapping.version))
            .where(FieldMapping.name == name)
        )
        result = await db.execute(stmt)
        max_version = result.scalar() or 0
        new_version = max_version + 1

        created: list[FieldMapping] = []
        for m in mappings:
            fm = FieldMapping(
                name=name,
                version=new_version,
                source_datasource_id=source_ds_id,
                source_table=source_table,
                source_field=m["source_field"],
                target_field=m["target_field"],
                transform_rule=m.get("transform_rule"),
            )
            db.add(fm)
            created.append(fm)

        await db.flush()
        for fm in created:
            await db.refresh(fm)
        return created

    @staticmethod
    async def get_mapping_by_id(
        mapping_id: uuid.UUID,
        db: AsyncSession,
    ) -> FieldMapping | None:
        """Get a single field mapping by ID."""
        stmt = select(FieldMapping).where(FieldMapping.id == mapping_id)
        result = await db.execute(stmt)
        return result.scalar_one_or_none()

    @staticmethod
    async def get_latest_mappings(
        name: str,
        db: AsyncSession,
    ) -> list[FieldMapping]:
        """Get all field mapping rows for the latest version of *name*."""
        version_stmt = (
            select(func.max(FieldMapping.version))
            .where(FieldMapping.name == name)
        )
        version_result = await db.execute(version_stmt)
        max_version = version_result.scalar()
        if max_version is None:
            return []

        stmt = (
            select(FieldMapping)
            .where(FieldMapping.name == name, FieldMapping.version == max_version)
            .order_by(FieldMapping.source_field)
        )
        result = await db.execute(stmt)
        return list(result.scalars().all())

    @staticmethod
    async def get_mapping_history(
        name: str,
        db: AsyncSession,
    ) -> list[dict[str, Any]]:
        """Return all versions of a named mapping with metadata."""
        stmt = (
            select(
                FieldMapping.version,
                func.count(FieldMapping.id).label("field_count"),
                func.min(FieldMapping.created_at).label("created_at"),
            )
            .where(FieldMapping.name == name)
            .group_by(FieldMapping.version)
            .order_by(FieldMapping.version.desc())
        )
        result = await db.execute(stmt)
        rows = result.all()
        return [
            {
                "name": name,
                "version": row.version,
                "field_count": row.field_count,
                "created_at": row.created_at.isoformat() if row.created_at else None,
            }
            for row in rows
        ]

    @staticmethod
    async def rollback_mapping(
        name: str,
        version: int,
        db: AsyncSession,
    ) -> list[FieldMapping]:
        """Rollback a mapping to a specific version by creating a new version
        with the same field definitions as the target version.
        """
        # Load the target version
        stmt = (
            select(FieldMapping)
            .where(FieldMapping.name == name, FieldMapping.version == version)
        )
        result = await db.execute(stmt)
        source_rows = list(result.scalars().all())
        if not source_rows:
            raise ValueError(f"No mapping '{name}' version {version} found")

        # Determine next version
        max_stmt = select(func.max(FieldMapping.version)).where(FieldMapping.name == name)
        max_result = await db.execute(max_stmt)
        max_version = max_result.scalar() or 0
        new_version = max_version + 1

        created: list[FieldMapping] = []
        for src in source_rows:
            fm = FieldMapping(
                name=name,
                version=new_version,
                source_datasource_id=src.source_datasource_id,
                source_table=src.source_table,
                source_field=src.source_field,
                target_field=src.target_field,
                transform_rule=src.transform_rule,
            )
            db.add(fm)
            created.append(fm)

        await db.flush()
        for fm in created:
            await db.refresh(fm)
        return created

    @staticmethod
    def apply_mapping(
        mappings: list[FieldMapping],
        source_data: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """Apply field mappings to a list of source rows and return transformed rows."""
        result: list[dict[str, Any]] = []

        for row in source_data:
            transformed: dict[str, Any] = {}
            for fm in mappings:
                value = row.get(fm.source_field)
                if fm.transform_rule:
                    value = _apply_transform(value, fm.transform_rule, row)
                transformed[fm.target_field] = value
            result.append(transformed)

        return result

    @staticmethod
    async def list_all(db: AsyncSession) -> list[dict[str, Any]]:
        """List all mapping names with their latest version info."""
        stmt = (
            select(
                FieldMapping.name,
                func.max(FieldMapping.version).label("latest_version"),
                func.count(FieldMapping.id).label("total_entries"),
            )
            .group_by(FieldMapping.name)
            .order_by(FieldMapping.name)
        )
        result = await db.execute(stmt)
        rows = result.all()
        return [
            {
                "name": row.name,
                "latest_version": row.latest_version,
                "total_entries": row.total_entries,
            }
            for row in rows
        ]
