/**
 * 錯誤對應：把任何例外變成 HTTP 狀態 + {code, message}。
 *
 * 錯誤有三個來源，各只有一個定義處：
 * 1. 後端自己產生的（未登入、CSRF、MFA…）：本檔的 BACKEND_ERRORS。
 * 2. SQL function 丟的業務錯誤：資料庫的錯誤目錄，啟動時讀進來（見 server.ts）。
 * 3. PostgreSQL 內建的 SQLSTATE（轉型失敗、逾時…）：src/contract/errors.ts。
 * 其餘一律 500，原始訊息只進 log。
 */
import type { ErrorContract, ErrorRule } from './routing/types.ts';

/** 後端自己會回的錯誤：代碼 → [HTTP 狀態, 給使用者看的訊息]。 */
export const BACKEND_ERRORS = {
  bad_request: [400, '請求格式不正確'],
  actor_id_required: [400, '請提供 actor_id'],
  code_required: [400, '請輸入驗證碼'],
  unauthenticated: [401, '請先登入'],
  csrf_header_missing: [403, '請求缺少必要的標頭'],
  csrf_origin_mismatch: [403, '請求來源不被允許'],
  mfa_required: [403, '這個動作需要再驗證一次身分'],
  not_found: [404, '找不到這個網址'],
  mfa_not_enrolled: [409, '你還沒有設定多因子驗證，請聯絡系統管理員'],
  payload_too_large: [413, '送出的內容太大'],
  unsupported_media_type: [415, '只接受 JSON'],
  mfa_invalid: [422, '驗證碼不正確'],
  too_many_requests: [429, '嘗試太多次，請稍後再試'],
  mfa_locked: [429, '驗證碼輸入錯誤太多次，請稍後再試'],
  internal_error: [500, '系統發生錯誤，請稍後再試'],
  oidc_unavailable: [502, '單一登入暫時無法使用，請稍後再試'],
  oidc_not_configured: [503, '單一登入尚未設定完成，請聯絡系統管理員'],
  service_unavailable: [503, '系統暫時無法使用，請稍後再試'],
} as const satisfies Record<string, readonly [number, string]>;

export type BackendErrorCode = keyof typeof BACKEND_ERRORS;

export interface HttpErrorBody {
  code: string;
  message: string;
}

export function errorBody(code: BackendErrorCode): HttpErrorBody {
  return { code, message: BACKEND_ERRORS[code][1] };
}

/** 後端自己丟的錯誤。訊息來自 BACKEND_ERRORS，可以直接回給使用者。 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: BackendErrorCode;
  readonly headers: Record<string, string>;

  constructor(code: BackendErrorCode, headers: Record<string, string> = {}) {
    super(BACKEND_ERRORS[code][1]);
    this.name = 'HttpError';
    this.status = BACKEND_ERRORS[code][0];
    this.code = code;
    this.headers = headers;
  }
}

/** 429：附上 Retry-After。 */
export function tooMany(code: 'too_many_requests' | 'mfa_locked', retryAfterSec: number): HttpError {
  return new HttpError(code, { 'retry-after': String(Math.max(1, retryAfterSec)) });
}

/** 資料庫錯誤目錄的一筆（由 SQL function 提供；見 systemCalls.errorCatalog）。 */
export interface CatalogEntry {
  code: string;
  sqlstate: string;
  status: number;
  message: string;
}

export interface MappedError {
  status: number;
  body: HttpErrorBody;
  headers: Record<string, string>;
  /** business：SQL function 刻意丟的；client：請求本身有問題；internal：其餘。決定 log 等級。 */
  kind: 'business' | 'client' | 'internal';
  /** 只進 log，不回給使用者。 */
  sqlstate?: string;
}

interface PgLikeError {
  code: string;
  message: string;
  detail?: string;
}

/** SQL 的 message 長得像「代碼」（例：CASE_NOT_FOUND、not_your_turn）而不是一句話。 */
const CODE_LIKE = /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/;

const FASTIFY_ERRORS: Record<string, BackendErrorCode> = {
  FST_ERR_CTP_BODY_TOO_LARGE: 'payload_too_large',
  FST_ERR_CTP_INVALID_MEDIA_TYPE: 'unsupported_media_type',
};

function isPgError(err: unknown): err is PgLikeError {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; severity?: unknown };
  // pg 的 DatabaseError 一定有 severity；沒有的話就算 code 長得像 SQLSTATE 也不是資料庫丟的。
  return typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code) && typeof e.severity === 'string';
}

function backend(code: BackendErrorCode, headers: Record<string, string> = {}): MappedError {
  const status = BACKEND_ERRORS[code][0];
  return { status, body: errorBody(code), headers, kind: status >= 500 ? 'internal' : 'client' };
}

export function validateCatalog(entries: readonly CatalogEntry[]): void {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    const where = `錯誤代碼 ${JSON.stringify(e.code)}`;
    if (typeof e.code !== 'string' || !CODE_LIKE.test(e.code)) problems.push(`${where}：代碼格式不對`);
    if (seen.has(e.code)) problems.push(`${where}：重複`);
    seen.add(e.code);
    if (typeof e.sqlstate !== 'string' || !/^[0-9A-Z]{5}$/.test(e.sqlstate)) problems.push(`${where}：SQLSTATE 必須是 5 碼`);
    if (!Number.isInteger(e.status) || e.status < 400 || e.status > 599) problems.push(`${where}：HTTP 狀態必須是 400–599`);
    if (typeof e.message !== 'string' || e.message === '') problems.push(`${where}：缺少訊息`);
  }
  if (problems.length > 0) throw new Error(`錯誤目錄有問題：\n${problems.map((p) => `  - ${p}`).join('\n')}`);
}

export class ErrorMapper {
  private readonly builtin: ErrorContract;
  private readonly byCode = new Map<string, CatalogEntry>();
  private readonly bySqlstate = new Map<string, CatalogEntry[]>();

  constructor(builtin: ErrorContract, catalog: readonly CatalogEntry[] = []) {
    validateCatalog(catalog);
    this.builtin = builtin;
    for (const entry of catalog) {
      this.byCode.set(entry.code, entry);
      this.bySqlstate.set(entry.sqlstate, [...(this.bySqlstate.get(entry.sqlstate) ?? []), entry]);
    }
  }

  get catalogSize(): number {
    return this.byCode.size;
  }

  map(err: unknown): MappedError {
    if (err instanceof HttpError) return backend(err.code, err.headers);
    if (isPgError(err)) return this.mapPg(err);
    return mapOther(err);
  }

  private mapPg(err: PgLikeError): MappedError {
    const entry = this.findCatalogEntry(err);
    if (entry) return fromCatalog(entry, err);
    const rule = this.builtin.exact[err.code] ?? this.builtin.classes[err.code.slice(0, 2)];
    if (rule) return fromRule(rule, err);
    return { ...backend('internal_error'), sqlstate: err.code };
  }

  /** 先用 message 當代碼找；找不到再看這個 SQLSTATE 是不是只對應一個代碼。 */
  private findCatalogEntry(err: PgLikeError): CatalogEntry | undefined {
    const named = this.byCode.get(err.message);
    if (named && named.sqlstate === err.code) return named;
    const sameState = this.bySqlstate.get(err.code);
    return sameState?.length === 1 ? sameState[0] : undefined;
  }
}

/** 給人看的訊息：SQL 有給 detail 就用 detail；message 本身是一句話就用它；否則用預設值。 */
function humanMessage(err: PgLikeError, fallback: string): string {
  if (err.detail) return err.detail;
  return CODE_LIKE.test(err.message) ? fallback : err.message;
}

function fromCatalog(entry: CatalogEntry, err: PgLikeError): MappedError {
  const internal = entry.status >= 500;
  return {
    status: entry.status,
    // 5xx 不外露 SQL 端的文字，只回目錄裡的訊息。
    body: { code: entry.code, message: internal ? entry.message : humanMessage(err, entry.message) },
    headers: {},
    kind: internal ? 'internal' : 'business',
    sqlstate: err.code,
  };
}

function fromRule(rule: ErrorRule, err: PgLikeError): MappedError {
  const base = { status: rule.status, headers: {}, sqlstate: err.code };
  if (!rule.expose) {
    const kind = rule.status >= 500 ? ('internal' as const) : ('client' as const);
    return { ...base, body: { code: rule.code, message: rule.message }, kind };
  }
  const code = CODE_LIKE.test(err.message) ? err.message : rule.code;
  return { ...base, body: { code, message: humanMessage(err, rule.message) }, kind: 'business' };
}

/** 不是資料庫丟的：Fastify 的請求錯誤（4xx，只回固定文字），其餘都是 500。 */
function mapOther(err: unknown): MappedError {
  if (typeof err !== 'object' || err === null) return backend('internal_error');
  const e = err as { code?: unknown; statusCode?: unknown };
  const known = typeof e.code === 'string' ? FASTIFY_ERRORS[e.code] : undefined;
  if (known) return backend(known);
  if (typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500) {
    return { ...backend('bad_request'), status: e.statusCode };
  }
  return backend('internal_error');
}
