/**
 * 契約檔（src/contract/*）用到的型別。契約填表時不需要改這個檔。
 */
import type { FastifyReply } from 'fastify';

export type Device = 'mobile' | 'desktop';

/** 每個請求的脈絡；路由表的 args() 可以取用，傳給 SQL function 當稽核欄位。 */
export interface RouteCtx {
  /** 已登入者的 actor id（session 裡的字串，由 PostgreSQL 依 function 簽章轉型）；未登入為 null。 */
  actor: string | null;
  /** 用戶端 IP（已依 TRUST_PROXY 設定處理 X-Forwarded-For）。 */
  ip: string;
  /** 依 User-Agent 判斷。 */
  device: Device;
  userAgent: string;
  /** MFA step-up 是否仍在有效時間內。 */
  mfaVerified: boolean;
  /** MFA 驗證時間（ISO 8601）；沒驗證過或已過期為 null。 */
  mfaVerifiedAt: string | null;
  /** session 的隨機識別碼（不是 cookie 本身）；未登入為 null。 */
  sessionId: string | null;
  requestId: string;
}

export interface RouteReq {
  params: Record<string, string>;
  query: Record<string, string | string[] | undefined>;
  /** JSON body；沒有 body 時是 {}。頂層不是物件會直接回 400。 */
  body: Record<string, unknown>;
  ctx: RouteCtx;
}

/**
 * SQL function 回傳值怎麼取：
 * - scalar：select api.fn(...)          → 回傳那個值（jsonb 最常見）
 * - row   ：select * from api.fn(...)   → 第一列（沒有列回 null）
 * - rows  ：select * from api.fn(...)   → 全部列
 * - none  ：不回內容（HTTP 204）
 */
export type ResultMode = 'scalar' | 'row' | 'rows' | 'none';

export interface RouteDef {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Fastify 路徑語法（/requests/:id），會自動加上 API_PREFIX。 */
  path: string;
  /** api schema 裡的 function 名稱（不含 schema）。 */
  fn: string;
  /** public：不需登入（p_actor 傳 null）；user：需登入。角色判斷一律在 SQL function 裡。 */
  auth: 'public' | 'user';
  /** p_actor 之後的參數，依 function 簽章的順序。 */
  args: (req: RouteReq) => unknown[];
  /** true：需要有效的 MFA step-up，否則回 403 mfa_required。 */
  mfa?: boolean;
  /** 預設 scalar。 */
  result?: ResultMode;
  /** 成功時的 HTTP 狀態；預設 200（none 為 204）。 */
  status?: number;
  /** true：套用登入用的 rate limit（依 IP）。 */
  rateLimit?: boolean;
  /** 需要自訂回應（下載檔案等）時才用；預設直接把結果轉成 JSON。 */
  respond?: (result: unknown, reply: FastifyReply) => unknown;
}

export interface ErrorRule {
  status: number;
  /**
   * true ：這個 SQLSTATE 是 SQL function 刻意丟的。回應的 code 取自 SQL message（長得像代碼時），
   *        message 取自 SQL detail；沒有就用下面的預設值。
   * false：只回下面寫死的 code／message，SQL 的原始訊息只進 log。
   */
  expose: boolean;
  code: string;
  message: string;
}

/** 不在資料庫錯誤目錄裡的 SQLSTATE 要怎麼回（主要是 PostgreSQL 內建的）。 */
export interface ErrorContract {
  /** 完整 5 碼 SQLSTATE。 */
  exact: Record<string, ErrorRule>;
  /** SQLSTATE 前 2 碼（類別）；exact 沒對到才看這裡。 */
  classes: Record<string, ErrorRule>;
}
