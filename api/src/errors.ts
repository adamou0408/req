/**
 * 錯誤對應：把任何例外變成 HTTP 狀態 + {code, message}。
 * 對應表本身在 src/contract/errors.ts；這裡只有機制。
 */
import type { ErrorContract, ErrorRule } from './routing/types.ts';

export interface HttpErrorBody {
  code: string;
  message: string;
}

/** 後端自己丟的錯誤（未登入、CSRF、MFA 未驗證…）。訊息是寫死的，可以直接回給使用者。 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly headers: Record<string, string>;
  constructor(status: number, code: string, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

export const unauthorized = (): HttpError => new HttpError(401, 'unauthenticated', '請先登入');
export const badRequest = (code: string, message: string): HttpError => new HttpError(400, code, message);

export interface MappedError {
  status: number;
  body: HttpErrorBody;
  headers: Record<string, string>;
  /** 'business'：SQL function 刻意丟的；'client'：請求本身有問題；'internal'：其餘。決定 log 等級。 */
  kind: 'business' | 'client' | 'internal';
  /** 只進 log，不回給使用者。 */
  sqlstate?: string;
}

const INTERNAL: HttpErrorBody = { code: 'internal_error', message: '系統發生錯誤，請稍後再試' };

/** SQL 的 message 長得像「訊息代碼」才當 code 用（例：request_not_found）。 */
const MESSAGE_CODE = /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/;

interface PgLikeError {
  code: string;
  message: string;
  detail?: string;
}

function isPgError(err: unknown): err is PgLikeError {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; severity?: unknown; message?: unknown };
  // pg 的 DatabaseError 一定有 severity；只有 5 碼 SQLSTATE 才算。
  return typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code) && typeof e.severity === 'string';
}

function findRule(contract: ErrorContract, sqlstate: string): ErrorRule | undefined {
  return contract.exact[sqlstate] ?? contract.classes[sqlstate.slice(0, 2)];
}

function fromRule(rule: ErrorRule, err: PgLikeError): MappedError {
  const fallbackCode = rule.code ?? 'error';
  const fallbackMessage = rule.message ?? '無法完成這個操作';
  if (!rule.expose) {
    // 不外露：只回對應表裡寫死的文字。
    return {
      status: rule.status,
      body: { code: fallbackCode, message: fallbackMessage },
      headers: {},
      kind: rule.status >= 500 ? 'internal' : 'client',
      sqlstate: err.code,
    };
  }
  // 外露：SQL function 刻意 raise 的。message 是訊息代碼，detail 是給人看的說明。
  const looksLikeCode = MESSAGE_CODE.test(err.message);
  return {
    status: rule.status,
    body: {
      code: looksLikeCode ? err.message : fallbackCode,
      message: err.detail ?? (looksLikeCode ? fallbackMessage : err.message),
    },
    headers: {},
    kind: 'business',
    sqlstate: err.code,
  };
}

const FASTIFY_CLIENT_ERRORS: Record<string, HttpErrorBody & { status: number }> = {
  FST_ERR_CTP_BODY_TOO_LARGE: { status: 413, code: 'payload_too_large', message: '送出的內容太大' },
  FST_ERR_CTP_INVALID_MEDIA_TYPE: { status: 415, code: 'unsupported_media_type', message: '只接受 JSON' },
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: { status: 400, code: 'bad_request', message: '請求格式不正確' },
  FST_ERR_CTP_EMPTY_JSON_BODY: { status: 400, code: 'bad_request', message: '請求格式不正確' },
  FST_ERR_CTP_INVALID_JSON_BODY: { status: 400, code: 'bad_request', message: '請求格式不正確' },
};

/** 連不上資料庫（pg 驅動或 Node socket 層的錯誤，沒有 SQLSTATE）。 */
const CONNECTION_ERRNO = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EHOSTUNREACH']);

export function mapError(err: unknown, contract: ErrorContract): MappedError {
  if (err instanceof HttpError) {
    return {
      status: err.status,
      body: { code: err.code, message: err.message },
      headers: err.headers,
      kind: err.status >= 500 ? 'internal' : 'client',
    };
  }

  if (isPgError(err)) {
    const rule = findRule(contract, err.code);
    if (rule) return fromRule(rule, err);
    return { status: 500, body: INTERNAL, headers: {}, kind: 'internal', sqlstate: err.code };
  }

  if (typeof err === 'object' && err !== null) {
    const e = err as { code?: unknown; statusCode?: unknown; message?: unknown };
    if (typeof e.code === 'string') {
      const known = FASTIFY_CLIENT_ERRORS[e.code];
      if (known) {
        return { status: known.status, body: { code: known.code, message: known.message }, headers: {}, kind: 'client' };
      }
      if (CONNECTION_ERRNO.has(e.code)) {
        return {
          status: 503,
          body: { code: 'service_unavailable', message: '系統暫時無法使用，請稍後再試' },
          headers: {},
          kind: 'internal',
        };
      }
    }
    // Fastify 其餘的 4xx（JSON 語法錯誤等）：不回原始訊息，只回固定文字。
    if (typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500) {
      return {
        status: e.statusCode,
        body: { code: 'bad_request', message: '請求格式不正確' },
        headers: {},
        kind: 'client',
      };
    }
  }

  return { status: 500, body: INTERNAL, headers: {}, kind: 'internal' };
}
