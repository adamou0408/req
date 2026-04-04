from __future__ import annotations

import pytest

from app.auth.rbac import (
    DATA_CATEGORIES,
    PERMISSION_MATRIX,
    SENSITIVE_FIELDS_BLACKLIST,
    RoleEnum,
    check_permission,
)


class TestCheckPermission:
    """Tests for the check_permission helper."""

    def test_big_data_has_all_categories(self) -> None:
        for category in DATA_CATEGORIES:
            assert check_permission(RoleEnum.big_data, category), (
                f"big_data should have access to {category}"
            )

    def test_sales_denied_categories(self) -> None:
        denied = {"db_management", "metadata", "audit_log", "test_data"}
        for category in denied:
            assert not check_permission(RoleEnum.sales, category), (
                f"sales should NOT have access to {category}"
            )

    def test_sales_allowed_categories(self) -> None:
        allowed = {"inventory", "production_schedule", "product_combos", "sales_data"}
        for category in allowed:
            assert check_permission(RoleEnum.sales, category), (
                f"sales should have access to {category}"
            )

    def test_mis_cannot_access_sales_data(self) -> None:
        assert not check_permission(RoleEnum.mis, "sales_data")

    def test_mis_can_access_db_management(self) -> None:
        assert check_permission(RoleEnum.mis, "db_management")

    def test_qa_can_access_test_data(self) -> None:
        assert check_permission(RoleEnum.qa, "test_data")

    def test_qa_can_access_bom_ecn(self) -> None:
        assert check_permission(RoleEnum.qa, "bom_ecn")

    def test_qa_can_access_inventory(self) -> None:
        assert check_permission(RoleEnum.qa, "inventory")

    def test_qa_cannot_access_sales_data(self) -> None:
        assert not check_permission(RoleEnum.qa, "sales_data")

    def test_all_roles_have_inventory(self) -> None:
        for role in RoleEnum:
            assert check_permission(role, "inventory"), (
                f"{role.value} should have access to inventory"
            )

    def test_unknown_role_denied(self) -> None:
        assert not check_permission("nonexistent_role", "inventory")

    def test_unknown_category_denied(self) -> None:
        assert not check_permission(RoleEnum.big_data, "nonexistent_category")


class TestPermissionMatrix:
    """Verify the PERMISSION_MATRIX structure."""

    def test_all_roles_present(self) -> None:
        for role in RoleEnum:
            assert role in PERMISSION_MATRIX, f"{role.value} missing from matrix"

    def test_big_data_equals_all_categories(self) -> None:
        assert PERMISSION_MATRIX[RoleEnum.big_data] == DATA_CATEGORIES

    def test_manufacturing_categories(self) -> None:
        expected = {"inventory", "production_schedule", "bom_ecn", "product_combos"}
        assert PERMISSION_MATRIX[RoleEnum.manufacturing] == expected

    def test_hw_fw_rd_categories(self) -> None:
        expected = {"inventory", "production_schedule", "bom_ecn", "test_data"}
        assert PERMISSION_MATRIX[RoleEnum.hw_fw_rd] == expected


class TestSensitiveFieldsBlacklist:
    """Verify the sensitive fields blacklist."""

    def test_contains_expected_fields(self) -> None:
        expected = {"salary", "cost_price", "personal_id", "ssn", "password", "credit_card"}
        for field in expected:
            assert field in SENSITIVE_FIELDS_BLACKLIST, (
                f"{field} should be in the blacklist"
            )

    def test_blacklist_is_nonempty(self) -> None:
        assert len(SENSITIVE_FIELDS_BLACKLIST) > 0

    def test_bank_account_in_blacklist(self) -> None:
        assert "bank_account" in SENSITIVE_FIELDS_BLACKLIST

    def test_secret_in_blacklist(self) -> None:
        assert "secret" in SENSITIVE_FIELDS_BLACKLIST
