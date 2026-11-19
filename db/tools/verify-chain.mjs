#!/usr/bin/env node
// 全量驗證雜湊鏈並比對錨點檔。用法：node tools/verify-chain.mjs [資料庫名稱]
// 結束代碼：0＝一致；2＝發現問題（問題清單以 JSON 輸出）。
import { verifyChain } from './chain-lib.mjs';
import { anchorFile, loadConfig, roleUrl } from './lib/env.mjs';

const config = loadConfig();
const database = process.argv[2] ?? config.database;
const result = await verifyChain({ dbUrl: roleUrl(config, 'JOB', database), anchorFile: anchorFile(config, database) });
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 2);
