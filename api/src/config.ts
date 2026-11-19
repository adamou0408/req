/**
 * 環境變數設定：啟動時一次讀完、一次驗證，缺少或不合法就把所有問題一起列出來。
 * 其他程式只拿 Config 物件，不直接讀 process.env。
 */

export type NodeEnv = 'development' | 'test' | 'production';
export type AuthMode = 'dev' | 'oidc';
export type MailMode = 'console' | 'smtp';
export type DcMode = 'mock' | 'manual';
export type MfaMode = 'dev' | 'totp';

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scope: string;
  /** 身分提供者走 http://（只有非正式環境接模擬器時才允許）。 */
  allowInsecure: boolean;
}

export interface SmtpConfig {
  url: string;
  from: string;
}

export interface Config {
  nodeEnv: NodeEnv;
  isProduction: boolean;
  logLevel: string;

  host: string;
  port: number;
  /** API 路徑前綴（預設 /api）；/healthz 另外固定掛在根目錄。 */
  apiPrefix: string;
  /** Fastify trustProxy：false｜true｜跳數｜逗號分隔的 IP/CIDR。 */
  trustProxy: boolean | number | string;
  /** 對外網址（例：https://das.example.com）。設定後 CSRF 的 Origin 檢查以它為準。 */
  publicOrigin: string | null;
  /** 額外允許的 Origin（開發時前端 dev server 用）。 */
  allowedOrigins: string[];
  bodyLimitBytes: number;
  contentSecurityPolicy: string;

  databaseUrl: string;
  dbPoolMax: number;
  dbStatementTimeoutMs: number;

  /** 第一把用來簽章，全部都可用來驗證（輪替金鑰用）。 */
  sessionSecrets: string[];
  sessionTtlSec: number;
  sessionIdleSec: number;
  cookieName: string;
  cookieSecure: boolean;

  authMode: AuthMode;
  /** AUTH_MODE=oidc 且 OIDC_* 都有填才有值；否則 OIDC 登入不啟用。 */
  oidc: OidcConfig | null;
  /** AUTH_MODE=oidc 但設定不全時，缺哪些變數（啟動時記 log 用）。 */
  oidcMissing: string[];

  mfaMode: MfaMode;
  mfaTtlSec: number;
  mfaDevCode: string;

  mailMode: MailMode;
  smtp: SmtpConfig | null;

  dcMode: DcMode;

  directoryFile: string | null;
  catalogFile: string | null;

  rateLimitMax: number;
  rateLimitWindowSec: number;

  schedulerEnabled: boolean;
  schedulerIntervalSec: number;
  outboxEnabled: boolean;
  outboxIntervalSec: number;
  outboxBatchSize: number;
  outboxRetryBaseSec: number;
  outboxRetryMaxSec: number;

  /** 前端 build 產物目錄；有設定才由後端提供靜態檔與 SPA fallback。 */
  webDist: string | null;
}

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`設定錯誤，無法啟動：\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

type Env = Record<string, string | undefined>;

const DEFAULT_CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** 範例檔裡的佔位字串；正式環境出現就拒絕啟動。 */
const PLACEHOLDER_SECRET = /change[-_ ]?me|example|placeholder/i;

export function loadConfig(env: Env = process.env): Config {
  const problems: string[] = [];

  const raw = (name: string): string | undefined => {
    const v = env[name];
    return v === undefined || v.trim() === '' ? undefined : v.trim();
  };
  const required = (name: string): string => {
    const v = raw(name);
    if (v === undefined) problems.push(`缺少環境變數 ${name}`);
    return v ?? '';
  };
  const oneOf = <T extends string>(name: string, allowed: readonly T[], fallback?: T): T => {
    const v = raw(name);
    if (v === undefined) {
      if (fallback !== undefined) return fallback;
      problems.push(`缺少環境變數 ${name}（可用值：${allowed.join('｜')}）`);
      return allowed[0] as T;
    }
    if (!(allowed as readonly string[]).includes(v)) {
      problems.push(`${name}=${v} 不合法（可用值：${allowed.join('｜')}）`);
      return allowed[0] as T;
    }
    return v as T;
  };
  const int = (name: string, opts: { min: number; max: number; fallback?: number }): number => {
    const v = raw(name);
    if (v === undefined) {
      if (opts.fallback !== undefined) return opts.fallback;
      problems.push(`缺少環境變數 ${name}（整數 ${opts.min}–${opts.max}）`);
      return opts.min;
    }
    if (!/^\d+$/.test(v)) {
      problems.push(`${name}=${v} 必須是整數（${opts.min}–${opts.max}）`);
      return opts.min;
    }
    const n = Number(v);
    if (n < opts.min || n > opts.max) {
      problems.push(`${name}=${v} 超出範圍（${opts.min}–${opts.max}）`);
      return opts.min;
    }
    return n;
  };
  const bool = (name: string, fallback: boolean): boolean => {
    const v = raw(name)?.toLowerCase();
    if (v === undefined) return fallback;
    if (['true', '1', 'yes', 'on'].includes(v)) return true;
    if (['false', '0', 'no', 'off'].includes(v)) return false;
    problems.push(`${name}=${v} 必須是 true 或 false`);
    return fallback;
  };
  const origin = (name: string, value: string): string | null => {
    try {
      const u = new URL(value);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocol');
      if (u.origin !== value.replace(/\/$/, '')) throw new Error('not an origin');
      return u.origin;
    } catch {
      problems.push(`${name} 必須是 origin（例：https://das.example.com，不含路徑），目前是 ${value}`);
      return null;
    }
  };

  const nodeEnv = oneOf<NodeEnv>('NODE_ENV', ['development', 'test', 'production'], 'development');
  const isProduction = nodeEnv === 'production';

  // ── 一定要給的 ────────────────────────────────────────────────
  const databaseUrl = required('DATABASE_URL');
  if (databaseUrl && !/^postgres(ql)?:\/\//.test(databaseUrl)) {
    problems.push('DATABASE_URL 必須以 postgres:// 或 postgresql:// 開頭');
  }
  const port = int('PORT', { min: 1, max: 65535 });
  const sessionSecrets = required('SESSION_SECRET')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  for (const s of sessionSecrets) {
    if (s.length < 32) problems.push('SESSION_SECRET 每一把至少 32 個字元');
    else if (isProduction && PLACEHOLDER_SECRET.test(s)) {
      problems.push('SESSION_SECRET 看起來是範例值；正式環境請換成隨機字串');
    }
  }
  const authMode = oneOf<AuthMode>('AUTH_MODE', ['dev', 'oidc']);
  const mailMode = oneOf<MailMode>('MAIL_MODE', ['console', 'smtp']);
  const dcMode = oneOf<DcMode>('DC_MODE', ['mock', 'manual']);
  const mfaMode = oneOf<MfaMode>('MFA_MODE', ['dev', 'totp']);
  const schedulerIntervalSec = int('SCHEDULER_INTERVAL_SEC', { min: 1, max: 86400 });

  // ── 正式環境的禁止事項 ────────────────────────────────────────
  if (isProduction && authMode === 'dev') {
    problems.push('NODE_ENV=production 時禁止 AUTH_MODE=dev');
  }
  if (isProduction && mfaMode === 'dev') {
    problems.push('NODE_ENV=production 時禁止 MFA_MODE=dev');
  }

  // ── HTTP ──────────────────────────────────────────────────────
  const host = raw('HOST') ?? '0.0.0.0';
  let apiPrefix = raw('API_PREFIX') ?? '/api';
  if (apiPrefix === '/') apiPrefix = '';
  if (apiPrefix !== '' && !/^(\/[A-Za-z0-9_-]+)+$/.test(apiPrefix)) {
    problems.push(`API_PREFIX=${apiPrefix} 不合法（例：/api；不要結尾斜線）`);
  }
  const trustProxyRaw = raw('TRUST_PROXY') ?? 'false';
  let trustProxy: boolean | number | string;
  if (trustProxyRaw === 'true') trustProxy = true;
  else if (trustProxyRaw === 'false') trustProxy = false;
  else if (/^\d+$/.test(trustProxyRaw)) trustProxy = Number(trustProxyRaw);
  else trustProxy = trustProxyRaw;

  const publicOriginRaw = raw('PUBLIC_ORIGIN');
  const publicOrigin = publicOriginRaw ? origin('PUBLIC_ORIGIN', publicOriginRaw) : null;
  const allowedOrigins = (raw('ALLOWED_ORIGINS') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((s) => origin('ALLOWED_ORIGINS', s))
    .filter((s): s is string => s !== null);

  // ── Session ───────────────────────────────────────────────────
  const cookieSecure = bool('COOKIE_SECURE', isProduction);
  const cookieNameDefault = cookieSecure ? '__Host-das_session' : 'das_session';
  const cookieName = raw('COOKIE_NAME') ?? cookieNameDefault;
  if (!/^[A-Za-z0-9_-]+$/.test(cookieName)) problems.push(`COOKIE_NAME=${cookieName} 不合法`);
  if (cookieName.startsWith('__Host-') && !cookieSecure) {
    problems.push('COOKIE_NAME 以 __Host- 開頭時 COOKIE_SECURE 必須是 true');
  }

  // ── OIDC ──────────────────────────────────────────────────────
  let oidc: OidcConfig | null = null;
  const oidcMissing: string[] = [];
  if (authMode === 'oidc') {
    const issuer = raw('OIDC_ISSUER');
    const clientId = raw('OIDC_CLIENT_ID');
    const clientSecret = raw('OIDC_CLIENT_SECRET');
    const redirectUri =
      raw('OIDC_REDIRECT_URI') ??
      (publicOrigin ? `${publicOrigin}${apiPrefix}/auth/oidc/callback` : undefined);
    if (!issuer) oidcMissing.push('OIDC_ISSUER');
    if (!clientId) oidcMissing.push('OIDC_CLIENT_ID');
    if (!clientSecret) oidcMissing.push('OIDC_CLIENT_SECRET');
    if (!redirectUri) oidcMissing.push('OIDC_REDIRECT_URI（或 PUBLIC_ORIGIN）');
    if (issuer && clientId && clientSecret && redirectUri) {
      let ok = true;
      for (const [name, value] of [
        ['OIDC_ISSUER', issuer],
        ['OIDC_REDIRECT_URI', redirectUri],
      ] as const) {
        if (!URL.canParse(value)) {
          problems.push(`${name}=${value} 不是合法的 URL`);
          ok = false;
        }
      }
      const insecure = ok && new URL(issuer).protocol === 'http:';
      if (insecure && isProduction) {
        problems.push('NODE_ENV=production 時 OIDC_ISSUER 必須是 https://');
        ok = false;
      }
      if (ok) {
        oidc = {
          issuer,
          clientId,
          clientSecret,
          redirectUri,
          scope: raw('OIDC_SCOPE') ?? 'openid profile email',
          allowInsecure: insecure,
        };
      }
    }
  }

  // ── Mail ──────────────────────────────────────────────────────
  let smtp: SmtpConfig | null = null;
  if (mailMode === 'smtp') {
    const url = required('SMTP_URL');
    const from = required('MAIL_FROM');
    if (url && !/^smtps?:\/\//.test(url)) problems.push('SMTP_URL 必須以 smtp:// 或 smtps:// 開頭');
    if (url && from) smtp = { url, from };
  }

  const config: Config = {
    nodeEnv,
    isProduction,
    logLevel: oneOf('LOG_LEVEL', ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'], 'info'),

    host,
    port,
    apiPrefix,
    trustProxy,
    publicOrigin,
    allowedOrigins,
    bodyLimitBytes: int('BODY_LIMIT_BYTES', { min: 1024, max: 50 * 1024 * 1024, fallback: 1024 * 1024 }),
    contentSecurityPolicy: raw('CONTENT_SECURITY_POLICY') ?? DEFAULT_CSP,

    databaseUrl,
    dbPoolMax: int('DB_POOL_MAX', { min: 1, max: 200, fallback: 10 }),
    dbStatementTimeoutMs: int('DB_STATEMENT_TIMEOUT_MS', { min: 100, max: 600_000, fallback: 15_000 }),

    sessionSecrets,
    sessionTtlSec: int('SESSION_TTL_SEC', { min: 60, max: 7 * 86400, fallback: 8 * 3600 }),
    sessionIdleSec: int('SESSION_IDLE_SEC', { min: 60, max: 7 * 86400, fallback: 30 * 60 }),
    cookieName,
    cookieSecure,

    authMode,
    oidc,
    oidcMissing,

    mfaMode,
    mfaTtlSec: int('MFA_TTL_SEC', { min: 30, max: 3600, fallback: 300 }),
    mfaDevCode: raw('MFA_DEV_CODE') ?? '000000',

    mailMode,
    smtp,

    dcMode,

    directoryFile: raw('DIRECTORY_FILE') ?? null,
    catalogFile: raw('CATALOG_FILE') ?? null,

    rateLimitMax: int('RATE_LIMIT_MAX', { min: 1, max: 10_000, fallback: 30 }),
    rateLimitWindowSec: int('RATE_LIMIT_WINDOW_SEC', { min: 1, max: 3600, fallback: 60 }),

    schedulerEnabled: bool('SCHEDULER_ENABLED', true),
    schedulerIntervalSec,
    outboxEnabled: bool('OUTBOX_ENABLED', true),
    outboxIntervalSec: int('OUTBOX_INTERVAL_SEC', { min: 1, max: 3600, fallback: 5 }),
    outboxBatchSize: int('OUTBOX_BATCH_SIZE', { min: 1, max: 500, fallback: 20 }),
    outboxRetryBaseSec: int('OUTBOX_RETRY_BASE_SEC', { min: 1, max: 3600, fallback: 60 }),
    outboxRetryMaxSec: int('OUTBOX_RETRY_MAX_SEC', { min: 1, max: 7 * 86400, fallback: 6 * 3600 }),

    webDist: raw('WEB_DIST') ?? null,
  };

  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}
