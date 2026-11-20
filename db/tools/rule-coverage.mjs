#!/usr/bin/env node
// 檢查 sgn.rule 的每個規則代碼（核心 K-*、流程包各自的前綴），至少出現在一個測試名稱裡（test('K-XXX ...')）。
// 測試在 db/tests/kernel/ 與 db/tests/packs/<流程包>/。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { DB_DIR, adminUrl, loadConfig } from './lib/env.mjs';

const db = new pg.Client({ connectionString: adminUrl(loadConfig()) });
await db.connect();
const { rows } = await db.query('select code from sgn.rule order by code');
await db.end();

const testsDir = join(DB_DIR, 'tests');
const names = readdirSync(testsDir, { recursive: true })
    .filter((f) => f.endsWith('.test.mjs'))
    .flatMap((f) => [...readFileSync(join(testsDir, f), 'utf8').matchAll(/\btest\(\s*'([^']+)'/g)].map((m) => m[1]));
const missing = rows.map((r) => r.code).filter((code) => !names.some((n) => n.includes(code)));
if (missing.length) {
    console.error(`沒有測試的規則代碼：${missing.join(', ')}`);
    process.exit(1);
}
console.log(`規則代碼 ${rows.length} 個，每個都有測試`);
