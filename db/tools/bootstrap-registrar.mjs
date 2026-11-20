#!/usr/bin/env node
// 開發與驗收環境：安裝時由資料庫擁有者建立系統的第一位通行金鑰登記人（裁決 D65，sgn_internal.passkey_bootstrap）。
// 登記人的金鑰是軟體金鑰，私鑰存在 .run/registrar-<資料庫>.json，讓測試扮演登記人替別人的第一把金鑰背書
// （db/tests/kernel/lib/harness.mjs 的 registrar）。正式環境由擁有者以真的驗證器產生公鑰後呼叫同一個 function。
// 用法：SGN_DATABASE=<資料庫> node db/tools/bootstrap-registrar.mjs（db/build.sh 在種子之後呼叫）
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { SoftAuthenticator } from '../tests/kernel/lib/authenticator.mjs';
import { RUN_DIR, adminUrl, loadConfig } from './lib/env.mjs';

const config = loadConfig();
const uid = config.db.SGN_SEED_REGISTRAR;
const key = new SoftAuthenticator({ rpId: config.db.SGN_RP_ID, origin: config.db.SGN_WEB_ORIGIN });
const db = new pg.Client({ connectionString: adminUrl(config) });
await db.connect();
try {
    await db.query(`set role "${config.db.SGN_ROLE_OWNER}"`);
    await db.query(
        `select sgn_internal.passkey_bootstrap(
             sgn_internal.person_by_identity(sgn_internal.setting_text('idp.directory_source'), $1), $2, $3, $4)`,
        [uid, key.credentialIdB64, key.spkiB64, 'db/tools/bootstrap-registrar.mjs：開發與驗收環境的第一位登記人'],
    );
} finally {
    await db.end();
}
mkdirSync(RUN_DIR, { recursive: true });
writeFileSync(join(RUN_DIR, `registrar-${config.database}.json`), `${JSON.stringify({ uid, key: key.toJSON() })}\n`, { mode: 0o600 });
console.log(`第一位登記人：${uid}（${config.database}）`);
