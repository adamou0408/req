from __future__ import annotations

import logging
import re
import uuid
from typing import Any, Optional

from sqlalchemy import inspect, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.etl.models import BiReport

logger = logging.getLogger(__name__)

# Tables that are allowed for BI queries (platform DB only)
SAFE_TABLE_RE = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*$")
ALLOWED_AGGREGATIONS = {"SUM", "AVG", "COUNT", "MAX", "MIN"}
ALLOWED_OPERATORS = {"=", "!=", ">", "<", ">=", "<=", "LIKE", "IN", "NOT IN"}
MAX_ROWS = 100_000
QUERY_TIMEOUT_SECONDS = 30


class BiReportService:
    """Service layer for BI report management."""

    @staticmethod
    async def create_report(
        *,
        name: str,
        source_table: str,
        chart_type: str,
        config: dict[str, Any] | None = None,
        user_id: uuid.UUID,
        db: AsyncSession,
    ) -> BiReport:
        report = BiReport(
            name=name,
            source_table=source_table,
            chart_type=chart_type,
            config=config,
            created_by=user_id,
        )
        db.add(report)
        await db.flush()
        await db.refresh(report)
        return report

    @staticmethod
    async def update_report(
        report_id: uuid.UUID,
        updates: dict[str, Any],
        db: AsyncSession,
    ) -> BiReport | None:
        stmt = select(BiReport).where(BiReport.id == report_id)
        result = await db.execute(stmt)
        report = result.scalar_one_or_none()
        if report is None:
            return None
        allowed = {"name", "description", "source_table", "chart_type", "config"}
        for key, value in updates.items():
            if key in allowed:
                setattr(report, key, value)
        await db.flush()
        await db.refresh(report)
        return report

    @staticmethod
    async def delete_report(
        report_id: uuid.UUID,
        db: AsyncSession,
    ) -> bool:
        stmt = select(BiReport).where(BiReport.id == report_id)
        result = await db.execute(stmt)
        report = result.scalar_one_or_none()
        if report is None:
            return False
        await db.delete(report)
        await db.flush()
        return True

    @staticmethod
    def build_query(report: BiReport) -> tuple[str, dict[str, Any]]:
        """Build a SELECT SQL string from the report config.

        Returns (sql_string, params_dict).
        Only queries platform DB tables, never external sources.
        """
        config = report.config or {}
        table = report.source_table

        if not SAFE_TABLE_RE.match(table):
            raise ValueError(f"Invalid table name: {table}")

        x_axis = config.get("x_axis", "*")
        y_axis = config.get("y_axis")
        aggregation = config.get("aggregation", "").upper()
        group_by = config.get("group_by")
        filters = config.get("filters", [])
        sort = config.get("sort")
        sort_order = config.get("sort_order", "ASC").upper()
        limit = min(config.get("limit", 1000), MAX_ROWS)

        # Build SELECT columns
        select_parts = []
        if x_axis and x_axis != "*":
            select_parts.append(f'"{x_axis}"')
        if y_axis:
            if aggregation and aggregation in ALLOWED_AGGREGATIONS:
                select_parts.append(f'{aggregation}("{y_axis}") AS "{y_axis}"')
            else:
                select_parts.append(f'"{y_axis}"')

        if not select_parts:
            select_parts = ["*"]

        sql = f'SELECT {", ".join(select_parts)} FROM "{table}"'

        # WHERE clauses
        params: dict[str, Any] = {}
        if filters:
            where_parts = []
            for i, f in enumerate(filters):
                col = f.get("column", "")
                op = f.get("operator", "=")
                val = f.get("value")
                if not SAFE_TABLE_RE.match(col):
                    continue
                if op not in ALLOWED_OPERATORS:
                    continue
                param_key = f"p_{i}"
                where_parts.append(f'"{col}" {op} :{param_key}')
                params[param_key] = val
            if where_parts:
                sql += " WHERE " + " AND ".join(where_parts)

        # GROUP BY
        if group_by and SAFE_TABLE_RE.match(group_by):
            if group_by not in [x_axis]:
                select_parts_final = [f'"{group_by}"'] + select_parts
                sql = sql.replace(
                    f'SELECT {", ".join(select_parts)}',
                    f'SELECT {", ".join(select_parts_final)}',
                )
            sql += f' GROUP BY "{group_by}"'
            if x_axis and x_axis != "*" and x_axis != group_by:
                sql += f', "{x_axis}"'

        # ORDER BY
        if sort and SAFE_TABLE_RE.match(sort):
            order = sort_order if sort_order in ("ASC", "DESC") else "ASC"
            sql += f' ORDER BY "{sort}" {order}'

        # LIMIT
        sql += f" LIMIT {limit}"

        return sql, params

    @staticmethod
    async def execute_query(
        report_id: uuid.UUID,
        db: AsyncSession,
    ) -> dict[str, Any]:
        """Run the BI query against the platform DB and return results."""
        stmt = select(BiReport).where(BiReport.id == report_id)
        result = await db.execute(stmt)
        report = result.scalar_one_or_none()
        if report is None:
            return {"error": "Report not found"}

        try:
            sql, params = BiReportService.build_query(report)
        except ValueError as e:
            return {"error": str(e)}

        try:
            result = await db.execute(
                text(sql).execution_options(timeout=QUERY_TIMEOUT_SECONDS),
                params,
            )
            rows = result.mappings().all()
            data = [dict(row) for row in rows]
            return {
                "columns": list(rows[0].keys()) if rows else [],
                "data": data,
                "row_count": len(data),
                "sql_preview": sql,
            }
        except Exception as e:
            logger.exception("BI query failed for report %s", report_id)
            return {"error": str(e)}

    @staticmethod
    async def list_reports(
        db: AsyncSession,
        user_id: uuid.UUID | None = None,
        include_shared: bool = True,
    ) -> list[BiReport]:
        conditions = []
        if user_id is not None:
            if include_shared:
                conditions.append(
                    (BiReport.created_by == user_id)
                    | (
                        (BiReport.is_shared.is_(True))
                        & (BiReport.share_approved.is_(True))
                    )
                )
            else:
                conditions.append(BiReport.created_by == user_id)

        stmt = select(BiReport)
        for cond in conditions:
            stmt = stmt.where(cond)
        stmt = stmt.order_by(BiReport.created_at.desc())
        result = await db.execute(stmt)
        return list(result.scalars().all())

    @staticmethod
    async def share_report(
        report_id: uuid.UUID,
        db: AsyncSession,
    ) -> BiReport | None:
        stmt = select(BiReport).where(BiReport.id == report_id)
        result = await db.execute(stmt)
        report = result.scalar_one_or_none()
        if report is None:
            return None
        report.is_shared = True
        report.share_approved = False
        await db.flush()
        await db.refresh(report)
        return report

    @staticmethod
    async def approve_share(
        report_id: uuid.UUID,
        approver_id: uuid.UUID,
        db: AsyncSession,
    ) -> BiReport | None:
        stmt = select(BiReport).where(BiReport.id == report_id)
        result = await db.execute(stmt)
        report = result.scalar_one_or_none()
        if report is None:
            return None
        report.share_approved = True
        report.share_approved_by = approver_id
        await db.flush()
        await db.refresh(report)
        return report

    @staticmethod
    async def list_available_tables(db: AsyncSession) -> list[str]:
        """List tables in the platform DB that are available for BI queries."""
        try:
            result = await db.execute(
                text(
                    "SELECT name FROM sqlite_master WHERE type='table' "
                    "UNION SELECT tablename AS name FROM pg_tables WHERE schemaname='public'"
                )
            )
            tables = [row[0] for row in result.fetchall()]
        except Exception:
            # Fallback: return known platform tables
            tables = [
                "inventory_records",
                "mrp_results",
                "demand_records",
                "test_results",
                "product_combos",
                "sync_configs",
                "data_sources",
                "etl_pipelines",
                "bi_reports",
                "dashboards",
            ]
        return tables
