#!/usr/bin/env node
// 把鏈頭寫到資料庫以外的錨點檔。用法：
//   node tools/anchor.mjs                     錨定一次
//   node tools/anchor.mjs --every 60          每 60 秒錨定一次（常駐）
// 每次錨定前先從上一個錨點增量重算；不一致就不寫，並以結束代碼 2 回報。
import { anchorOnce } from './chain-lib.mjs';
import { loadConfig, roleUrl } from './lib/env.mjs';

const config = loadConfig();
const options = { dbUrl: roleUrl(config, 'JOB'), anchorFile: config.db.SGN_ANCHOR_FILE };
const everyIndex = process.argv.indexOf('--every');

async function runOnce() {
    const result = await anchorOnce(options);
    console.log(JSON.stringify(result));
    if (!result.ok) process.exit(2);
}

await runOnce();
if (everyIndex > 0) {
    setInterval(runOnce, Number(process.argv[everyIndex + 1]) * 1000);
}
