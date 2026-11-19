/** 安全標頭與 CSRF 檢查。 */
import type { FastifyRequest } from 'fastify';
import type { Config } from '../config.ts';
import { HttpError } from '../errors.ts';

/** 每個回應都會帶的標頭（helmet 那一類）。 */
export function securityHeaders(config: Config): Record<string, string> {
  const headers: Record<string, string> = {
    'content-security-policy': config.contentSecurityPolicy,
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'x-permitted-cross-domain-policies': 'none',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    // API 回應預設不快取；靜態檔另外覆寫。
    'cache-control': 'no-store',
  };
  // 只有在走 HTTPS（cookie 設了 Secure）時才送 HSTS。
  if (config.cookieSecure) headers['strict-transport-security'] = 'max-age=31536000; includeSubDomains';
  return headers;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** 會改資料的請求必須帶這個標頭（值不限，不能是空的）。跨站的表單送不出自訂標頭。 */
export const CSRF_HEADER = 'x-requested-with';

function header(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * CSRF 防護（兩道都要過）：
 * 1. 非 GET／HEAD／OPTIONS 一定要帶自訂標頭 X-Requested-With。
 * 2. 瀏覽器有送 Origin 就必須是本站：
 *    有設 PUBLIC_ORIGIN → 必須等於它（或在 ALLOWED_ORIGINS 裡）；
 *    沒設 → Origin 的主機必須等於這個請求的 Host。
 *    沒送 Origin 但有 Sec-Fetch-Site → 必須是 same-origin 或 none。
 */
export function checkCsrf(req: FastifyRequest, config: Config): void {
  if (SAFE_METHODS.has(req.method)) return;

  const custom = header(req, CSRF_HEADER);
  if (custom === undefined || custom.trim() === '') {
    throw new HttpError(403, 'csrf_header_missing', '請求缺少必要的標頭');
  }

  const origin = header(req, 'origin');
  if (origin !== undefined) {
    if (!originAllowed(origin, req, config)) {
      throw new HttpError(403, 'csrf_origin_mismatch', '請求來源不被允許');
    }
    return;
  }
  const site = header(req, 'sec-fetch-site');
  if (site !== undefined && site !== 'same-origin' && site !== 'none') {
    throw new HttpError(403, 'csrf_origin_mismatch', '請求來源不被允許');
  }
}

function originAllowed(origin: string, req: FastifyRequest, config: Config): boolean {
  if (config.allowedOrigins.includes(origin)) return true;
  if (config.publicOrigin !== null) return origin === config.publicOrigin;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  return host !== '' && host === req.host;
}
