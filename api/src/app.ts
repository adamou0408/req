/**
 * 組出 Fastify app。所有相依的東西都由外面傳進來（測試時可以換掉）。
 * 這裡不含任何業務判斷：只有安全檢查、身分、把請求轉給 SQL function。
 */
import { randomUUID } from 'node:crypto';
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Config } from './config.ts';
import type { Contract } from './contract/index.ts';
import type { SystemCalls } from './contract/systemCalls.ts';
import type { Db } from './db.ts';
import { mapError } from './errors.ts';
import { registerAuthRoutes } from './http/authRoutes.ts';
import { Sessions } from './http/context.ts';
import { RateLimiter } from './http/rateLimit.ts';
import { checkCsrf, securityHeaders } from './http/security.ts';
import { createStaticSite, type StaticSite } from './http/static.ts';
import type { MfaPort } from './ports/mfa.ts';
import type { OidcPort } from './ports/oidc.ts';
import { registerContractRoutes } from './routing/register.ts';

export interface AppDeps {
  config: Config;
  db: Db;
  contract: Contract;
  sys: SystemCalls;
  ports: { mfa: MfaPort; oidc: OidcPort | null };
  /** 現在時間（毫秒）；測試時可以換成假的時鐘。 */
  now?: () => number;
  /** log 要寫到哪裡；不給＝stdout。測試用。 */
  logStream?: { write(line: string): void };
}

const JSON_TYPE = 'application/json; charset=utf-8';
/** MFA 連續輸入錯誤上限：5 分鐘內 5 次。 */
const MFA_MAX_FAILURES = 5;
const MFA_FAILURE_WINDOW_SEC = 300;

/** 進 log 的錯誤資訊：留訊息與位置，不留 detail／hint（可能含資料內容）。 */
function describeError(err: unknown): Record<string, unknown> {
  if (typeof err !== 'object' || err === null) return { message: String(err) };
  const e = err as Record<string, unknown>;
  const cause = e.cause;
  return {
    type: e.name,
    message: e.message,
    code: e.code,
    where: e.where,
    schema: e.schema,
    table: e.table,
    column: e.column,
    constraint: e.constraint,
    routine: e.routine,
    stack: e.stack,
    cause: cause instanceof Error ? { type: cause.name, message: cause.message, code: (cause as { code?: unknown }).code } : undefined,
  };
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, db, contract, sys, ports } = deps;
  const now = deps.now ?? Date.now;

  const app = Fastify({
    logger: {
      level: config.logLevel,
      base: { service: 'das-api' },
      // ISO 8601（UTC），方便和資料庫的稽核紀錄對時間。
      timestamp: () => `,"time":"${new Date().toISOString()}"`,
      // 保險：就算有人把整個 request 丟進 log，也不會印出憑證。
      redact: {
        paths: ['req.headers.cookie', 'req.headers.authorization', 'headers.cookie', 'headers.authorization', 'res.headers["set-cookie"]'],
        censor: '[已遮蔽]',
      },
      ...(deps.logStream ? { stream: deps.logStream } : {}),
    },
    // 自己記請求 log（下面的 onResponse），內容比較精簡，也不含 query string。
    logController: new LogController({ disableRequestLogging: true }),
    // 不採用用戶端給的 request id。
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    // Fastify 的型別沒列出「跳數」，但執行時支援（proxy-addr）。
    trustProxy: config.trustProxy as boolean | string,
    bodyLimit: config.bodyLimitBytes,
    routerOptions: { maxParamLength: 200 },
  });

  // 只收 JSON。
  app.removeContentTypeParser('text/plain');

  const sessions = new Sessions(config, now);
  const limiter = new RateLimiter(config.rateLimitMax, config.rateLimitWindowSec, now);
  const mfaFailures = new RateLimiter(MFA_MAX_FAILURES, MFA_FAILURE_WINDOW_SEC, now);
  const baseHeaders = securityHeaders(config);
  const staticSite: StaticSite | null = config.webDist ? createStaticSite(config.webDist) : null;

  app.decorateRequest('ctx', null as never);

  app.addHook('onRequest', async (req, reply) => {
    reply.headers(baseHeaders);
    reply.header('x-request-id', req.id);
    req.ctx = sessions.buildContext(req, reply);
    checkCsrf(req, config);
  });

  app.addHook('onResponse', async (req, reply) => {
    const path = req.url.split('?')[0];
    // 健康檢查很頻繁，降到 debug。
    const level = path === '/healthz' || path === `${config.apiPrefix}/healthz` ? 'debug' : 'info';
    req.log[level](
      {
        method: req.method,
        path,
        status: reply.statusCode,
        ms: Math.round(reply.elapsedTime),
        // onRequest 還沒跑完就出錯時（例如網址格式不對）ctx 不存在。
        actor: req.ctx?.actor ?? null,
        ip: req.ip,
        device: req.ctx?.device,
      },
      'request',
    );
  });

  app.setErrorHandler((err, req, reply) => {
    const mapped = mapError(err, contract.errors);
    const info = { status: mapped.status, code: mapped.body.code, sqlstate: mapped.sqlstate };
    if (mapped.kind === 'internal') req.log.error({ ...info, error: describeError(err) }, '請求失敗（內部錯誤）');
    else if (mapped.kind === 'business') req.log.info(info, '請求被 SQL function 拒絕');
    else req.log.info(info, '請求被拒絕');
    return reply.code(mapped.status).headers(mapped.headers).type(JSON_TYPE).send(JSON.stringify(mapped.body));
  });

  const isApiPath = (path: string): boolean =>
    path === '/healthz' ||
    (config.apiPrefix !== '' && (path === config.apiPrefix || path.startsWith(`${config.apiPrefix}/`)));

  app.setNotFoundHandler(async (req, reply) => {
    const path = req.url.split('?')[0] ?? '/';
    if (staticSite && !isApiPath(path) && (await staticSite.serve(req, reply))) return reply;
    return reply
      .code(404)
      .type(JSON_TYPE)
      .send(JSON.stringify({ code: 'not_found', message: '找不到這個網址' }));
  });

  // ── 健康檢查（含資料庫）───────────────────────────────────────
  const health = async (_req: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    try {
      await db.ping();
      return reply.code(200).send({ status: 'ok', db: 'ok' });
    } catch (err) {
      app.log.error({ err: String((err as Error)?.message ?? err) }, '健康檢查：資料庫沒有回應');
      return reply.code(503).send({ status: 'unavailable', db: 'down' });
    }
  };
  app.get('/healthz', health);
  if (config.apiPrefix !== '') app.get(`${config.apiPrefix}/healthz`, health);

  registerAuthRoutes(app, { config, sessions, sys, mfa: ports.mfa, oidc: ports.oidc, limiter, mfaFailures });
  registerContractRoutes(app, { db, routes: contract.routes, prefix: config.apiPrefix, limiter });

  await app.ready();
  return app;
}
