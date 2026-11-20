// 啟動前的準備：以 superuser 建立服務的登入角色與兩個資料庫（只做這件事），
// 之後一律以服務角色建立結構、載入資料、管理被授權者角色。
import pg from 'pg';
import type { Config, EnvConfig } from './config.ts';
import { ident, lit, servicePool, withTx, type Env } from './db.ts';
import { DROP_SCHEMAS_SQL, SCHEMA_VERSION, schemaSql } from './schema.ts';
import { loadSeed } from './seed.ts';
import { dropManagedRoles } from './roles.ts';

async function ensureServiceRoleAndDatabases(config: Config): Promise<void> {
    const admin = new pg.Client({ connectionString: config.pgAdminUrl, application_name: 'sim-dc-bootstrap' });
    await admin.connect();
    try {
        const role = ident(config.serviceRole);
        const exists = await admin.query('select 1 from pg_roles where rolname = $1', [config.serviceRole]);
        // CREATEROLE：建立被授權者角色。PostgreSQL 16 起只能管理自己建立的角色，碰不到別人的。
        const attrs = `login createrole nosuperuser nocreatedb nobypassrls password ${lit(config.servicePassword)}`;
        await admin.query(exists.rowCount === 0 ? `create role ${role} ${attrs}` : `alter role ${role} ${attrs}`);
        for (const env of config.envs) {
            const db = await admin.query('select 1 from pg_database where datname = $1', [env.database]);
            if (db.rowCount === 0) {
                await admin.query(`create database ${ident(env.database)} owner ${role} encoding 'UTF8' template template0`);
            }
            await admin.query(`revoke all on database ${ident(env.database)} from public`);
            await admin.query(`grant connect, temporary on database ${ident(env.database)} to ${role}`);
            await admin.query(`alter database ${ident(env.database)} set timezone to ${lit(config.timezone)}`);
        }
    } finally {
        await admin.end();
    }
}

async function currentVersion(env: Env): Promise<number | null> {
    const exists = await env.pool.query(`select to_regclass('simdc_meta.schema_info') is not null as ok`);
    if (exists.rows[0]?.ok !== true) return null;
    const r = await env.pool.query<{ v: number | null }>('select max(version) as v from simdc_meta.schema_info');
    return r.rows[0]?.v ?? null;
}

async function ensureSandboxRole(config: Config, env: Env): Promise<void> {
    await withTx(env, async (db) => {
        const exists = await db.query('select 1 from pg_roles where rolname = $1', [config.sandboxRole]);
        if (exists.rowCount === 0) await db.query(`create role ${ident(config.sandboxRole)} nologin`);
        await db.query(`grant ${ident(config.sandboxRole)} to current_user with set true, inherit false`);
        await db.query(`grant usage on schema data to ${ident(config.sandboxRole)}`);
        await db.query(`grant select on all tables in schema data to ${ident(config.sandboxRole)}`);
        // 沙箱要讀到全部遮罩資料，所以給它一條看得到全部的 policy（只在遮罩資料庫）。
        const tables = await db.query<{ t: string }>(
            `select c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'data' and c.relkind = 'r'`,
        );
        for (const { t } of tables.rows) {
            await db.query(`drop policy if exists sandbox_all on data.${ident(t)}`);
            await db.query(`create policy sandbox_all on data.${ident(t)} for select to ${ident(config.sandboxRole)} using (true)`);
        }
    });
}

async function setupEnv(config: Config, envConfig: EnvConfig, reset: boolean): Promise<Env> {
    const env: Env = { config: envConfig, pool: servicePool(config, envConfig.database) };
    const version = await currentVersion(env);
    if (reset || version !== SCHEMA_VERSION) {
        await withTx(env, async (db) => {
            await db.query(DROP_SCHEMAS_SQL);
            await dropManagedRoles(db, envConfig.rolePrefix);
            for (const sql of schemaSql(config.serviceRole)) await db.query(sql);
            await loadSeed(db, envConfig.masked);
        });
    }
    if (envConfig.masked) await ensureSandboxRole(config, env);
    return env;
}

export async function bootstrap(config: Config, opts: { reset: boolean }): Promise<Env[]> {
    await ensureServiceRoleAndDatabases(config);
    const envs: Env[] = [];
    for (const envConfig of config.envs) envs.push(await setupEnv(config, envConfig, opts.reset));
    return envs;
}
