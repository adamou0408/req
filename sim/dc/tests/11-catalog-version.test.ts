// 目錄版本（裁決 D92 (1)；格式與演算法 docs/contract/02-pack-data-access.md §8.6）：DC 用和平台相同的演算法算自己的目錄版本，
// 在套用、驗證與對帳的已簽回應裡回報；「代碼 → 實體資源」的對照改了，版本也跟著變。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { canonicalize, catalogSha256, catalogSnapshot } from '../src/catalogVersion.ts';
import { attested, backdoor, call, example1, KEYS, PRINCIPAL_A, putRuleSet, startServer, stopServer } from './harness.ts';

interface Vector {
    name: string;
    remap: Record<string, string>;
    snapshot?: unknown;
    sha256: string;
}

function vectors(): Vector[] {
    const root = process.env['SIM_DC_REPO_ROOT'] ?? '';
    const text = readFileSync(join(root, 'db/tests/packs/data_access/fixtures/catalog-vectors.json'), 'utf8');
    return (JSON.parse(text) as { vectors: Vector[] }).vectors;
}

before(startServer);
after(stopServer);

test('目錄版本：快照與雜湊和平台的測試向量相同（同一個演算法）', () => {
    for (const v of vectors()) {
        const remap = new Map(Object.entries(v.remap));
        if (v.snapshot !== undefined) assert.deepEqual(catalogSnapshot(remap), v.snapshot, v.name);
        assert.equal(catalogSha256(remap), v.sha256, v.name);
    }
});

test('目錄版本：標準化與鍵的順序、排序無關', () => {
    assert.equal(canonicalize({ b: 'x', a: ['2', null, { d: 'é', c: '"' }] }), '{"a":["2",null,{"c":"\\"","d":"é"}],"b":"x"}');
});

test('目錄版本：套用、驗證與對帳的已簽回應都帶這個環境目前的版本；對照改了版本就變', async () => {
    const seed = vectors()[0]?.sha256;
    const applied = attested(await putRuleSet(example1(PRINCIPAL_A, 'DA-2026-1100')));
    assert.equal(applied.result['catalog_sha256'], seed);
    const recon = attested(await call('GET', '/v1/reconciliation', { key: KEYS.auditor }));
    assert.equal(recon.result['catalog_sha256'], seed);
    const verify = attested(
        await call('POST', '/v1/test-queries', {
            body: JSON.stringify({ request_id: 'r', run_id: 1, rule_set: example1(PRINCIPAL_A, 'DA-2026-1100'), cases: [] }),
        }),
    );
    assert.equal(verify.result['catalog_sha256'], seed);
    const remapped = vectors()[1];
    assert.ok(remapped !== undefined);
    const [key, resource] = Object.entries(remapped.remap)[0] ?? ['', ''];
    const r = await backdoor('remap', { key, resource });
    assert.equal(r.status, 200);
    try {
        assert.equal(attested(await call('GET', '/v1/reconciliation', { key: KEYS.auditor })).result['catalog_sha256'], remapped.sha256);
        assert.equal(attested(await putRuleSet(example1(PRINCIPAL_A, 'DA-2026-1100'))).result['catalog_sha256'], remapped.sha256);
    } finally {
        await backdoor('remap', { key, resource: null });
    }
    assert.equal(attested(await call('GET', '/v1/reconciliation', { key: KEYS.auditor })).result['catalog_sha256'], seed);
});
