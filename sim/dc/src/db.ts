// 資料庫連線與交易。所有動態的識別字與字面值都經過 ident / lit（pg 的跳脫函式），
// 值能用參數傳的一律用參數；DDL 無法帶參數，才用 lit。
import pg from 'pg';
import type { Config, EnvConfig } from './config.ts';

export const ident: (s: string) => string = pg.escapeIdentifier;
export const lit: (s: string) => string = pg.escapeLiteral;

export type Db = pg.PoolClient;

export interface Env {
    readonly config: EnvConfig;
    readonly pool: pg.Pool;
}

// 讓 date 欄位以 'YYYY-MM-DD' 字串回來，不經過 JavaScript 的 Date 與時區轉換。
pg.types.setTypeParser(1082, (v: string) => v);

export function servicePool(config: Config, database: string): pg.Pool {
    return new pg.Pool({
        host: config.pgHost,
        port: config.pgPort,
        database,
        user: config.serviceRole,
        password: config.servicePassword,
        max: 5,
        application_name: 'sim-dc',
    });
}

export async function withTx<T>(env: Env, fn: (db: Db) => Promise<T>, opts: { rollback?: boolean } = {}): Promise<T> {
    const db = await env.pool.connect();
    try {
        await db.query('begin');
        const result = await fn(db);
        await db.query(opts.rollback === true ? 'rollback' : 'commit');
        return result;
    } catch (err) {
        await db.query('rollback').catch(() => undefined);
        throw err;
    } finally {
        db.release();
    }
}

export function isPgError(err: unknown, code: string): boolean {
    return typeof err === 'object' && err !== null && 'code' in err && (err as { code: unknown }).code === code;
}
