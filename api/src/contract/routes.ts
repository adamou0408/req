/**
 * ★ 契約檔：路由表。照 docs/api.md 把表填滿即可，不需要改其他程式。
 *
 * 一列＝一個 HTTP 端點對一個 SQL function：
 *   {method, path, fn, auth, args, mfa?, result?, status?, rateLimit?}
 * 呼叫時會變成 select api.<fn>(p_actor, ...args(req))；p_actor 由 session 帶入，不用寫在 args 裡。
 * 欄位說明見 src/routing/types.ts。
 *
 * 注意：
 * - 路徑會自動加上 API_PREFIX（預設 /api）。
 * - args 只做「取值、排順序」，不做業務判斷；檢查一律交給 SQL function。
 * - 參數是 jsonb 時用 json() 包起來。pg 驅動會把 JS 陣列轉成 PostgreSQL 陣列（不是 JSON），
 *   所以陣列或「可能是陣列」的值一定要包。
 * - 稽核要記的 IP、裝置從 r.ctx 取（ip、device、mfaVerified、mfaVerifiedAt）。
 *
 * 下面三列是範例（function 名稱與參數都是假設），契約定案後換掉。
 */
import type { RouteDef } from '../routing/types.ts';

/** 把值轉成 JSON 文字，給 jsonb 參數用。undefined 當成 null。 */
export const json = (v: unknown): string => JSON.stringify(v ?? null);

export const routes: RouteDef[] = [
  // 範例 1：讀取。GET /api/requests/:id → api.request_get(p_actor, p_id)
  {
    method: 'GET',
    path: '/requests/:id',
    fn: 'request_get',
    auth: 'user',
    args: (r) => [r.params.id],
  },

  // 範例 2：寫入，整包 body 當 jsonb，並帶稽核欄位。回 201。
  {
    method: 'POST',
    path: '/requests',
    fn: 'request_create',
    auth: 'user',
    status: 201,
    args: (r) => [json(r.body), r.ctx.ip, r.ctx.device],
  },

  // 範例 3：核准，需要 MFA step-up（沒驗證或已過期回 403 mfa_required）。
  {
    method: 'POST',
    path: '/requests/:id/approve',
    fn: 'request_approve',
    auth: 'user',
    mfa: true,
    args: (r) => [r.params.id, r.body.comment ?? null, r.ctx.ip, r.ctx.device],
  },
];
