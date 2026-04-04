from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.mrp.models import BomHeader, BomItem, Ecn


class BomService:
    """Service layer for Bill of Materials operations."""

    @staticmethod
    async def get_bom(product_model: str, db: AsyncSession) -> BomHeader | None:
        """Return the active BOM for a product model."""
        stmt = (
            select(BomHeader)
            .where(
                BomHeader.product_model == product_model,
                BomHeader.status == "active",
            )
            .order_by(BomHeader.version.desc())
            .limit(1)
        )
        result = await db.execute(stmt)
        return result.scalar_one_or_none()

    @staticmethod
    async def get_bom_by_version(
        product_model: str, version: int, db: AsyncSession
    ) -> BomHeader | None:
        """Return a specific version of a BOM."""
        stmt = select(BomHeader).where(
            BomHeader.product_model == product_model,
            BomHeader.version == version,
        )
        result = await db.execute(stmt)
        return result.scalar_one_or_none()

    @staticmethod
    async def expand_bom(
        product_model: str, quantity: float = 1.0, db: AsyncSession | None = None
    ) -> list[dict[str, Any]]:
        """Multi-level BOM explosion returning a flat list of components.

        Recursively expands all levels.  Phantom items are passed through
        (their children are included but the phantom itself is omitted from
        the final list).
        """
        assert db is not None
        bom = await BomService.get_bom(product_model, db)
        if bom is None:
            return []

        items = bom.items
        # Build lookup: parent_item_id -> list of children
        children_map: dict[uuid.UUID | None, list[BomItem]] = {}
        for item in items:
            children_map.setdefault(item.parent_item_id, []).append(item)

        flat: list[dict[str, Any]] = []

        def _expand(parent_id: uuid.UUID | None, multiplier: float, level: int) -> None:
            for item in children_map.get(parent_id, []):
                total_qty = item.quantity_per * multiplier
                if item.is_phantom:
                    # Phantom: pass through to children without adding self
                    _expand(item.id, total_qty, level)
                else:
                    flat.append(
                        {
                            "part_number": item.part_number,
                            "part_name": item.part_name,
                            "total_quantity": total_qty,
                            "level": level,
                            "lead_time_days": item.lead_time_days,
                        }
                    )
                    # Expand children of this item too
                    _expand(item.id, total_qty, level + 1)

        _expand(None, quantity, 1)
        return flat

    @staticmethod
    async def search_bom(
        part_number: str | None = None,
        product_model: str | None = None,
        db: AsyncSession | None = None,
    ) -> list[BomHeader]:
        """Search BOMs by part_number (component) or product_model."""
        assert db is not None
        if part_number:
            # Find BOMs that contain the given part_number
            stmt = (
                select(BomHeader)
                .join(BomItem, BomItem.bom_header_id == BomHeader.id)
                .where(BomItem.part_number.ilike(f"%{part_number}%"))
                .distinct()
            )
        elif product_model:
            stmt = select(BomHeader).where(
                BomHeader.product_model.ilike(f"%{product_model}%")
            )
        else:
            stmt = select(BomHeader).order_by(BomHeader.created_at.desc()).limit(100)

        result = await db.execute(stmt)
        return list(result.scalars().all())

    @staticmethod
    async def get_ecn_history(
        product_model: str | None = None,
        part_number: str | None = None,
        db: AsyncSession | None = None,
    ) -> list[Ecn]:
        """Return ECN history filtered by product model or part number."""
        assert db is not None
        stmt = select(Ecn)
        if product_model:
            bom_ids_stmt = select(BomHeader.id).where(
                BomHeader.product_model == product_model
            )
            stmt = stmt.where(Ecn.bom_header_id.in_(bom_ids_stmt))
        if part_number:
            stmt = stmt.where(
                Ecn.description.ilike(f"%{part_number}%")
                | Ecn.old_value.ilike(f"%{part_number}%")
                | Ecn.new_value.ilike(f"%{part_number}%")
            )
        stmt = stmt.order_by(Ecn.created_at.desc())
        result = await db.execute(stmt)
        return list(result.scalars().all())

    @staticmethod
    async def compare_bom_versions(
        product_model: str,
        version_a: int,
        version_b: int,
        db: AsyncSession,
    ) -> dict[str, Any]:
        """Compare two BOM versions, returning added/removed/modified items."""
        bom_a = await BomService.get_bom_by_version(product_model, version_a, db)
        bom_b = await BomService.get_bom_by_version(product_model, version_b, db)

        items_a: dict[str, BomItem] = {}
        items_b: dict[str, BomItem] = {}

        if bom_a:
            for item in bom_a.items:
                items_a[item.part_number] = item
        if bom_b:
            for item in bom_b.items:
                items_b[item.part_number] = item

        added = []
        removed = []
        modified = []

        all_parts = set(items_a.keys()) | set(items_b.keys())
        for pn in sorted(all_parts):
            in_a = pn in items_a
            in_b = pn in items_b
            if in_b and not in_a:
                b = items_b[pn]
                added.append({"part_number": pn, "part_name": b.part_name, "quantity_per": b.quantity_per})
            elif in_a and not in_b:
                a = items_a[pn]
                removed.append({"part_number": pn, "part_name": a.part_name, "quantity_per": a.quantity_per})
            elif in_a and in_b:
                a, b = items_a[pn], items_b[pn]
                if a.quantity_per != b.quantity_per or a.part_name != b.part_name:
                    modified.append(
                        {
                            "part_number": pn,
                            "old_quantity_per": a.quantity_per,
                            "new_quantity_per": b.quantity_per,
                            "old_part_name": a.part_name,
                            "new_part_name": b.part_name,
                        }
                    )

        return {
            "product_model": product_model,
            "version_a": version_a,
            "version_b": version_b,
            "added": added,
            "removed": removed,
            "modified": modified,
        }
