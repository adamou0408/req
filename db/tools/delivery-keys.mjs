#!/usr/bin/env node
// 交付簽章的信任清單（docs/handoff/delivery.md）：私鑰在資料庫裡產生（sgn_internal.signing_key_create，db/build.sh），
// 不離開資料庫；這裡只讀各資料庫目前那一把的公鑰，併進外部系統的信任清單檔（格式見 sim/dc/README.md「簽章格式」）。
// 清單裡其他的金鑰（例如 sim/dc 自己產生的開發用金鑰）保留。
// 用法：node db/tools/delivery-keys.mjs <信任清單檔> <資料庫...>
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { adminUrl, loadConfig } from './lib/env.mjs';

const [file, ...databases] = process.argv.slice(2);
if (!file || databases.length === 0) throw new Error('用法：delivery-keys.mjs <信任清單檔> <資料庫...>');

const config = loadConfig();
const current = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { keys: [] };
const keys = new Map(current.keys.map((k) => [k.key_id, k]));
for (const database of databases) {
    const db = new pg.Client({ connectionString: adminUrl(config, database) });
    await db.connect();
    const { rows } = await db.query('select sgn_internal.signing_keys_current() as k');
    await db.end();
    for (const k of rows[0].k) keys.set(k.key_id, { key_id: k.key_id, public_key_pem: k.public_key_pem });
}
writeFileSync(file, `${JSON.stringify({ keys: [...keys.values()] }, null, 2)}\n`);
console.log(`信任清單 ${file}：${[...keys.keys()].join('、')}`);
