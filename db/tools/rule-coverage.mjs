#!/usr/bin/env node
// 檢查 sgn.rule 的每個規則代碼，至少出現在一個測試名稱裡（test('PRB-XXX ...')）。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { DB_DIR, adminUrl, loadConfig } from './lib/env.mjs';

const db = new pg.Client({ connectionString: adminUrl(loadConfig()) });
await db.connect();
const { rows } = await db.query('select code from sgn.rule order by code');
await db.end();

const testDir = join(DB_DIR, 'test');
const names = readdirSync(testDir)
    .filter((f) => f.endsWith('.test.mjs'))
    .flatMap((f) => [...readFileSync(join(testDir, f), 'utf8').matchAll(/\btest\(\s*'([^']+)'/g)].map((m) => m[1]));
const missing = rows.map((r) => r.code).filter((code) => !names.some((n) => n.includes(code)));
if (missing.length) {
    console.error(`沒有測試的規則代碼：${missing.join(', ')}`);
    process.exit(1);
}
console.log(`規則代碼 ${rows.length} 個，每個都有測試`);
