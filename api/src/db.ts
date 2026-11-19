/**
 * db 層：唯一對資料庫下指令的地方。
 * 只會產生 `select api.<fn>($1, $2, ...)`；fn 必須在白名單裡（路由表＋sqlNames），
 * 其餘一律走參數。請求內容永遠不會變成 SQL 文字。
 */
import pg from 'pg';
import type { Config } from './config.ts';
import { HttpError } from './errors.ts';
import type { ResultMode } from './routing/types.ts';

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
/** 整個交易被資料庫退回、可以原封不動重送的錯誤：serialization_failure、deadlock_detected。 */
const RETRYABLE = new Set(['40001', '40P01']);
const MAX_ATTEMPTS = 3;

export function createPool(config: Pick<Config, 'databaseUrl' | 'dbPoolMax' | 'dbStatementTimeoutMs'>): pg.Pool {
  return new pg.Pool({
    connectionString: config.databaseUrl,
    max: config.dbPoolMax,
    statement_timeout: config.dbStatementTimeoutMs,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    application_name: 'das-api',
  });
}

export function assertFnName(name: string): void {
  if (!IDENTIFIER.test(name)) {
    throw new Error(`SQL function 名稱不合法：${JSON.stringify(name)}（只能是小寫英數與底線）`);
  }
}

export class Db {
  readonly pool: pg.Pool;
  private readonly allowed: ReadonlySet<string>;

  constructor(pool: pg.Pool, allowedFns: Iterable<string>) {
    this.pool = pool;
    const allowed = new Set<string>();
    for (const fn of allowedFns) {
      assertFnName(fn);
      allowed.add(fn);
    }
    this.allowed = allowed;
  }

  /**
   * 呼叫 api.<fnName>(p_actor, ...args)。
   * actorId 為 null 代表未登入（public 路由）或系統作業。
   */
  async callApi<T = unknown>(
    fnName: string,
    actorId: string | null,
    args: readonly unknown[] = [],
    mode: ResultMode = 'scalar',
  ): Promise<T> {
    if (!this.allowed.has(fnName)) {
      throw new Error(`api.${fnName} 不在白名單內（請加到 src/contract/routes.ts 或 sqlNames.ts）`);
    }
    const values = [actorId, ...args];
    const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
    const call = `api.${fnName}(${placeholders})`;
    const text = mode === 'row' || mode === 'rows' ? `select * from ${call}` : `select ${call} as result`;

    for (let attempt = 1; ; attempt++) {
      try {
        const res = await this.pool.query(text, values);
        if (mode === 'rows') return res.rows as T;
        if (mode === 'row') return (res.rows[0] ?? null) as T;
        if (mode === 'none') return undefined as T;
        return ((res.rows[0] as { result?: unknown } | undefined)?.result ?? null) as T;
      } catch (err) {
        const code = (err as { code?: unknown }).code;
        if (typeof code === 'string' && RETRYABLE.has(code) && attempt < MAX_ATTEMPTS) continue;
        throw wrapConnectionError(err);
      }
    }
  }

  /** 健康檢查用。 */
  async ping(timeoutMs = 2_000): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('db ping timeout')), timeoutMs);
    });
    try {
      await Promise.race([this.pool.query('select 1'), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 連線層的錯誤（連不上、連線中斷、pool 逾時）沒有 SQLSTATE → 503。其餘原樣丟出。 */
const CONNECTION_MESSAGE = /timeout exceeded when trying to connect|connection terminated|connection.*(closed|ended)|client has encountered a connection error/i;

function wrapConnectionError(err: unknown): unknown {
  if (!(err instanceof Error) || err instanceof HttpError) return err;
  const e = err as Error & { code?: unknown; severity?: unknown };
  if (typeof e.severity === 'string') return err; // 資料庫回的錯誤，有 SQLSTATE
  const errno = typeof e.code === 'string' && /^E[A-Z]+$/.test(e.code);
  if (!errno && !CONNECTION_MESSAGE.test(e.message)) return err;
  const wrapped = new HttpError(503, 'service_unavailable', '系統暫時無法使用，請稍後再試');
  wrapped.cause = err;
  return wrapped;
}
