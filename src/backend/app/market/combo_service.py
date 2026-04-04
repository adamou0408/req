from __future__ import annotations

import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import select, func as sa_func
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.models import ComboStatus, ProductCombo


class ProductComboService:
    """Service layer for product combo lifecycle management."""

    @staticmethod
    async def create_combo(
        controller_model: str,
        flash_model: str,
        target_ratio: Decimal,
        created_by: uuid.UUID,
        db: AsyncSession,
    ) -> ProductCombo:
        """Create a new combo in draft status after ratio validation."""
        await ProductComboService._validate_ratio(
            controller_model=controller_model,
            target_ratio=target_ratio,
            db=db,
            exclude_combo_id=None,
        )

        combo = ProductCombo(
            controller_model=controller_model,
            flash_model=flash_model,
            target_ratio=target_ratio,
            status=ComboStatus.draft,
            created_by=created_by,
        )
        db.add(combo)
        await db.flush()
        await db.refresh(combo)
        return combo

    @staticmethod
    async def submit_for_approval(combo_id: uuid.UUID, db: AsyncSession) -> ProductCombo:
        combo = await ProductComboService._get_combo_or_404(combo_id, db)
        if combo.status != ComboStatus.draft:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Cannot submit combo with status '{combo.status.value}'; must be 'draft'",
            )
        combo.status = ComboStatus.pending_approval
        db.add(combo)
        await db.flush()
        await db.refresh(combo)
        return combo

    @staticmethod
    async def approve_combo(
        combo_id: uuid.UUID,
        approved_by: uuid.UUID,
        db: AsyncSession,
    ) -> ProductCombo:
        combo = await ProductComboService._get_combo_or_404(combo_id, db)
        if combo.status != ComboStatus.pending_approval:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Cannot approve combo with status '{combo.status.value}'; must be 'pending_approval'",
            )

        # Re-validate ratio before activating
        await ProductComboService._validate_ratio(
            controller_model=combo.controller_model,
            target_ratio=combo.target_ratio,
            db=db,
            exclude_combo_id=combo.id,
        )

        combo.status = ComboStatus.active
        combo.approved_by = approved_by
        combo.approved_at = datetime.now(timezone.utc)
        db.add(combo)
        await db.flush()
        await db.refresh(combo)
        return combo

    @staticmethod
    async def reject_combo(
        combo_id: uuid.UUID,
        reason: str,
        db: AsyncSession,
    ) -> ProductCombo:
        combo = await ProductComboService._get_combo_or_404(combo_id, db)
        if combo.status != ComboStatus.pending_approval:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Cannot reject combo with status '{combo.status.value}'; must be 'pending_approval'",
            )
        combo.status = ComboStatus.draft
        db.add(combo)
        await db.flush()
        await db.refresh(combo)
        return combo

    @staticmethod
    async def publish_combo(combo_id: uuid.UUID, db: AsyncSession) -> dict[str, Any]:
        combo = await ProductComboService._get_combo_or_404(combo_id, db)
        if combo.status != ComboStatus.active:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Cannot publish combo with status '{combo.status.value}'; must be 'active'",
            )
        combo.published_at = datetime.now(timezone.utc)
        db.add(combo)
        await db.flush()
        await db.refresh(combo)

        notifications = [
            {"department": "sales", "message": f"New combo published: {combo.controller_model} + {combo.flash_model}"},
            {"department": "manufacturing", "message": f"New combo published: {combo.controller_model} + {combo.flash_model}"},
            {"department": "procurement", "message": f"New combo published – flash model {combo.flash_model} may need stock check"},
        ]
        return {"combo": combo, "notifications": notifications}

    @staticmethod
    async def archive_combo(combo_id: uuid.UUID, db: AsyncSession) -> ProductCombo:
        combo = await ProductComboService._get_combo_or_404(combo_id, db)
        if combo.status == ComboStatus.archived:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Combo is already archived",
            )
        combo.status = ComboStatus.archived
        db.add(combo)
        await db.flush()
        await db.refresh(combo)
        return combo

    @staticmethod
    async def get_active_combos(db: AsyncSession) -> list[ProductCombo]:
        stmt = (
            select(ProductCombo)
            .where(ProductCombo.status == ComboStatus.active)
            .order_by(ProductCombo.created_at.desc())
        )
        result = await db.execute(stmt)
        return list(result.scalars().all())

    @staticmethod
    async def get_all_combos(db: AsyncSession) -> list[ProductCombo]:
        stmt = select(ProductCombo).order_by(ProductCombo.created_at.desc())
        result = await db.execute(stmt)
        return list(result.scalars().all())

    @staticmethod
    async def get_combo_by_id(combo_id: uuid.UUID, db: AsyncSession) -> ProductCombo:
        return await ProductComboService._get_combo_or_404(combo_id, db)

    @staticmethod
    async def get_combo_history(db: AsyncSession, limit: int = 50) -> list[ProductCombo]:
        stmt = (
            select(ProductCombo)
            .order_by(ProductCombo.created_at.desc())
            .limit(limit)
        )
        result = await db.execute(stmt)
        return list(result.scalars().all())

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    async def _get_combo_or_404(combo_id: uuid.UUID, db: AsyncSession) -> ProductCombo:
        stmt = select(ProductCombo).where(ProductCombo.id == combo_id)
        result = await db.execute(stmt)
        combo = result.scalar_one_or_none()
        if combo is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Product combo not found",
            )
        return combo

    @staticmethod
    async def _validate_ratio(
        controller_model: str,
        target_ratio: Decimal,
        db: AsyncSession,
        exclude_combo_id: uuid.UUID | None = None,
    ) -> None:
        """Ensure total target_ratio for a controller does not exceed 100%."""
        stmt = select(sa_func.coalesce(sa_func.sum(ProductCombo.target_ratio), Decimal("0"))).where(
            ProductCombo.controller_model == controller_model,
            ProductCombo.status.in_([ComboStatus.active, ComboStatus.pending_approval]),
        )
        if exclude_combo_id is not None:
            stmt = stmt.where(ProductCombo.id != exclude_combo_id)

        result = await db.execute(stmt)
        current_total = result.scalar() or Decimal("0")

        if current_total + target_ratio > Decimal("100"):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    f"Total target ratio for controller '{controller_model}' would be "
                    f"{current_total + target_ratio}%, exceeding the 100% limit "
                    f"(current active/pending total: {current_total}%)"
                ),
            )
