#!/usr/bin/env node
// 開發與驗收環境：安裝時由資料庫擁有者建立系統的登記人（裁決 D65、D88 (2)；sgn_internal.passkey_bootstrap，
// 只在可用的登記人少於 passkey.registrar_min 時能執行）。依序建立 SGN_SEED_REGISTRAR 與 SGN_SEED_REGISTRAR_2（互不為主管）。
// 登記人的金鑰是軟體金鑰，私鑰存在 .run/registrar-<資料庫>.json（第一位是 uid、key；之後的在 others），讓測試扮演登記人
// 替別人的第一把金鑰背書（db/tests/kernel/lib/harness.mjs 的 registrar、oldKey）。正式環境由擁有者以真的驗證器產生公鑰後呼叫同一個 function。
// 用法：SGN_DATABASE=<資料庫> node db/tools/bootstrap-registrar.mjs（db/build.sh 在種子之後呼叫）
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { SoftAuthenticator } from '../tests/kernel/lib/authenticator.mjs';
import { RUN_DIR, adminUrl, loadConfig } from './lib/env.mjs';

const config = loadConfig();
const uids = [config.db.SGN_SEED_REGISTRAR, config.db.SGN_SEED_REGISTRAR_2];
const db = new pg.Client({ connectionString: adminUrl(config) });
const made = [];
await db.connect();
try {
    await db.query(`set role "${config.db.SGN_ROLE_OWNER}"`);
    for (const uid of uids) {
        const key = new SoftAuthenticator({ rpId: config.db.SGN_RP_ID, origin: config.db.SGN_WEB_ORIGIN });
        await db.query(
            `select sgn_internal.passkey_bootstrap(
                 sgn_internal.person_by_identity(sgn_internal.setting_text('idp.directory_source'), $1), $2, $3, $4)`,
            [uid, key.credentialIdB64, key.spkiB64, `db/tools/bootstrap-registrar.mjs：開發與驗收環境的登記人 ${uid}`],
        );
        made.push({ uid, key: key.toJSON() });
    }
} finally {
    await db.end();
}
mkdirSync(RUN_DIR, { recursive: true });
const [first, ...others] = made;
writeFileSync(join(RUN_DIR, `registrar-${config.database}.json`), `${JSON.stringify({ ...first, others })}\n`, { mode: 0o600 });
console.log(`登記人：${uids.join('、')}（${config.database}）`);
