#!/usr/bin/env node
// 全量驗證雜湊鏈並比對錨點。錨點直接向獨立的錨點存放處取得（SGN_ANCHOR_ORIGIN，不經後端；裁決 D81 (4)）。
// 用法：node db/tools/verify-chain.mjs [資料庫名稱]（以操作者身分：讀鏈用錨定角色 sgn_anchor，它的入口正好是讀鏈頭、事件、程式指紋與落後門檻）
// 結束代碼：0＝一致；2＝發現問題（問題清單以 JSON 輸出）。
import { anchorStoreClient, verifyChain } from './chain-lib.mjs';
import { loadConfig, roleUrl } from './lib/env.mjs';

const config = loadConfig();
const database = process.argv[2] ?? config.database;
const anchors = await anchorStoreClient(config.db.SGN_ANCHOR_ORIGIN).read();
const result = await verifyChain({ dbUrl: roleUrl(config, 'ANCHOR', database), anchors });
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 2);
