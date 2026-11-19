import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import { inject } from 'vitest';
import { buildApp } from '../src/app.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { allowedFunctions, createSystemCalls, type Contract, type SystemCalls } from '../src/contract/index.ts';
import { createPool, Db } from '../src/db.ts';
import { DevMfa } from '../src/ports/adapters/mfaDev.ts';
import type { MfaPort } from '../src/ports/mfa.ts';
import type { OidcPort } from '../src/ports/oidc.ts';
import { testContract } from './fixtures/testContract.ts';

export const TEST_SECRET = 'test-secret-0123456789abcdef0123456789abcdef';

export function baseEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: inject('appDbUrl'),
    PORT: '3999',
    SESSION_SECRET: TEST_SECRET,
    AUTH_MODE: 'dev',
    MAIL_MODE: 'console',
    DC_MODE: 'mock',
    MFA_MODE: 'dev',
    SCHEDULER_INTERVAL_SEC: '60',
    // 測試會頻繁登入；要測 rate limit 的案例自己把上限調低。
    RATE_LIMIT_MAX: '1000',
    ...overrides,
  };
}

/** 可以手動撥動的假時鐘。 */
export class FakeClock {
  ms: number;
  constructor(start = Date.parse('2026-01-05T09:00:00Z')) {
    this.ms = start;
  }
  now = (): number => this.ms;
  advanceSec(sec: number): void {
    this.ms += sec * 1000;
  }
}

export interface TestApp {
  app: FastifyInstance;
  config: Config;
  db: Db;
  sys: SystemCalls;
  /** 這個 app 寫出的每一行 log（JSON 文字）。 */
  logs: string[];
  close(): Promise<void>;
}

export interface TestAppOptions {
  env?: Record<string, string | undefined>;
  contract?: Contract;
  now?: () => number;
  mfa?: MfaPort;
  oidc?: OidcPort | null;
  /** 換掉資料庫連線（例：指到不存在的資料庫）。 */
  pool?: pg.Pool;
}

export async function makeApp(opts: TestAppOptions = {}): Promise<TestApp> {
  const config = loadConfig(baseEnv(opts.env));
  const contract = opts.contract ?? testContract;
  const pool = opts.pool ?? createPool(config);
  pool.on('error', () => {});
  const db = new Db(pool, allowedFunctions(contract));
  const sys = createSystemCalls(db, contract.sqlNames, contract.systemActor);
  const logs: string[] = [];
  const app = await buildApp({
    config,
    db,
    contract,
    sys,
    ports: { mfa: opts.mfa ?? new DevMfa(config.mfaDevCode), oidc: opts.oidc ?? null },
    now: opts.now,
    logStream: { write: (line) => void logs.push(line) },
  });
  return {
    app,
    config,
    db,
    sys,
    logs,
    async close() {
      await app.close();
      await pool.end();
    },
  };
}

/** 會改資料的請求預設帶上 CSRF 標頭，和前端的行為一樣。 */
export const CSRF = { 'x-requested-with': 'das-web' };

/** 從回應的 Set-Cookie 取出可以放進下一個請求的 Cookie 標頭。 */
export function cookieFrom(res: LightMyRequestResponse, previous = ''): string {
  const jar = new Map<string, string>();
  for (const part of previous.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) jar.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  const raw = res.headers['set-cookie'];
  for (const line of Array.isArray(raw) ? raw : raw ? [String(raw)] : []) {
    const first = line.split(';')[0] ?? '';
    const eq = first.indexOf('=');
    const name = first.slice(0, eq);
    const value = first.slice(eq + 1);
    if (/max-age=0/i.test(line) || value === '') jar.delete(name);
    else jar.set(name, value);
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

export function setCookieLines(res: LightMyRequestResponse): string[] {
  const raw = res.headers['set-cookie'];
  return Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
}

/** 以 dev-login 登入，回傳 Cookie 標頭。 */
export async function login(app: FastifyInstance, actorId = 'u1', headers: Record<string, string> = {}): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/dev-login',
    headers: { ...CSRF, ...headers },
    payload: { actor_id: actorId },
  });
  if (res.statusCode !== 200) throw new Error(`dev-login 失敗：${res.statusCode} ${res.body}`);
  return cookieFrom(res);
}

export function adminPool(): pg.Pool {
  return new pg.Pool({ connectionString: inject('adminDbUrl'), max: 2 });
}
