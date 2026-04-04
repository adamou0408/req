from __future__ import annotations

import logging
from typing import Any

from app.core.config import settings

logger = logging.getLogger(__name__)


class ADConnector:
    """Active Directory connector using python-ldap."""

    def __init__(self) -> None:
        self._server: str = settings.AD_SERVER
        self._base_dn: str = settings.AD_BASE_DN
        self._domain: str = settings.AD_DOMAIN

    @property
    def _is_dev_mode(self) -> bool:
        return not self._server

    def connect_and_authenticate(self, username: str, password: str) -> bool:
        """Authenticate a user against Active Directory.

        Returns ``True`` on success, ``False`` on failure.  When AD_SERVER is
        not configured the method falls back to **dev mode** and allows any
        login.
        """
        if self._is_dev_mode:
            logger.warning(
                "AD_SERVER not configured – dev mode active, allowing login for '%s'",
                username,
            )
            return True

        try:
            import ldap  # type: ignore[import-untyped]

            conn = ldap.initialize(self._server)
            conn.protocol_version = ldap.VERSION3
            conn.set_option(ldap.OPT_REFERRALS, 0)
            bind_dn = f"{self._domain}\\{username}" if self._domain else username
            conn.simple_bind_s(bind_dn, password)
            conn.unbind_s()
            return True
        except Exception:
            logger.exception("AD authentication failed for user '%s'", username)
            return False

    def get_user_info(self, username: str) -> dict[str, Any]:
        """Retrieve display_name, department, and email from AD.

        In dev mode returns sensible defaults.
        """
        if self._is_dev_mode:
            logger.warning(
                "AD_SERVER not configured – returning stub user info for '%s'",
                username,
            )
            return {
                "display_name": username,
                "department": "dev",
                "email": f"{username}@localhost",
            }

        try:
            import ldap  # type: ignore[import-untyped]

            conn = ldap.initialize(self._server)
            conn.protocol_version = ldap.VERSION3
            conn.set_option(ldap.OPT_REFERRALS, 0)

            search_filter = f"(sAMAccountName={username})"
            attrs = ["displayName", "department", "mail"]
            result = conn.search_s(self._base_dn, ldap.SCOPE_SUBTREE, search_filter, attrs)

            if not result or not result[0][1]:
                return {
                    "display_name": username,
                    "department": None,
                    "email": None,
                }

            entry = result[0][1]
            return {
                "display_name": _decode_attr(entry, "displayName", username),
                "department": _decode_attr(entry, "department"),
                "email": _decode_attr(entry, "mail"),
            }
        except Exception:
            logger.exception("Failed to fetch AD user info for '%s'", username)
            return {
                "display_name": username,
                "department": None,
                "email": None,
            }


def _decode_attr(entry: dict, attr: str, default: str | None = None) -> str | None:
    """Decode a single-valued LDAP attribute."""
    values = entry.get(attr)
    if values and isinstance(values, list):
        return values[0].decode("utf-8") if isinstance(values[0], bytes) else str(values[0])
    return default
