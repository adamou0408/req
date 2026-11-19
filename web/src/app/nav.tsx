import type { ReactNode } from "react";
import type { Area, CurrentUser } from "../api/endpoints";
import {
  IconDocument,
  IconInbox,
  IconSearch,
  IconShield,
  IconSliders,
} from "../components/icons";
import { t } from "../i18n/zh-Hant";
import { PATHS } from "./paths";

export interface NavItem {
  /** 後端回傳的工作區；登入者有這個工作區才顯示這一項。 */
  area: Area;
  to: string;
  label: string;
  icon: ReactNode;
  /** 哪些路徑算在這個項目底下（決定目前位置的標示）。 */
  match: readonly string[];
}

/**
 * 手機底部導覽最多放 5 項，所以這張表不能超過 5 項。系統設定從執行佇列進入。
 * 誰看得到哪一項由後端決定（依角色算出工作區），這裡不認任何角色。
 */
export const NAV_ITEMS: readonly NavItem[] = [
  {
    area: "requests",
    to: PATHS.home,
    label: t.nav.myRequests,
    icon: <IconDocument />,
    match: ["/requests"],
  },
  {
    area: "approvals",
    to: PATHS.approvals,
    label: t.nav.approvals,
    icon: <IconInbox />,
    match: [PATHS.approvals],
  },
  {
    area: "grants",
    to: PATHS.grants,
    label: t.nav.grants,
    icon: <IconShield />,
    match: [PATHS.grants],
  },
  {
    area: "fulfilment",
    to: PATHS.fulfilment,
    label: t.nav.fulfilment,
    icon: <IconSliders />,
    match: [PATHS.fulfilment, PATHS.settings],
  },
  {
    area: "audit",
    to: PATHS.audit,
    label: t.nav.audit,
    icon: <IconSearch />,
    match: [PATHS.audit],
  },
];

export function navItemsFor(user: CurrentUser): NavItem[] {
  return NAV_ITEMS.filter((item) => user.areas.includes(item.area));
}

export function isNavItemActive(item: NavItem, pathname: string): boolean {
  if (pathname === item.to) return true;
  return item.match.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}
