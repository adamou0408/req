from __future__ import annotations

import io
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession


class ReportService:
    """Reporting service for sales trends and combo performance.

    Currently returns mock data. Interfaces are designed for easy swap to
    real data once sync pipelines are complete.
    """

    @staticmethod
    async def get_sales_trend(
        group_by: str = "combo",
        filters: dict[str, Any] | None = None,
        db: AsyncSession | None = None,
    ) -> list[dict[str, Any]]:
        """Return sales trend data grouped by combo, region, or month."""
        if group_by == "combo":
            return [
                {"combo": "CTRL-A100 + FL-256A", "period": "2026-01", "units_sold": 1200, "revenue": 360000.0},
                {"combo": "CTRL-A100 + FL-256A", "period": "2026-02", "units_sold": 1450, "revenue": 435000.0},
                {"combo": "CTRL-A100 + FL-256A", "period": "2026-03", "units_sold": 1380, "revenue": 414000.0},
                {"combo": "CTRL-A100 + FL-512B", "period": "2026-01", "units_sold": 800, "revenue": 320000.0},
                {"combo": "CTRL-A100 + FL-512B", "period": "2026-02", "units_sold": 920, "revenue": 368000.0},
                {"combo": "CTRL-A100 + FL-512B", "period": "2026-03", "units_sold": 870, "revenue": 348000.0},
            ]
        elif group_by == "region":
            return [
                {"region": "APAC", "period": "2026-Q1", "units_sold": 5200, "revenue": 1560000.0},
                {"region": "EMEA", "period": "2026-Q1", "units_sold": 2100, "revenue": 630000.0},
                {"region": "Americas", "period": "2026-Q1", "units_sold": 3400, "revenue": 1020000.0},
            ]
        else:  # month
            return [
                {"month": "2026-01", "units_sold": 3500, "revenue": 1050000.0},
                {"month": "2026-02", "units_sold": 4100, "revenue": 1230000.0},
                {"month": "2026-03", "units_sold": 3900, "revenue": 1170000.0},
            ]

    @staticmethod
    async def get_combo_performance(
        db: AsyncSession | None = None,
    ) -> list[dict[str, Any]]:
        """Return performance metrics per combo."""
        return [
            {
                "combo": "CTRL-A100 + FL-256A",
                "total_units": 4030,
                "total_revenue": 1209000.0,
                "trend": "up",
                "trend_pct": 5.2,
            },
            {
                "combo": "CTRL-A100 + FL-512B",
                "total_units": 2590,
                "total_revenue": 1036000.0,
                "trend": "up",
                "trend_pct": 3.8,
            },
            {
                "combo": "CTRL-B200 + FL-1T-C",
                "total_units": 950,
                "total_revenue": 570000.0,
                "trend": "down",
                "trend_pct": -2.1,
            },
        ]

    @staticmethod
    async def export_excel(data: list[dict[str, Any]], filename: str) -> bytes:
        """Export data to Excel bytes using openpyxl."""
        from openpyxl import Workbook

        wb = Workbook()
        ws = wb.active
        ws.title = "Report"

        if data:
            headers = list(data[0].keys())
            ws.append(headers)
            for row in data:
                ws.append([row.get(h) for h in headers])

        buf = io.BytesIO()
        wb.save(buf)
        return buf.getvalue()

    @staticmethod
    async def export_pdf(data: list[dict[str, Any]], filename: str) -> bytes:
        """Export data to a simple PDF.

        Uses reportlab if available, otherwise falls back to a minimal
        PDF built from raw bytes.
        """
        try:
            from reportlab.lib.pagesizes import A4
            from reportlab.platypus import SimpleDocTemplate, Table

            buf = io.BytesIO()
            doc = SimpleDocTemplate(buf, pagesize=A4)

            if data:
                headers = list(data[0].keys())
                table_data = [headers] + [[str(row.get(h, "")) for h in headers] for row in data]
            else:
                table_data = [["No data"]]

            table = Table(table_data)
            doc.build([table])
            return buf.getvalue()
        except ImportError:
            return _build_minimal_pdf(data, filename)


def _build_minimal_pdf(data: list[dict[str, Any]], filename: str) -> bytes:
    """Generate a bare-bones PDF without external dependencies."""
    lines: list[str] = [filename, ""]
    if data:
        headers = list(data[0].keys())
        lines.append(" | ".join(headers))
        lines.append("-" * 60)
        for row in data:
            lines.append(" | ".join(str(row.get(h, "")) for h in headers))
    else:
        lines.append("No data")

    text = "\n".join(lines)
    text_encoded = text.encode("latin-1", errors="replace")
    stream_length = len(text_encoded)

    pdf_parts = [
        b"%PDF-1.4\n",
        b"1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n",
        b"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n",
        b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n",
        f"4 0 obj<</Length {stream_length + 44}>>\nstream\nBT /F1 10 Tf 50 750 Td ({text_encoded.decode('latin-1')}) Tj ET\nendstream\nendobj\n".encode("latin-1"),
        b"5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Courier>>endobj\n",
        b"xref\n0 6\n",
        b"trailer<</Size 6/Root 1 0 R>>\nstartxref\n0\n%%EOF\n",
    ]
    return b"".join(pdf_parts)
