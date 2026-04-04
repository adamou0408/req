from __future__ import annotations

import logging
import uuid
from typing import Any, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.etl.models import BiReport, Dashboard

logger = logging.getLogger(__name__)


class DashboardService:
    """Service layer for dashboard management."""

    @staticmethod
    async def create_dashboard(
        *,
        name: str,
        description: str | None = None,
        layout: list[dict[str, Any]] | None = None,
        refresh_interval_seconds: int | None = None,
        user_id: uuid.UUID,
        db: AsyncSession,
    ) -> Dashboard:
        dashboard = Dashboard(
            name=name,
            description=description,
            layout=layout or [],
            refresh_interval_seconds=refresh_interval_seconds,
            created_by=user_id,
        )
        db.add(dashboard)
        await db.flush()
        await db.refresh(dashboard)
        return dashboard

    @staticmethod
    async def update_dashboard(
        dashboard_id: uuid.UUID,
        updates: dict[str, Any],
        db: AsyncSession,
    ) -> Dashboard | None:
        stmt = select(Dashboard).where(Dashboard.id == dashboard_id)
        result = await db.execute(stmt)
        dashboard = result.scalar_one_or_none()
        if dashboard is None:
            return None
        allowed = {"name", "description", "layout", "refresh_interval_seconds"}
        for key, value in updates.items():
            if key in allowed:
                setattr(dashboard, key, value)
        await db.flush()
        await db.refresh(dashboard)
        return dashboard

    @staticmethod
    async def delete_dashboard(
        dashboard_id: uuid.UUID,
        db: AsyncSession,
    ) -> bool:
        stmt = select(Dashboard).where(Dashboard.id == dashboard_id)
        result = await db.execute(stmt)
        dashboard = result.scalar_one_or_none()
        if dashboard is None:
            return False
        await db.delete(dashboard)
        await db.flush()
        return True

    @staticmethod
    async def list_dashboards(
        db: AsyncSession,
        user_id: uuid.UUID | None = None,
        include_shared: bool = True,
    ) -> list[Dashboard]:
        conditions = []
        if user_id is not None:
            if include_shared:
                conditions.append(
                    (Dashboard.created_by == user_id)
                    | (
                        (Dashboard.is_shared.is_(True))
                        & (Dashboard.share_approved.is_(True))
                    )
                )
            else:
                conditions.append(Dashboard.created_by == user_id)

        stmt = select(Dashboard)
        for cond in conditions:
            stmt = stmt.where(cond)
        stmt = stmt.order_by(Dashboard.created_at.desc())
        result = await db.execute(stmt)
        return list(result.scalars().all())

    @staticmethod
    async def get_dashboard(
        dashboard_id: uuid.UUID,
        db: AsyncSession,
    ) -> Dashboard | None:
        stmt = select(Dashboard).where(Dashboard.id == dashboard_id)
        result = await db.execute(stmt)
        return result.scalar_one_or_none()

    @staticmethod
    async def get_dashboard_with_data(
        dashboard_id: uuid.UUID,
        db: AsyncSession,
    ) -> dict[str, Any]:
        """Fetch dashboard layout and execute all report queries."""
        from app.etl.bi_service import BiReportService

        stmt = select(Dashboard).where(Dashboard.id == dashboard_id)
        result = await db.execute(stmt)
        dashboard = result.scalar_one_or_none()
        if dashboard is None:
            return {"error": "Dashboard not found"}

        layout = dashboard.layout or []
        reports_data: list[dict[str, Any]] = []

        for item in layout:
            report_id = item.get("report_id")
            if not report_id:
                continue
            try:
                report_uuid = uuid.UUID(report_id) if isinstance(report_id, str) else report_id
                query_result = await BiReportService.execute_query(report_uuid, db)
                reports_data.append({
                    "report_id": str(report_uuid),
                    "position": {k: v for k, v in item.items() if k != "report_id"},
                    "data": query_result,
                })
            except Exception as exc:
                logger.warning("Failed to execute report %s: %s", report_id, exc)
                reports_data.append({
                    "report_id": str(report_id),
                    "position": {k: v for k, v in item.items() if k != "report_id"},
                    "data": {"error": str(exc)},
                })

        return {
            "id": str(dashboard.id),
            "name": dashboard.name,
            "description": dashboard.description,
            "layout": layout,
            "refresh_interval_seconds": dashboard.refresh_interval_seconds,
            "reports_data": reports_data,
            "is_shared": dashboard.is_shared,
            "share_approved": dashboard.share_approved,
        }

    @staticmethod
    async def share_dashboard(
        dashboard_id: uuid.UUID,
        db: AsyncSession,
    ) -> Dashboard | None:
        stmt = select(Dashboard).where(Dashboard.id == dashboard_id)
        result = await db.execute(stmt)
        dashboard = result.scalar_one_or_none()
        if dashboard is None:
            return None
        dashboard.is_shared = True
        dashboard.share_approved = False
        await db.flush()
        await db.refresh(dashboard)
        return dashboard

    @staticmethod
    async def approve_share(
        dashboard_id: uuid.UUID,
        approver_id: uuid.UUID,
        db: AsyncSession,
    ) -> Dashboard | None:
        stmt = select(Dashboard).where(Dashboard.id == dashboard_id)
        result = await db.execute(stmt)
        dashboard = result.scalar_one_or_none()
        if dashboard is None:
            return None
        dashboard.share_approved = True
        dashboard.share_approved_by = approver_id
        await db.flush()
        await db.refresh(dashboard)
        return dashboard

    @staticmethod
    async def export_pdf(
        dashboard_id: uuid.UUID,
        db: AsyncSession,
    ) -> bytes:
        """Generate a simple HTML-based PDF for the dashboard."""
        dashboard_data = await DashboardService.get_dashboard_with_data(dashboard_id, db)
        if "error" in dashboard_data:
            return b""

        # Simple HTML table fallback
        html_parts = [
            "<html><head><meta charset='utf-8'></head><body>",
            f"<h1>{dashboard_data['name']}</h1>",
        ]
        if dashboard_data.get("description"):
            html_parts.append(f"<p>{dashboard_data['description']}</p>")

        for report_data in dashboard_data.get("reports_data", []):
            data = report_data.get("data", {})
            columns = data.get("columns", [])
            rows = data.get("data", [])
            html_parts.append(f"<h3>Report: {report_data['report_id']}</h3>")
            if columns and rows:
                html_parts.append("<table border='1'><tr>")
                for col in columns:
                    html_parts.append(f"<th>{col}</th>")
                html_parts.append("</tr>")
                for row in rows[:50]:  # Limit to 50 rows for PDF
                    html_parts.append("<tr>")
                    for col in columns:
                        html_parts.append(f"<td>{row.get(col, '')}</td>")
                    html_parts.append("</tr>")
                html_parts.append("</table>")

        html_parts.append("</body></html>")
        return "".join(html_parts).encode("utf-8")

    @staticmethod
    async def schedule_email(
        dashboard_id: uuid.UUID,
        cron: str,
        recipients: list[str],
        db: AsyncSession,
    ) -> dict[str, Any]:
        """Schedule periodic email with dashboard PDF.

        In production this would register a Celery Beat task.
        """
        stmt = select(Dashboard).where(Dashboard.id == dashboard_id)
        result = await db.execute(stmt)
        dashboard = result.scalar_one_or_none()
        if dashboard is None:
            return {"error": "Dashboard not found"}

        # In production: register Celery Beat schedule for email sending
        return {
            "status": "scheduled",
            "dashboard_id": str(dashboard_id),
            "cron": cron,
            "recipients": recipients,
        }
