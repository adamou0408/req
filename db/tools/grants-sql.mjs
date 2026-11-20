#!/usr/bin/env node
// 產生執行權限的 SQL（建置的最後一步，db/build.sh 以 superuser 套用）。紅隊 redteam/findings.md 高-2 的修法。
// 權限的唯一來源是路由表（packages/contract/src/routes.ts）：每個執行期帳號只能執行路由表列出的 function，逐一列名，
// 不再「整個 schema 授權」。先撤掉所有非系統 schema 的 function 對 PUBLIC 與各執行期帳號的 EXECUTE，再逐一授權；
// 列出的 function 不存在時 GRANT 失敗，建置就失敗。db/tests/kernel/12-grants.test.mjs 檢查實際權限與清單完全相等。
// 測試專用的帳號（sgn_test_verifier）由 db/testing/ 自己授權，這裡不動。
import {
    anchorCalls,
    backendCalls,
    deliveryCalls,
    idpCalls,
    mailerCalls,
    packRoutes,
    reconcilerCalls,
    routes,
    schedulerCalls,
    syncCalls,
} from '../../packages/contract/src/routes.ts';
import { loadConfig } from './lib/env.mjs';

/** 每個執行期帳號（sgn.env 的鍵名後綴）能執行的 function：schema 與名稱。 */
export const allowlist = {
    APP: { schema: 'api', fns: [...routes, ...Object.values(packRoutes).flat(), ...Object.values(backendCalls)].map((c) => c.fn) },
    SYNC: { schema: 'api_sync', fns: Object.values(syncCalls).map((c) => c.fn) },
    SCHEDULER: { schema: 'api_job', fns: Object.values(schedulerCalls).map((c) => c.fn) },
    RECONCILER: { schema: 'api_job', fns: Object.values(reconcilerCalls).map((c) => c.fn) },
    ANCHOR: { schema: 'api_job', fns: Object.values(anchorCalls).map((c) => c.fn) },
    MAILER: { schema: 'api_job', fns: Object.values(mailerCalls).map((c) => c.fn) },
    DELIVERY: { schema: 'api_delivery', fns: Object.values(deliveryCalls).map((c) => c.fn) },
    IDP_KEYS: { schema: 'api_idp', fns: Object.values(idpCalls).map((c) => c.fn) },
};

const ident = (name) => `"${name.replaceAll('"', '""')}"`;
const literal = (text) => `'${text.replaceAll("'", "''")}'`;

export function grantsSql(config = loadConfig()) {
    // 合併角色 sgn_job（操作者用）自己沒有任何授權：90_grants.sql 給它的一併撤掉，它只經由成員關係拿到四個程式的
    const roles = [...Object.keys(allowlist), 'JOB'].map((key) => config.db[`SGN_ROLE_${key}`]);
    const lines = [
        '-- 自動產生（db/tools/grants-sql.mjs），請勿手動修改。來源：packages/contract/src/routes.ts',
        `select format('revoke all on all functions in schema %I from public, ${roles.map(ident).join(', ')}', n.nspname)`,
        'from pg_namespace as n',
        `where n.nspname not like ${literal('pg\\_%')} and n.nspname <> 'information_schema'`,
        '\\gexec',
    ];
    for (const [key, { schema, fns }] of Object.entries(allowlist)) {
        const role = config.db[`SGN_ROLE_${key}`];
        lines.push(`grant usage on schema ${ident(schema)} to ${ident(role)};`);
        for (const fn of [...new Set(fns)].sort()) lines.push(`grant execute on function ${ident(schema)}.${ident(fn)} to ${ident(role)};`);
    }
    return `${lines.join('\n')}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    process.stdout.write(grantsSql());
}
