// 使用紀錄（裁決 D92 (4)；格式 docs/contract/02-pack-data-access.md §8.7）：實際操作的人每查一次都記下，
// 平台拉的批次摘要是每張單 × 每個人 × 每個時段的查詢、匯出、被擋次數與最後使用時間，回應帶證明。
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { attested, call, example1, KEYS, PRINCIPAL_B, putRuleSet, startServer, stopServer, type QueryInput } from './harness.ts';

const CASE_NO = 'DA-2026-1200';
const inScope: QueryInput = {
    package: 'sales_order',
    fields: ['amount', 'order_no'],
    row: { region: 'north' },
    data_date: '2025-06-01',
    action: 'query',
    as_of: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date()),
};

async function use(actor: string, query: QueryInput, key = KEYS.admin): Promise<{ status: number; body: Record<string, unknown> }> {
    return call('POST', '/v1/use', {
        key,
        body: JSON.stringify({ principal_id: PRINCIPAL_B, actor: { provider: 'sim-ldap', external_id: actor }, query }),
    });
}

async function summaries(): Promise<Record<string, unknown>[]> {
    const r = await call('GET', '/v1/usage-summaries', { key: KEYS.auditor });
    assert.equal(r.status, 200);
    const p = attested(r);
    assert.equal(p.method, 'GET');
    assert.equal(p.path, '/usage-summaries');
    assert.equal(p.result['format'], 'usage_summary_batch/1');
    return (p.result['items'] as Record<string, unknown>[]).filter((i) => i['case_no'] === CASE_NO);
}

before(async () => {
    await startServer();
    const rs = example1(PRINCIPAL_B, CASE_NO);
    const today = inScope.as_of;
    assert.equal((await putRuleSet({ ...rs, valid: { from: today, to: today } })).status, 200);
});
after(stopServer);

test('使用紀錄：每一次使用都由資料庫判定並記下；摘要依人與時段計算查詢、被擋次數與最後使用時間', async () => {
    const allowed = await use('p04', inScope);
    assert.equal(allowed.status, 200);
    assert.equal(attested(allowed).result['decision'], 'allow');
    await use('p04', inScope);
    // 不在核准範圍的欄位：被擋下也記下來
    const blocked = await use('p04', { ...inScope, fields: ['gross_margin'] });
    assert.equal(attested(blocked).result['decision'], 'deny');
    await use('p05', inScope);
    const items = await summaries();
    const p04 = items.find((i) => (i['actor'] as { external_id: string }).external_id === 'p04');
    const p05 = items.find((i) => (i['actor'] as { external_id: string }).external_id === 'p05');
    assert.deepEqual([p04?.['queries'], p04?.['exports'], p04?.['blocked']], [2, 0, 1]);
    assert.deepEqual([p05?.['queries'], p05?.['blocked']], [1, 0]);
    const period = p04?.['period'] as { from: string; to: string };
    const last = Date.parse(String(p04?.['last_used_at']));
    assert.ok(Date.parse(period.from) <= last && last < Date.parse(period.to));
});

test('使用紀錄：只有代替使用者查詢的呼叫方可以記使用；平台的交付金鑰不行', async () => {
    const r = await use('p04', inScope, KEYS.platform);
    assert.equal(r.status, 403);
    const bad = await call('POST', '/v1/use', { key: KEYS.admin, body: JSON.stringify({ principal_id: PRINCIPAL_B, query: inScope }) });
    assert.equal(bad.status, 422);
});
