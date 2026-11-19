/**
 * ★ 契約檔：路由表以外、後端自己會呼叫的 SQL function 名稱（都在 schema api）。
 * 照 docs/sql-functions.md 填。參數順序與回傳欄位在 systemCalls.ts。
 *
 * 目前全部是暫定名稱。值設成 null 的代表「契約還沒有這個 function，先不呼叫」。
 */
export interface SqlNames {
  /** 排程：催辦、升級、到期失效、自動撤銷…全部由這一個 function 處理。 */
  schedulerRun: string;
  /** 寄信佇列：領取待寄信件／標記寄出／標記失敗（含下次重試時間）。 */
  outboxClaim: string;
  outboxMarkSent: string;
  outboxMarkFailed: string;
  /** SSO 登入後，把身分提供者給的身分對應成 actor id。null＝OIDC 登入無法完成。 */
  authResolveLogin: string | null;
  /** 目前登入者的基本資料（姓名、角色…），GET /auth/me 會附上。null＝不附。 */
  authMe: string | null;
  /** 取得某人的 TOTP 密鑰（base32）。null＝一律視為尚未設定 MFA。 */
  mfaTotpSecret: string | null;
  /** 匯入人員與組織資料／資料目錄（整份 JSON 交給 SQL function 處理）。 */
  directoryImport: string;
  catalogImport: string;
}

export const sqlNames: SqlNames = {
  schedulerRun: 'run_scheduled_jobs',
  outboxClaim: 'outbox_claim',
  outboxMarkSent: 'outbox_mark_sent',
  outboxMarkFailed: 'outbox_mark_failed',
  authResolveLogin: 'auth_resolve_login',
  authMe: null,
  mfaTotpSecret: 'mfa_totp_secret',
  directoryImport: 'directory_import',
  catalogImport: 'catalog_import',
};

/**
 * 系統作業（排程、寄信、匯入）呼叫 api function 時的 p_actor。
 * 契約若規定要用特定的系統帳號，改這裡。
 */
export const SYSTEM_ACTOR: string | null = null;
