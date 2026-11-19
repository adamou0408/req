/**
 * 站內路徑的唯一來源。路由設定、導覽列、頁面上的連結都從這裡取，
 * 之後畫面契約調整路徑時只改這個檔。
 */
export const PATHS = {
  home: "/",
  login: "/login",
  requestNew: "/requests/new",
  request: (id: string) => `/requests/${id}`,
  approvals: "/approvals",
  approval: (id: string) => `/approvals/${id}`,
  grants: "/grants",
  fulfilment: "/fulfilment",
  fulfilmentCase: (id: string) => `/fulfilment/${id}`,
  settings: "/settings",
  audit: "/audit",
  auditEvidence: (id: string) => `/audit/${id}`,
  devComponents: "/dev/components",
} as const;

/** 路由樣式裡代表「單號」的參數名稱。 */
export const ID_PARAM = "id";
export const ID_PATTERN = `:${ID_PARAM}`;
