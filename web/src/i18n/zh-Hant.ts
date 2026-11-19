/**
 * 介面文案的唯一來源。元件與頁面只引用這裡的 key，不直接寫中文字串。
 * 業務錯誤的訊息由後端回傳後直接顯示，這裡只放前端自己產生的錯誤文案。
 */
import type { GranteeType, Level, RequestStatus, Role } from "../api/endpoints";

const status: Record<RequestStatus, string> = {
  draft: "草稿",
  in_review: "送審中",
  returned: "已退回",
  pending_apply: "待套用",
  verifying: "驗證中",
  active: "生效中",
  expired: "已到期",
  revoked: "已撤銷",
};

const roles: Record<Role, string> = {
  applicant: "申請人",
  approver: "簽核人",
  owner: "資料擁有者",
  manager: "主管",
  ciso: "資安長",
  mis: "MIS",
  mis_admin: "MIS 系統管理員",
  auditor: "稽核",
};

const grantee: Record<GranteeType, string> = {
  team: "團隊",
  project: "專案",
  agent: "agent",
};

const levels: Record<Level, string> = {
  L1: "L1",
  L2: "L2",
  L3: "L3",
  L4: "L4",
};

export const t = {
  app: {
    name: "資料授權簽核",
    skipToContent: "跳到主要內容",
  },
  common: {
    none: "—",
    colon: "：",
    loading: "載入中",
    retry: "重試",
    cancel: "取消",
    confirm: "確認",
    close: "關閉",
    logout: "登出",
    requiredMark: "（必填）",
  },
  nav: {
    label: "主要導覽",
    myRequests: "我的申請",
    approvals: "待簽",
    grants: "授權總覽",
    mis: "MIS",
    audit: "稽核",
  },
  roles,
  status,
  grantee,
  level: {
    labels: levels,
    undetermined: "未判定",
  },
  format: {
    sameDay: "當天",
    workdays: (days: number) => `${days} 個工作天`,
    waited: (days: number) => `已等 ${days} 個工作天`,
    workdaysLeft: (days: number) => `剩 ${days} 個工作天`,
    daysLeft: (days: number) => `剩 ${days} 天`,
    range: (from: string, to: string) => `${from}～${to}`,
    count: (label: string, count: number) => `${label}（${count}）`,
    grantee: (type: string, name: string) => `${type}：${name}`,
  },
  errors: {
    network: "連不上伺服器，請確認網路後再試一次。",
    badResponse: "伺服器回應的格式不正確，請稍後再試。",
    http: (httpStatus: number) =>
      `伺服器回應錯誤（HTTP ${httpStatus}），請稍後再試。`,
    mfaCancelled: "已取消驗證，這個動作沒有送出。",
    unknown: "發生未預期的錯誤，請稍後再試。",
  },
  state: {
    errorTitle: "無法載入",
    errorCode: (code: string) => `錯誤代碼 ${code}`,
  },
  datalist: {
    empty: "沒有資料",
    selectAll: "全選",
    actions: "操作",
  },
  stepper: {
    state: {
      done: "已完成",
      current: "進行中",
      todo: "未開始",
      rejected: "已退回",
    },
  },
  timeline: {
    actorWithRole: (actor: string, role: string) => `${actor}（${role}）`,
    rule: (rule: string) => `依據：${rule}`,
  },
  diff: {
    none: "與前案無差異",
    becomes: "改為",
    kind: {
      added: "新增",
      expanded: "擴大",
      narrowed: "縮小",
      removed: "移除",
      changed: "修改",
      same: "相同",
    },
  },
  confirm: {
    reasonLabel: "原因",
    reasonRequired: "請填寫原因。",
  },
  mfa: {
    title: "確認身分",
    codeLabel: "輸入驗證器 App 上的 6 位數驗證碼",
    confirm: "確認",
    auditNote:
      "紀錄會記下：時間、你的帳號、裝置、IP，以及這次 MFA 驗證通過。紀錄只增不改。",
  },
  toast: {
    region: "通知",
    dismiss: "關閉通知",
  },
  auth: {
    loginTitle: "登入",
    intro: "處理 L3、L4 資料的授權申請與簽核。",
    ssoButton: "使用公司帳號登入",
    devTitle: "開發模式：選擇要扮演的人員",
    devHint: "這份名單只在開發環境出現，正式環境一律走公司帳號登入。",
    devEmpty: "後端沒有提供開發用人員名單。",
    devFilterLabel: "搜尋人員",
    devFilterPlaceholder: "輸入姓名或部門",
    devNoMatch: "沒有符合的人員",
    devListLabel: "可扮演的人員",
    sessionCheckFailed: "無法確認登入狀態",
    userLine: (name: string, dept: string) => `${name}｜${dept}`,
  },
  pages: {
    placeholderTitle: "這個畫面還沒有實作",
    placeholderBody: (files: string) => `對應的 wireframe：${files}`,
    wireframeDir: "docs/wireframes/",
    myRequests: { title: "我的申請", newRequest: "新申請" },
    requestNew: { title: "新申請" },
    requestDetail: { title: "申請單", meta: (id: string) => `單號 ${id}` },
    approvals: { title: "待簽清單", mobileTitle: "待我簽" },
    approvalDetail: { title: "簽核詳情", meta: (id: string) => `單號 ${id}` },
    grants: { title: "授權總覽" },
    misQueue: { title: "MIS 佇列", settings: "系統設定" },
    misCheck: { title: "MIS 檢查", meta: (id: string) => `單號 ${id}` },
    settings: { title: "系統設定" },
    auditSearch: { title: "稽核查詢" },
    auditEvidence: { title: "證據頁", meta: (id: string) => `單號 ${id}` },
    notFound: {
      title: "找不到這個頁面",
      body: "網址可能打錯了，或這個頁面已經不存在。",
      home: "回到首頁",
    },
  },
} as const;
