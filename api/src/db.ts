// 呼叫資料庫 api function 的唯一入口。只以 sgn_app 連線；錯誤代碼、訊息與 HTTP 狀態由 sgn.error_catalog 決定。
import pg from 'pg';
import type { Route } from './routes.ts';

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
        const { rows } = await this.#pool.query<{ code: string; message: string; http_status: number }>(
            'select * from api.error_catalog()',
        );
        this.#catalog = new Map(rows.map((r) => [r.code, { message: r.message, status: r.http_status }]));
    }

    async call(route: Route, args: unknown[]): Promise<unknown> {
        const placeholders = args.map((_, i) => `$${i + 1}`).join(', ');
        try {
            const { rows } = await this.#pool.query(`select * from ${route.fn}(${placeholders})`, args);
            if (route.result === 'rows') return rows;
            if (route.result === 'row') return rows[0] ?? null;
            const first = rows[0] as Record<string, unknown> | undefined;
            return first ? Object.values(first)[0] : null;
        } catch (err) {
            throw this.#translate(err);
        }
    }

    #translate(err: unknown): Error {
        const e = err as { code?: string; message?: string };
        if (e.code === 'P0001' && e.message) {
            const code = e.message.slice(0, e.message.indexOf(':'));
            const entry = this.#catalog.get(code);
            if (entry) return new ApiError(code, entry.status, entry.message);
        }
        if (e.code === '42501') return new ApiError('FORBIDDEN', 403, '沒有權限');
        if (e.code === '22P02' || e.code === '22023') return new ApiError('BAD_INPUT', 400, '輸入格式不正確');
        return err instanceof Error ? err : new Error(String(err));
    }

    async close(): Promise<void> {
        await this.#pool.end();
    }
}
