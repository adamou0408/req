/**
 * 通用 handler：依路由表（src/contract/routes.ts）註冊所有端點。
 * 每個端點做的事都一樣：檢查登入與 MFA → args(req) 取參數 → callApi → 回 JSON。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { assertFnName, type Db } from '../db.ts';
import { HttpError, unauthorized } from '../errors.ts';
import type { RateLimiter } from '../http/rateLimit.ts';
import type { RouteDef, RouteReq } from './types.ts';

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const MODES = new Set(['scalar', 'row', 'rows', 'none']);
const JSON_TYPE = 'application/json; charset=utf-8';

/** 啟動時檢查路由表，寫錯就直接起不來，不要等到被呼叫才發現。 */
export function validateRoutes(routes: readonly RouteDef[]): void {
  const problems: string[] = [];
  const seen = new Set<string>();
  routes.forEach((r, i) => {
    const where = `routes[${i}] ${r.method} ${r.path}`;
    if (!METHODS.has(r.method)) problems.push(`${where}：method 不合法`);
    if (typeof r.path !== 'string' || !r.path.startsWith('/')) problems.push(`${where}：path 必須以 / 開頭`);
    try {
      assertFnName(r.fn);
    } catch (err) {
      problems.push(`${where}：${(err as Error).message}`);
    }
    if (r.auth !== 'public' && r.auth !== 'user') problems.push(`${where}：auth 必須是 public 或 user`);
    if (typeof r.args !== 'function') problems.push(`${where}：args 必須是函式`);
    if (r.mfa && r.auth !== 'user') problems.push(`${where}：mfa 只能用在 auth=user 的路由`);
    if (r.result !== undefined && !MODES.has(r.result)) problems.push(`${where}：result 不合法`);
    if (r.status !== undefined && !(Number.isInteger(r.status) && r.status >= 200 && r.status < 400)) {
      problems.push(`${where}：status 必須是 200–399`);
    }
    // /a/:id 與 /a/:key 是同一條路由。
    const key = `${r.method} ${r.path.replace(/:[^/]+/g, ':')}`;
    if (seen.has(key)) problems.push(`${where}：重複的路由`);
    seen.add(key);
  });
  if (problems.length > 0) throw new Error(`路由表有問題：\n${problems.map((p) => `  - ${p}`).join('\n')}`);
}

function plainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export interface RegisterDeps {
  db: Db;
  routes: readonly RouteDef[];
  prefix: string;
  limiter: RateLimiter;
}

export function registerContractRoutes(app: FastifyInstance, deps: RegisterDeps): void {
  validateRoutes(deps.routes);
  for (const def of deps.routes) {
    app.route({
      method: def.method,
      url: `${deps.prefix}${def.path}`,
      handler: (req, reply) => handle(def, deps, req, reply),
    });
  }
}

async function handle(def: RouteDef, deps: RegisterDeps, req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const ctx = req.ctx;
  if (def.rateLimit) {
    const decision = deps.limiter.hit(`route:${def.method}:${def.path}:${ctx.ip}`);
    if (!decision.allowed) {
      throw new HttpError(429, 'too_many_requests', '嘗試太多次，請稍後再試', {
        'retry-after': String(decision.retryAfterSec),
      });
    }
  }
  if (def.auth === 'user' && ctx.actor === null) throw unauthorized();
  if (def.mfa && !ctx.mfaVerified) {
    throw new HttpError(403, 'mfa_required', '這個動作需要再驗證一次身分');
  }

  const rawBody: unknown = req.body;
  if (rawBody !== undefined && rawBody !== null && !plainObject(rawBody)) {
    throw new HttpError(400, 'bad_request', '請求格式不正確');
  }
  const routeReq: RouteReq = {
    params: (req.params ?? {}) as Record<string, string>,
    query: (req.query ?? {}) as Record<string, string | string[] | undefined>,
    body: plainObject(rawBody) ? rawBody : {},
    ctx: {
      actor: ctx.actor,
      ip: ctx.ip,
      device: ctx.device,
      userAgent: ctx.userAgent,
      mfaVerified: ctx.mfaVerified,
      mfaVerifiedAt: ctx.mfaVerifiedAt,
      sessionId: ctx.sessionId,
      requestId: ctx.requestId,
    },
  };

  const args = def.args(routeReq);
  if (!Array.isArray(args)) throw new Error(`${def.method} ${def.path}：args() 必須回傳陣列`);
  // undefined 不能當 SQL 參數；一律當成 null。
  const values = args.map((a) => (a === undefined ? null : a));

  const mode = def.result ?? 'scalar';
  const result = await deps.db.callApi(def.fn, ctx.actor, values, mode);

  if (def.respond) return def.respond(result, reply);
  if (mode === 'none') return reply.code(def.status ?? 204).send();
  return reply
    .code(def.status ?? 200)
    .type(JSON_TYPE)
    .send(JSON.stringify(result ?? null));
}
