from __future__ import annotations

import enum
from functools import wraps
from typing import Any

from fastapi import Depends, HTTPException, status

from app.core.security import get_current_user


# ---------------------------------------------------------------------------
# Roles
# ---------------------------------------------------------------------------


class RoleEnum(str, enum.Enum):
    big_data = "big_data"
    mis = "mis"
    manufacturing = "manufacturing"
    market = "market"
    sales = "sales"
    pm = "pm"
    hw_fw_rd = "hw_fw_rd"
    qa = "qa"


# ---------------------------------------------------------------------------
# Data categories
# ---------------------------------------------------------------------------

DATA_CATEGORIES: set[str] = {
    "db_management",
    "metadata",
    "inventory",
    "production_schedule",
    "bom_ecn",
    "product_combos",
    "procurement",
    "sales_data",
    "test_data",
    "audit_log",
}


# ---------------------------------------------------------------------------
# Permission matrix
# ---------------------------------------------------------------------------

PERMISSION_MATRIX: dict[str, set[str]] = {
    RoleEnum.big_data: set(DATA_CATEGORIES),
    RoleEnum.mis: {
        "db_management",
        "metadata",
        "inventory",
        "production_schedule",
        "bom_ecn",
        "procurement",
        "audit_log",
    },
    RoleEnum.manufacturing: {
        "inventory",
        "production_schedule",
        "bom_ecn",
        "product_combos",
    },
    RoleEnum.market: {
        "inventory",
        "production_schedule",
        "product_combos",
        "procurement",
        "sales_data",
        "metadata",
    },
    RoleEnum.sales: {
        "inventory",
        "production_schedule",
        "product_combos",
        "sales_data",
    },
    RoleEnum.pm: {
        "inventory",
        "production_schedule",
        "bom_ecn",
        "product_combos",
        "procurement",
        "sales_data",
        "test_data",
    },
    RoleEnum.hw_fw_rd: {
        "inventory",
        "production_schedule",
        "bom_ecn",
        "test_data",
    },
    RoleEnum.qa: {
        "inventory",
        "bom_ecn",
        "test_data",
    },
}

# ---------------------------------------------------------------------------
# Sensitive fields blacklist
# ---------------------------------------------------------------------------

SENSITIVE_FIELDS_BLACKLIST: set[str] = {
    "salary",
    "cost_price",
    "personal_id",
    "ssn",
    "social_security_number",
    "bank_account",
    "credit_card",
    "password",
    "secret",
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def check_permission(user_role: str, data_category: str) -> bool:
    """Return ``True`` if *user_role* is allowed to access *data_category*."""
    allowed = PERMISSION_MATRIX.get(user_role, set())
    return data_category in allowed


def require_permission(data_category: str):
    """FastAPI dependency factory that enforces RBAC for *data_category*.

    Usage::

        @router.get("/stuff", dependencies=[Depends(require_permission("inventory"))])
        async def get_stuff(): ...
    """

    async def _check(
        current_user: dict[str, Any] = Depends(get_current_user),
    ) -> dict[str, Any]:
        role = current_user.get("role", "")
        if not check_permission(role, data_category):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Role '{role}' does not have access to '{data_category}'",
            )
        return current_user

    return _check
