// DC 的資料目錄（src/catalog.ts）與平台的資料目錄種子（db/seed/packs/data_access/010_catalog.sql）代碼必須一致：
// 平台的規則直接用這些代碼（02 §8.1）。DC 是另一個系統，有自己的目錄，所以用測試確認兩邊沒有走樣。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { PACKAGES } from '../src/catalog.ts';

interface SeedPackage {
    code: string;
    system: string;
    period_field: string | null;
    fields: { code: string; classification: string }[];
    filters?: { code: string; value_type: string; values?: { value: string }[] }[];
}

function seed(): SeedPackage[] {
    const root = process.env['SIM_DC_REPO_ROOT'] ?? '';
    const text = readFileSync(join(root, 'db/seed/packs/data_access/010_catalog.sql'), 'utf8');
    const m = /\$json\$([\s\S]*)\$json\$/.exec(text);
    assert.ok(m?.[1] !== undefined, '找不到種子裡的 JSON');
    return (JSON.parse(m[1]) as { packages: SeedPackage[] }).packages;
}

test('主題包、欄位、分級、列條件、期間欄位與平台的種子一致', () => {
    const expected = seed().map((p) => ({
        code: p.code,
        system: p.system,
        period: p.period_field,
        fields: p.fields.map((f) => `${f.code}:${f.classification}`).sort(),
        filters: (p.filters ?? []).map((f) => `${f.code}:${f.value_type}:${(f.values ?? []).map((v) => v.value).join(',')}`).sort(),
    }));
    const actual = PACKAGES.map((p) => ({
        code: p.code,
        system: p.system,
        period: p.periodField,
        fields: p.columns
            .filter((c) => c.classification !== null)
            .map((c) => `${c.code}:${c.classification ?? ''}`)
            .sort(),
        filters: p.filters.map((f) => `${f.code}:${f.valueType}:${f.values.join(',')}`).sort(),
    }));
    assert.deepEqual(actual, expected);
});
