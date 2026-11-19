import type { ReactNode } from "react";
import type { CurrentUser, Role } from "../api/endpoints";
import {
  IconDocument,
  IconInbox,
  IconSearch,
  IconShield,
  IconSliders,
} from "../components/icons";
import { t } from "../i18n/zh-Hant";

export interface NavItem {
  key: string;
  to: string;
  label: string;
  icon: ReactNode;
  /** 有其中任何一個角色就顯示。真正的權限由後端把關，這裡只決定導覽列長什麼樣子。 */
  roles: readonly Role[];
  /** 哪些路徑算在這個項目底下（決定目前位置的標示）。 */
  match: readonly string[];
}

/** 手機底部導覽最多放 5 項，所以這張表不能超過 5 項。系統設定從 MIS 佇列進入。 */
export const NAV_ITEMS: readonly NavItem[] = [
  {
    key: "requests",
    to: "/",
    label: t.nav.myRequests,
    icon: <IconDocument />,
    roles: ["applicant"],
    match: ["/requests"],
  },
  {
    key: "approvals",
    to: "/approvals",
    label: t.nav.approvals,
    icon: <IconInbox />,
    roles: ["approver", "manager", "owner", "ciso"],
    match: ["/approvals"],
  },
  {
    key: "grants",
    to: "/grants",
    label: t.nav.grants,
    icon: <IconShield />,
    roles: ["owner", "manager"],
    match: ["/grants"],
  },
  {
    key: "mis",
    to: "/mis",
    label: t.nav.mis,
    icon: <IconSliders />,
    roles: ["mis", "mis_admin"],
    match: ["/mis", "/settings"],
  },
  {
    key: "audit",
    to: "/audit",
    label: t.nav.audit,
    icon: <IconSearch />,
    roles: ["auditor"],
    match: ["/audit"],
  },
];

export function navItemsFor(user: CurrentUser): NavItem[] {
  return NAV_ITEMS.filter((item) =>
    item.roles.some((role) => user.roles.includes(role)),
  );
}

export function isNavItemActive(item: NavItem, pathname: string): boolean {
  if (pathname === item.to) return true;
  return item.match.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}
