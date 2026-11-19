/**
 * 元件展示頁（/dev/components）專用的範例內容，取自 docs/wireframes 的文案。
 * 只在開發模式載入，不會進正式建置；不是任何頁面的資料來源。
 */
import type { DiffItem, StepItem, TimelineItem } from "../../components";

export interface SampleRow {
  id: string;
  tier: string;
  applicant: string;
  grantee: string;
  scope: string;
  kind: string;
  waitedDays: number;
  batchable: boolean;
  batchNote: string;
}

export const SAMPLE_ROWS: readonly SampleRow[] = [
  {
    id: "DA-2026-0142",
    tier: "L3",
    applicant: "林怡君",
    grantee: "專案：北區客戶流失分析",
    scope: "客戶主檔、銷售訂單｜北區｜2024–2025",
    kind: "新申請",
    waitedDays: 1,
    batchable: false,
    batchNote: "新申請、重疊警示",
  },
  {
    id: "DA-2026-0151",
    tier: "L4",
    applicant: "蔡佩珊",
    grantee: "agent：sales-forecast-bot",
    scope: "產品成本明細｜全區｜2025",
    kind: "新申請",
    waitedDays: 3,
    batchable: false,
    batchNote: "新申請不能批次",
  },
  {
    id: "DA-2026-0139",
    tier: "L3",
    applicant: "王志明",
    grantee: "團隊：業務分析部",
    scope: "客戶主檔｜全區｜2025",
    kind: "續期",
    waitedDays: 1,
    batchable: true,
    batchNote: "可批次",
  },
  {
    id: "DA-2026-0140",
    tier: "L3",
    applicant: "蔡佩珊",
    grantee: "專案：季度業績看板",
    scope: "銷售訂單｜全區｜2026",
    kind: "續期",
    waitedDays: 0,
    batchable: true,
    batchNote: "可批次",
  },
];

export const SAMPLE_STEPS_PROGRESS: readonly StepItem[] = [
  { key: "submit", label: "送審", state: "done", detail: "11-10" },
  { key: "manager", label: "主管", state: "done", detail: "陳建宏・11-11" },
  {
    key: "owner",
    label: "資料擁有者（並行）",
    state: "current",
    people: [
      { name: "張美玲", state: "done" },
      { name: "周文傑", state: "current" },
    ],
  },
  { key: "mis", label: "MIS", state: "todo", detail: "群組認領" },
  { key: "apply", label: "DC 套用", state: "todo" },
  { key: "verify", label: "驗證確認", state: "todo" },
  { key: "active", label: "生效", state: "todo" },
];

export const SAMPLE_STEPS_RETURNED: readonly StepItem[] = [
  { key: "manager", label: "主管", state: "done", detail: "陳建宏・11-11" },
  { key: "owner", label: "資料擁有者", state: "done", detail: "張美玲・11-12" },
  {
    key: "ciso",
    label: "資安長",
    state: "rejected",
    detail: "賴政達・11-13 退回",
  },
  { key: "mis", label: "MIS", state: "todo", detail: "群組認領" },
];

export const SAMPLE_TIMELINE: readonly TimelineItem[] = [
  {
    key: "4",
    at: "2026-11-12T10:02:33Z",
    actor: "張美玲",
    role: "資料擁有者",
    action: "核准",
    detail: "銷售訂單 擁有者核准",
    rule: "手機核准需 MFA：通過",
  },
  {
    key: "3",
    at: "2026-11-11T06:05:10Z",
    actor: "陳建宏",
    role: "主管",
    action: "縮短授權迄日後核准",
    detail: "授權迄 2027-05-31 → 2027-04-30",
    rule: "縮小免簽，通知申請人",
  },
  {
    key: "2",
    at: "2026-11-10T01:30:42Z",
    actor: "系統",
    action: "分派簽核人",
    detail: "主管 陳建宏；擁有者 周文傑、張美玲；MIS 群組",
    rule: "L3 路徑；每關不同人",
  },
  {
    key: "1",
    at: "2026-11-10T01:30:41Z",
    actor: "林怡君",
    role: "申請人",
    action: "送審（沿用 DA-2026-0098）",
  },
];

export const SAMPLE_DIFF: readonly DiffItem[] = [
  {
    key: "a",
    kind: "added",
    label: "客戶主檔",
    text: "客戶編號、客戶名稱、合約到期日",
  },
  { key: "b", kind: "added", label: "銷售訂單", text: "客戶編號、訂單日期" },
  {
    key: "c",
    kind: "expanded",
    label: "資料期間",
    before: "2024",
    after: "2024–2025",
  },
  {
    key: "d",
    kind: "narrowed",
    label: "授權迄",
    before: "2027-05-31",
    after: "2027-04-30",
  },
  { key: "e", kind: "same", label: "列條件", text: "區域 屬於 北區" },
  { key: "f", kind: "same", label: "使用情境", text: "報表與分析" },
];

export const SAMPLE_MFA_SUMMARY: readonly string[] = [
  "DA-2026-0142｜銷售訂單 4 個欄位",
  "授權給 專案：北區客戶流失分析",
  "2026-12-01～2027-04-30",
];
