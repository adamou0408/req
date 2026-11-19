/**
 * 日期、工作天、級別、狀態的格式化都集中在這裡。
 * 只做「怎麼顯示」：工作天數、剩餘天數、狀態本身都由後端算好再傳來。
 */
import type { GranteeType, Level, RequestStatus, Role } from "../api/endpoints";
import type { TagTone } from "./tone";
import { t } from "../i18n/zh-Hant";

/** 公司在台灣，所有時間一律用台北時間顯示，不跟著使用者裝置的時區變。 */
const TIME_ZONE = "Asia/Taipei";
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const partsFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

type DateInput = string | Date | null | undefined;
type DateParts = Record<"year" | "month" | "day" | "hour" | "minute", string>;

function toParts(value: DateInput): DateParts | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = Object.fromEntries(
    partsFormatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
  return parts as DateParts;
}

/** 2026-12-01。純日期字串（授權起迄、資料期間）原樣顯示，不做時區換算。 */
export function formatDate(value: DateInput): string {
  if (typeof value === "string" && DATE_ONLY.test(value)) return value;
  const parts = toParts(value);
  return parts ? `${parts.year}-${parts.month}-${parts.day}` : t.common.none;
}

/** 11-21。清單與進度條上的短日期。 */
export function formatDateShort(value: DateInput): string {
  const full = formatDate(value);
  return full === t.common.none ? full : full.slice(5);
}

/** 2026-11-10 09:30。 */
export function formatDateTime(value: DateInput): string {
  const parts = toParts(value);
  if (!parts) return t.common.none;
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

/** 2026-12-01～2027-04-30；兩端都沒有時顯示「—」。 */
export function formatDateRange(from: DateInput, to: DateInput): string {
  const start = formatDate(from);
  const end = formatDate(to);
  if (start === t.common.none && end === t.common.none) return t.common.none;
  return t.format.range(start, end);
}

/** 「當天」「3 個工作天」。 */
export function formatWorkdays(days: number): string {
  return days <= 0 ? t.format.sameDay : t.format.workdays(days);
}

/** 清單上的等待時間：「當天」「已等 1 個工作天」。 */
export function formatWaited(days: number): string {
  return days <= 0 ? t.format.sameDay : t.format.waited(days);
}

/** 期限倒數：「剩 3 個工作天」。 */
export function formatWorkdaysLeft(days: number): string {
  return t.format.workdaysLeft(Math.max(days, 0));
}

/** 寬限期、到期倒數：「剩 9 天」。 */
export function formatDaysLeft(days: number): string {
  return t.format.daysLeft(Math.max(days, 0));
}

export interface TagDisplay {
  label: string;
  tone: TagTone;
}

const LEVEL_TONE: Record<Level, TagTone> = {
  L1: "neutral",
  L2: "neutral",
  L3: "l3",
  L4: "l4",
};

/** null 代表還沒選欄位，級別未判定。 */
export function formatLevel(level: Level | null): TagDisplay {
  if (level === null) return { label: t.level.undetermined, tone: "neutral" };
  return { label: t.level.labels[level], tone: LEVEL_TONE[level] };
}

const STATUS_TONE: Record<RequestStatus, TagTone> = {
  draft: "neutral",
  in_review: "info",
  returned: "danger",
  pending_apply: "warn",
  verifying: "warn",
  active: "ok",
  expired: "neutral",
  revoked: "danger",
};

export function formatStatus(status: RequestStatus): TagDisplay {
  return { label: t.status[status], tone: STATUS_TONE[status] };
}

export function formatRole(role: Role): string {
  return t.roles[role];
}

/** 「專案：北區客戶流失分析」。 */
export function formatGrantee(type: GranteeType, name: string): string {
  return t.format.grantee(t.grantee[type], name);
}

/** 「待我簽（6）」。 */
export function formatCount(label: string, count: number): string {
  return t.format.count(label, count);
}
