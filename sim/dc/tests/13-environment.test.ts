// 測試區與正式區（裁決 D93 (3)；格式 docs/contract/02-pack-data-access.md §8.1、§8.7、§8.8）：同一套系統裡兩區是不同的資料庫物件
// （data／data_test、export／export_test），規則只給它那一區；已簽的回應帶實際套用的區；對帳與使用紀錄都分區。
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
    attested,
    call,
    example1,
    KEYS,
    putRuleSet,
    reconciliation,
    sql,
    startServer,
    stopServer,
    testQuery,
    type QueryInput,
} from './harness.ts';

const PRINCIPAL = '0b9f6c3e-0000-4000-8000-00000000001e';
const CASE_NO = 'DA-2026-1300';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
const inScope = (environment?: 'prod' | 'test'): QueryInput => ({
    package: 'sales_order',
    fields: ['amount', 'order_no'],
    row: { region: 'north' },
    data_date: '2025-06-01',
    action: 'query',
    as_of: today,
    ...(environment === undefined ? {} : { environment }),
});

before(async () => {
    await startServer();
    const rs = { ...example1(PRINCIPAL, CASE_NO), valid: { from: today, to: today }, environment: 'test' };
    const r = await putRuleSet(rs);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(attested(r).result['environment'], 'test', '已簽的套用結果帶實際套用的區');
});
after(stopServer);

test('測試區的規則只在測試區的資料表上：測試區查得到、正式區（同一份規則）查不到', async () => {
    assert.equal((await testQuery(PRINCIPAL, inScope('test')))['decision'], 'allow');
    const prod = await testQuery(PRINCIPAL, inScope('prod'));
    assert.equal(prod['decision'], 'deny');
    assert.equal(prod['reason'], 'no_rule');
    // 沒有寫區的查詢是正式區（舊單）
    assert.equal((await testQuery(PRINCIPAL, inScope()))['decision'], 'deny');
    // 權限真的只在 data_test：系統目錄上正式區的表沒有任何這個被授權者的欄位權限
    const grants = await sql<{ nspname: string }>(
        `select distinct n.nspname from pg_roles r
         cross join pg_class c join pg_namespace n on n.oid = c.relnamespace
         where starts_with(r.rolname, $1) and c.relname = 'sales_order' and n.nspname in ('data', 'data_test')
           and has_any_column_privilege(r.oid, c.oid, 'SELECT')`,
        [`simdc_t_p_${PRINCIPAL.replaceAll('-', '')}`],
    );
    assert.deepEqual(grants, [{ nspname: 'data_test' }]);
});

test('測試區是正式區的副本，目錄標示遮罩的欄位已遮罩', async () => {
    const [prod] = await sql<{ v: string }>(`select contact_phone as v from data.customer_master order by row_id limit 1`);
    const [masked] = await sql<{ v: string }>(`select contact_phone as v from data_test.customer_master order by row_id limit 1`);
    const [same] = await sql<{ a: string; b: string }>(
        `select p.customer_id as a, t.customer_id as b from data.customer_master p join data_test.customer_master t using (row_id) limit 1`,
    );
    assert.notEqual(prod?.v, masked?.v);
    assert.match(String(masked?.v), /^M[0-9a-f]{9}$/);
    assert.equal(same?.a, same?.b, '沒有標示的欄位和正式區相同');
});

test('驗證的已簽結果帶這張單實際套用的區', async () => {
    const r = await call('POST', '/v1/test-queries', {
        body: JSON.stringify({
            request_id: 'env-1',
            run_id: 1,
            rule_set: { ...example1(PRINCIPAL, CASE_NO), environment: 'test' },
            cases: [
                { code: 'in', expected: 'allow', query: inScope('test') },
                { code: 'request:other_environment', expected: 'deny', query: inScope('prod') },
            ],
        }),
    });
    const result = attested(r).result;
    assert.equal(result['environment'], 'test');
    assert.deepEqual(
        (result['results'] as { code: string; actual: string }[]).map((x) => [x.code, x.actual]),
        [
            ['in', 'allow'],
            ['request:other_environment', 'deny'],
        ],
    );
});

test('對帳：每一項的限制條件帶它實際所在的區', async () => {
    const mine = (await reconciliation()).filter((i) => i.subject.id === PRINCIPAL);
    assert.ok(mine.length > 0);
    assert.ok(mine.every((i) => i.constraints['environment'] === 'test' && i.properties['environment'] === 'test'));
});

test('使用紀錄：記在那一區的單上，摘要帶區、逐欄的次數與使用方系統帶的版本識別', async () => {
    const use = (query: QueryInput, clientVersion?: string): Promise<{ status: number }> =>
        call('POST', '/v1/use', {
            key: KEYS.admin,
            body: JSON.stringify({
                principal_id: PRINCIPAL,
                actor: { provider: 'sim-ldap', external_id: 'p04' },
                query,
                ...(clientVersion === undefined ? {} : { client_version: clientVersion }),
            }),
        });
    assert.equal((await use(inScope('test'), 'report-a@1.2.0')).status, 200);
    assert.equal((await use({ ...inScope('test'), fields: ['amount'] })).status, 200);
    // 正式區沒有這個被授權者的單：不記到測試區的單上
    assert.equal((await use(inScope('prod'))).status, 200);
    const batch = attested(await call('GET', '/v1/usage-summaries', { key: KEYS.auditor })).result;
    const items = (batch['items'] as Record<string, unknown>[]).filter((i) => i['case_no'] === CASE_NO);
    assert.equal(items.length, 1);
    const item = items[0] ?? {};
    assert.equal(item['environment'], 'test');
    assert.equal(item['queries'], 2);
    assert.deepEqual(item['client_versions'], ['report-a@1.2.0']);
    const fields = (item['fields'] as { field: string; queries: number }[]).map((f) => [f.field, f.queries]);
    assert.deepEqual(fields, [
        ['amount', 2],
        ['order_no', 1],
    ]);
    const bad = await call('POST', '/v1/use', {
        key: KEYS.admin,
        body: JSON.stringify({
            principal_id: PRINCIPAL,
            actor: { provider: 'sim-ldap', external_id: 'p04' },
            query: inScope(),
            client_version: 'x y',
        }),
    });
    assert.equal(bad.status, 422);
});

test('規則的區只能是 prod 或 test', async () => {
    const r = await putRuleSet({ ...example1(PRINCIPAL, 'DA-2026-1301'), environment: 'staging' });
    assert.equal(r.status, 422);
});
