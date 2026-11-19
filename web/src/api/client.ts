/**
 * fetch 包裝：不含任何端點或業務判斷，只負責
 * 帶 cookie、非 GET 加自訂標頭、把錯誤統一成 ApiError、
 * 401 通知身分層、需要 MFA 時向使用者要驗證碼後重試。
 * 與後端契約有關的值（標頭名稱、錯誤代碼）由 endpoints.ts 傳入。
 */
import { t } from "../i18n/zh-Hant";

/** 不是後端回的、由前端自己產生的錯誤代碼。 */
export const CLIENT_ERROR = {
  network: "client_network_error",
  badResponse: "client_bad_response",
  mfaCancelled: "client_mfa_cancelled",
  unexpected: "client_unexpected",
} as const;

export class ApiError extends Error {
  readonly code: string;
  /** HTTP 狀態；連不上後端時為 0。 */
  readonly status: number;
  readonly details: unknown;

  constructor(
    code: string,
    message: string,
    status: number,
    details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

/** 用名稱判斷而不是 instanceof：不同執行環境的 DOMException 不是同一個類別。 */
export function isAbortError(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    value.name === "AbortError"
  );
}

/** MFA 視窗上要讓使用者核對的內容（例如單號、範圍、起迄）。 */
export interface MfaPrompt {
  title?: string;
  summary?: readonly string[];
  confirmLabel?: string;
}

export interface MfaChallenge {
  /** 第幾次要求輸入，從 1 開始。 */
  attempt: number;
  /** 上一次驗證碼被後端拒絕時的錯誤。 */
  error?: ApiError;
  prompt?: MfaPrompt;
}

export interface MfaHandler {
  /** 回傳使用者輸入的驗證碼；使用者取消時回傳 null。 */
  request(challenge: MfaChallenge): Promise<string | null>;
  /** 這一輪 MFA 結束（成功、失敗或取消），可以關掉視窗。 */
  settle(): void;
}

export type QueryValue = string | number | boolean | null | undefined;
export type Query = Record<string, QueryValue | readonly QueryValue[]>;

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  mfa?: MfaPrompt;
  responseType?: "json" | "blob";
}

export interface MfaOptions {
  /** 後端表示「這個動作要先通過 MFA」的錯誤代碼。 */
  requiredCodes: readonly string[];
  /** 後端表示「驗證碼不對，可以再輸入一次」的錯誤代碼。 */
  invalidCodes: readonly string[];
  /** 把驗證碼交給後端驗證的請求（POST）；通過後原本的請求會原樣重送。 */
  verifyRequest: (code: string) => { path: string; body: unknown };
}

export interface ClientOptions {
  baseUrl?: string;
  credentials?: RequestCredentials;
  /** 非 GET 請求一律加上的標頭，後端用來擋跨站請求。 */
  unsafeMethodHeader: { name: string; value: string };
  mfa: MfaOptions;
  fetch?: typeof fetch;
}

export interface ApiClient {
  request<T>(
    method: string,
    path: string,
    options?: RequestOptions,
  ): Promise<T>;
  get<T>(path: string, options?: RequestOptions): Promise<T>;
  post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;
  put<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;
  patch<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;
  delete<T>(path: string, options?: RequestOptions): Promise<T>;
  setUnauthorizedHandler(handler: (() => void) | null): void;
  setMfaHandler(handler: MfaHandler | null): void;
}

const SAFE_METHODS = new Set(["GET", "HEAD"]);

export function buildUrl(baseUrl: string, path: string, query?: Query): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values as readonly QueryValue[]) {
      if (item !== null && item !== undefined) params.append(key, String(item));
    }
  }
  const search = params.toString();
  return `${baseUrl}${path}${search ? `?${search}` : ""}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function pickString(
  source: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = source[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * 後端的錯誤內容統一成 {code, message}。
 * 同時接受 {code, message} 與 {error: {code, message}} 兩種外型；
 * 都不是（例如反向代理回的 HTML）時，用 HTTP 狀態組一個。
 */
export function toApiError(status: number, body: unknown): ApiError {
  const outer = isRecord(body) ? body : {};
  const source = isRecord(outer.error) ? outer.error : outer;
  const code = pickString(source, "code") ?? `HTTP_${status}`;
  const message = pickString(source, "message") ?? t.errors.http(status);
  return new ApiError(code, message, status, source.details);
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function parseSuccess(
  response: Response,
  responseType: "json" | "blob",
): Promise<unknown> {
  if (responseType === "blob") return response.blob();
  const body = await readBody(response);
  const isJson =
    response.headers.get("content-type")?.includes("json") ?? false;
  if (body !== undefined && !isJson) {
    throw new ApiError(
      CLIENT_ERROR.badResponse,
      t.errors.badResponse,
      response.status,
    );
  }
  return body;
}

class HttpClient implements ApiClient {
  private readonly options: ClientOptions;
  private onUnauthorized: (() => void) | null = null;
  private mfaHandler: MfaHandler | null = null;
  private mfaQueue: Promise<unknown> = Promise.resolve();

  constructor(options: ClientOptions) {
    this.options = options;
  }

  setUnauthorizedHandler(handler: (() => void) | null): void {
    this.onUnauthorized = handler;
  }

  setMfaHandler(handler: MfaHandler | null): void {
    this.mfaHandler = handler;
  }

  get<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request("GET", path, options);
  }

  post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request("POST", path, { ...options, body });
  }

  put<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request("PUT", path, { ...options, body });
  }

  patch<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request("PATCH", path, { ...options, body });
  }

  delete<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request("DELETE", path, options);
  }

  async request<T>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const resend = () => this.send(method.toUpperCase(), path, options);
    try {
      return (await this.sendWithMfa(resend, options.mfa)) as T;
    } catch (error) {
      if (this.isSessionExpired(error)) this.onUnauthorized?.();
      throw error;
    }
  }

  private hasCode(error: unknown, codes: readonly string[]): boolean {
    return isApiError(error) && codes.includes(error.code);
  }

  private isSessionExpired(error: unknown): boolean {
    return isApiError(error) && error.status === 401;
  }

  private async sendWithMfa(
    resend: () => Promise<unknown>,
    prompt?: MfaPrompt,
  ): Promise<unknown> {
    try {
      return await resend();
    } catch (error) {
      const handler = this.mfaHandler;
      const needsMfa = this.hasCode(error, this.options.mfa.requiredCodes);
      if (!handler || !needsMfa) throw error;
      return this.exclusive(() => this.retryWithMfa(handler, resend, prompt));
    }
  }

  /** 同一時間只開一個 MFA 視窗；其他需要 MFA 的請求排隊。 */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.mfaQueue.then(task, task);
    this.mfaQueue = run.catch(() => undefined);
    return run;
  }

  /**
   * 向使用者要驗證碼 → 交給後端驗證 → 通過後重送原本的請求。
   * 驗證碼不對就帶著後端的訊息再問一次；輸入幾次會被鎖由後端決定。
   */
  private async retryWithMfa(
    handler: MfaHandler,
    resend: () => Promise<unknown>,
    prompt?: MfaPrompt,
  ): Promise<unknown> {
    let rejected: ApiError | undefined;
    try {
      for (let attempt = 1; ; attempt += 1) {
        const code = await handler.request({
          attempt,
          ...(rejected && { error: rejected }),
          ...(prompt && { prompt }),
        });
        if (code === null) {
          throw new ApiError(CLIENT_ERROR.mfaCancelled, t.errors.mfaCancelled, 0);
        }
        rejected = await this.verifyMfa(code);
        if (!rejected) return await resend();
      }
    } finally {
      handler.settle();
    }
  }

  /** 回傳 undefined 代表通過；回傳錯誤代表驗證碼不對、可以再試。其他錯誤直接丟出。 */
  private async verifyMfa(code: string): Promise<ApiError | undefined> {
    const { path, body } = this.options.mfa.verifyRequest(code);
    try {
      await this.send("POST", path, { body });
      return undefined;
    } catch (error) {
      if (isApiError(error) && this.hasCode(error, this.options.mfa.invalidCodes)) {
        return error;
      }
      throw error;
    }
  }

  private buildInit(method: string, request: RequestOptions): RequestInit {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...request.headers,
    };
    if (!SAFE_METHODS.has(method)) {
      const { name, value } = this.options.unsafeMethodHeader;
      headers[name] = value;
    }
    const init: RequestInit = {
      method,
      headers,
      credentials: this.options.credentials ?? "same-origin",
      signal: request.signal ?? null,
    };
    if (request.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(request.body);
    }
    return init;
  }

  private async send(
    method: string,
    path: string,
    request: RequestOptions,
  ): Promise<unknown> {
    const doFetch = this.options.fetch ?? fetch;
    const url = buildUrl(this.options.baseUrl ?? "", path, request.query);
    let response: Response;
    try {
      response = await doFetch(url, this.buildInit(method, request));
    } catch (cause) {
      if (isAbortError(cause)) throw cause;
      throw new ApiError(CLIENT_ERROR.network, t.errors.network, 0, cause);
    }
    if (!response.ok)
      throw toApiError(response.status, await readBody(response));
    return parseSuccess(response, request.responseType ?? "json");
  }
}


export function createClient(options: ClientOptions): ApiClient {
  return new HttpClient(options);
}
