#!/usr/bin/env node
// 把鏈頭寫到資料庫以外的錨點存放處（db/tools/anchor-store.mjs，另一個來源、另一個程序與帳號；裁決 D81 (4)）。用法：
//   node db/tools/anchor.mjs                     錨定一次
//   node db/tools/anchor.mjs --every 60          每 60 秒錨定一次（常駐）
// 每次錨定前先從上一個錨點增量重算；不一致就不寫，並以結束代碼 2 回報。
// 設定：自己的密鑰檔（.run/secrets/anchor.env：sgn_anchor 的密碼、存放處的寫入金鑰），見 db/tools/lib/programs.mjs。
import pg from 'pg';
import { anchorCalls } from '../../packages/contract/src/routes.ts';
import { anchorOnce, anchorStoreClient } from './chain-lib.mjs';
import { PROGRAMS } from './lib/programs.mjs';
import { loadProgramConfig, programDbUrl } from './lib/env.mjs';

const config = loadProgramConfig('anchor');
const options = {
    dbUrl: programDbUrl(config, PROGRAMS.anchor.roleKey),
    store: anchorStoreClient(config.db.SGN_ANCHOR_ORIGIN, config.secret.SGN_ANCHOR_WRITE_KEY),
};
const everyIndex = process.argv.indexOf('--every');
// 心跳（裁決 D88 (3)：每一輪回報，同時檢查其他程式有沒有停擺）；心跳失敗不擋住錨定
const pool = new pg.Pool({ connectionString: options.dbUrl, max: 1 });

async function runOnce() {
    await pool.query(`select api_job.${anchorCalls.anchorHeartbeat.fn}()`).catch((err) => console.error(err.message));
    const result = await anchorOnce(options);
    console.log(JSON.stringify(result));
    if (!result.ok) process.exit(2);
}

await runOnce();
if (everyIndex > 0) {
    setInterval(() => runOnce().catch((err) => console.error(err.message)), Number(process.argv[everyIndex + 1]) * 1000);
} else {
    await pool.end();
}
