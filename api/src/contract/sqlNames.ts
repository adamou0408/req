/**
 * ★ 契約檔：路由表以外、後端自己會呼叫的 SQL function 名稱（都在 schema api）。
 * 核心契約（docs/contract/01-kernel.md）定案後照填。參數順序與回傳欄位在 systemCalls.ts。
 *
 * 目前全部是暫定名稱。值是 null 的代表「契約還沒有這個 function，後端先不呼叫」，
 * 對應的功能會停用，各自的後果寫在欄位說明裡。
 */
export interface SqlNames {
  /** 排程：催辦、升級、到期失效、自動撤銷…全部由這一個 function 處理。 */
  schedulerRun: string;
  /** 通知佇列：領取待寄信件／標記寄出／標記失敗（含下次重試時間）。 */
  outboxClaim: string;
  outboxMarkSent: string;
  outboxMarkFailed: string;
  /** 匯入人員與組織資料（整份 JSON 交給 SQL function 處理）。 */
  directoryImport: string;
  /** 錯誤目錄（代碼、SQLSTATE、訊息、HTTP 狀態）。null＝業務錯誤一律回 500。 */
  errorCatalog: string | null;
  /** SSO 登入後，把身分提供者給的身分對應成 actor id。null＝OIDC 登入無法完成。 */
  authResolveLogin: string | null;
  /** 目前登入者的基本資料（姓名、角色、可用的工作區…），GET /auth/me 會附上。null＝不附。 */
  authMe: string | null;
  /** 開發模式登入頁可以扮演的人員清單。null＝回空清單。 */
  authDevUsers: string | null;
  /** 取得某人的 TOTP 密鑰（base32）。null＝一律視為尚未設定 MFA。 */
  mfaTotpSecret: string | null;
}

export const sqlNames: SqlNames = {
  schedulerRun: 'run_scheduled_jobs',
  outboxClaim: 'outbox_claim',
  outboxMarkSent: 'outbox_mark_sent',
  outboxMarkFailed: 'outbox_mark_failed',
  directoryImport: 'directory_import',
  errorCatalog: null,
  authResolveLogin: null,
  authMe: null,
  authDevUsers: null,
  mfaTotpSecret: null,
};

/**
 * 系統作業（排程、寄信、匯入、讀錯誤目錄）呼叫 api function 時的 p_actor。
 * 契約若規定要用特定的系統帳號，改這裡。
 */
export const SYSTEM_ACTOR: string | null = null;
