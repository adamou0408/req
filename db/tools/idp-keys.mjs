#!/usr/bin/env node
// 身分提供者的金鑰更新程序（裁決 D81 (5)；紅隊第四輪 中-5）：讀身分提供者公布的 JWKS，交給 api_idp.idp_keys_sync
// （新的金鑰立即信任、進鏈、開例外並通知治理角色；不能信任的開例外；不再公布的退役）。
// 帳號 sgn_idp_keys 只能執行這一個 function。建置時的第一次登記仍由資料庫擁有者做（db/tools/idp-keys-sql.mjs）。
// 用法：node db/tools/idp-keys.mjs              同步一次
//       node db/tools/idp-keys.mjs --every 60   每 60 秒同步一次（常駐；tools/run-all.sh 啟動）
import pg from 'pg';
import { idpCalls } from '../../packages/contract/src/routes.ts';
import { PROGRAMS } from './lib/programs.mjs';
import { loadProgramConfig, programDbUrl, simServiceEnv } from './lib/env.mjs';

const config = loadProgramConfig('idp-keys');
const idp = simServiceEnv('idp');
const pool = new pg.Pool({ connectionString: programDbUrl(config, PROGRAMS['idp-keys'].roleKey), max: 1 });
const everyIndex = process.argv.indexOf('--every');

async function runOnce() {
    // 每一輪先回報心跳（裁決 D88 (3)：同時檢查其他程式有沒有停擺）；心跳失敗不擋住同步
    await pool.query(`select api_idp.${idpCalls.idpKeysHeartbeat.fn}()`).catch((err) => console.error(err.message));
    const discovery = await (await fetch(`${idp.SIM_IDP_ISSUER}/.well-known/openid-configuration`)).json();
    const jwks = await (await fetch(discovery.jwks_uri)).json();
    const { rows } = await pool.query(`select api_idp.${idpCalls.idpKeysSync.fn}($1, $2) as r`, [discovery.issuer, jwks]);
    console.log(JSON.stringify({ at: new Date().toISOString(), ...rows[0].r }));
}

await runOnce();
if (everyIndex > 0) {
    setInterval(() => runOnce().catch((err) => console.error(err.message)), Number(process.argv[everyIndex + 1]) * 1000);
} else {
    await pool.end();
}
