/**
 * 簽章 cookie：內容是 JSON，以 HMAC-SHA256 簽章（不加密，所以不放敏感資料）。
 * 伺服器不存 session；登出＝清掉 cookie。要能從伺服器端撤銷，需另加儲存（見 README）。
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface SessionData {
  /** 隨機識別碼，只用來串 log 與稽核，不是憑證。 */
  sid: string;
  /** actor id。 */
  sub: string;
  /** 登入方式。 */
  amr: 'dev' | 'oidc';
  /** 簽發時間（秒）。 */
  iat: number;
  /** 絕對到期時間（秒）。 */
  exp: number;
  /** 最後活動時間（秒）；閒置逾時用。 */
  seen: number;
  /** MFA step-up 驗證時間（秒）；沒驗證過為 null。 */
  mfa: number | null;
}

const VERSION = 'v1';

function mac(purpose: string, payload: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(`${VERSION}|${purpose}|${payload}`).digest();
}

/** 把任意 JSON 物件簽成字串。purpose 用來區隔不同用途的 cookie，避免互相冒用。 */
export function sign(purpose: string, data: unknown, secret: string): string {
  const payload = Buffer.from(JSON.stringify(data), 'utf8').toString('base64url');
  return `${VERSION}.${payload}.${mac(purpose, payload, secret).toString('base64url')}`;
}

/** 驗章並解出內容；任何不對都回 null。 */
export function verify<T>(purpose: string, token: string | undefined, secrets: readonly string[]): T | null {
  if (!token || token.length > 4096) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return null;
  const payload = parts[1] as string;
  const given = Buffer.from(parts[2] as string, 'base64url');
  const ok = secrets.some((secret) => {
    const expected = mac(purpose, payload, secret);
    return expected.length === given.length && timingSafeEqual(expected, given);
  });
  if (!ok) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}

export function newSession(sub: string, amr: SessionData['amr'], nowSec: number, ttlSec: number): SessionData {
  return { sid: randomBytes(12).toString('base64url'), sub, amr, iat: nowSec, exp: nowSec + ttlSec, seen: nowSec, mfa: null };
}

const SESSION_PURPOSE = 'session';

export function sealSession(data: SessionData, secret: string): string {
  return sign(SESSION_PURPOSE, data, secret);
}

export function openSession(
  token: string | undefined,
  secrets: readonly string[],
  nowSec: number,
  idleSec: number,
): SessionData | null {
  const data = verify<Partial<SessionData>>(SESSION_PURPOSE, token, secrets);
  if (!data) return null;
  if (
    typeof data.sid !== 'string' ||
    typeof data.sub !== 'string' ||
    data.sub === '' ||
    (data.amr !== 'dev' && data.amr !== 'oidc') ||
    typeof data.iat !== 'number' ||
    typeof data.exp !== 'number' ||
    typeof data.seen !== 'number' ||
    !(data.mfa === null || typeof data.mfa === 'number')
  ) {
    return null;
  }
  if (nowSec >= data.exp) return null;
  if (nowSec - data.seen > idleSec) return null;
  return data as SessionData;
}

// ── Cookie 標頭 ──────────────────────────────────────────────────

export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    // 同名 cookie 以第一個為準（瀏覽器把路徑最精確的排在前面）。
    if (!out.has(name)) out.set(name, value);
  }
  return out;
}

export interface CookieOptions {
  secure: boolean;
  /** 秒；0 代表刪除。不給＝瀏覽器關閉就失效。 */
  maxAge?: number;
  path?: string;
}

/** 值只會是 base64url 與「.」，不需要另外編碼。一律 HttpOnly、SameSite=Lax。 */
export function serializeCookie(name: string, value: string, opts: CookieOptions): string {
  if (!/^[A-Za-z0-9._-]*$/.test(value)) throw new Error('cookie 值含有不允許的字元');
  const parts = [`${name}=${value}`, `Path=${opts.path ?? '/'}`, 'HttpOnly', 'SameSite=Lax'];
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(opts.maxAge))}`);
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}
