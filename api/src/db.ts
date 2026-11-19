// 呼叫資料庫 api function 的唯一入口（callApi）。只以 sgn_app 連線；錯誤代碼、訊息與 HTTP 狀態由 sgn.error_catalog 決定。
import pg from 'pg';
import { backendCalls, type Call } from '@sgn/contract';

type CatalogEntry = { message: string; status: number };

export class ApiError extends Error {
    readonly code: string;
    readonly status: number;
    constructor(code: string, status: number, message: string) {
        super(message);
        this.code = code;
        this.status = status;
    }
}

export class Db {
    readonly #pool: pg.Pool;
    #catalog = new Map<string, CatalogEntry>();

    constructor(connectionString: string) {
        this.#pool = new pg.Pool({ connectionString, max: 10 });
    }

    async loadErrorCatalog(): Promise<void> {
        const rows = (await this.callApi(backendCalls.errorCatalog, [])) as { code: string; message: string; http_status: number }[];
        this.#catalog = new Map(rows.map((r) => [r.code, { message: r.message, status: r.http_status }]));
    }

    /** 每個 api function 都回傳 jsonb；引數依路由表的參數順序。 */
    async callApi(call: Call, args: readonly unknown[]): Promise<unknown> {
        const placeholders = args.map((_, i) => `$${i + 1}`).join(', ');
        try {
            const { rows } = await this.#pool.query<{ result: unknown }>(`select api.${call.fn}(${placeholders}) as result`, [...args]);
            return rows[0]?.result ?? null;
        } catch (err) {
            throw this.#translate(err);
        }
    }

    /** 以錯誤目錄的代碼建立錯誤；訊息與 HTTP 狀態都來自 sgn.error_catalog。 */
    error(code: string): ApiError {
        const entry = this.#catalog.get(code);
        if (!entry) throw new Error(`錯誤目錄沒有 ${code}`);
        return new ApiError(code, entry.status, entry.message);
    }

    #translate(err: unknown): Error {
        const e = err as { code?: string; message?: string };
        if (e.code === 'P0001' && e.message) {
            const code = e.message.slice(0, e.message.indexOf(':'));
            if (this.#catalog.has(code)) return this.error(code);
        }
        if (e.code === '42501') return this.error('FORBIDDEN');
        if (e.code === '22P02' || e.code === '22023') return this.error('BAD_INPUT');
        return err instanceof Error ? err : new Error(String(err));
    }

    async close(): Promise<void> {
        await this.#pool.end();
    }
}
