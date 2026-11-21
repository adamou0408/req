// 套用一條規則後：範圍內查得到；範圍外的欄位、列條件外、資料期間外、未授權的主題包、到期後都查不到；
// 不可匯出的規則不能匯出。判定一律是以被授權者的角色真的查資料庫。
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { catalogSha256 } from '../src/catalogVersion.ts';
import { call, example1, PRINCIPAL_A, putRuleSet, sql, startServer, stopServer, testQuery, type QueryInput, attested } from './harness.ts';

const base: QueryInput = {
    package: 'sales_order',
    fields: ['amount', 'customer_id', 'order_date', 'order_no'],
    row: { region: 'central' },
    data_date: '2025-01-01',
    action: 'query',
    as_of: '2026-11-16',
};

before(async () => {
    await startServer();
    const r = await putRuleSet(example1(PRINCIPAL_A));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    // 套用時用的目錄版本也在已簽的結果裡（D92 (1)）
    assert.deepEqual(attested(r).result, { status: 'applied', dc_ref: 'DC-DA-2026-0004-v1', catalog_sha256: catalogSha256() });
});
after(stopServer);

describe('範圍內查得到', () => {
    test('範圍內的欄位與列', async () => {
        const r = await testQuery(PRINCIPAL_A, base);
        assert.equal(r['decision'], 'allow');
        assert.equal(r['row_source'], 'existing');
        assert.ok(Number(r['rows_visible']) > 0);
    });
    test('沒有資料期間的主題包', async () => {
        const r = await testQuery(PRINCIPAL_A, {
            ...base,
            package: 'customer_master',
            fields: ['customer_id', 'customer_name'],
            row: { region: 'north' },
            data_date: null,
        });
        assert.equal(r['decision'], 'allow');
    });
    test('授權迄日當天仍有效', async () => {
        assert.equal((await testQuery(PRINCIPAL_A, { ...base, as_of: '2027-05-15' }))['decision'], 'allow');
    });
    test('回應不含資料內容', async () => {
        const r = await testQuery(PRINCIPAL_A, base);
        assert.deepEqual(Object.keys(r).sort(), ['db_role', 'decision', 'reason', 'row_source', 'rows_matching', 'rows_visible']);
    });
});

describe('範圍外查不到', () => {
    const cases: [string, Partial<QueryInput>, string][] = [
        ['範圍外的欄位', { fields: ['gross_margin'] }, 'field_not_granted'],
        ['範圍內加一個範圍外的欄位', { fields: ['amount', 'gross_margin'] }, 'field_not_granted'],
        ['列條件外的列', { row: { region: 'south' } }, 'row_filter'],
        ['資料期間外的列', { data_date: '2024-12-31' }, 'data_period'],
        ['授權到期後', { as_of: '2027-05-16' }, 'expired'],
        ['授權起日之前', { as_of: '2026-11-15' }, 'not_yet_valid'],
        ['未授權的主題包', { package: 'payroll', fields: ['net_pay'], row: {}, data_date: '2026-01-05' }, 'no_rule'],
        ['不可匯出的規則不能匯出', { action: 'export' }, 'export_not_allowed'],
    ];
    for (const [name, change, reason] of cases) {
        test(name, async () => {
            const r = await testQuery(PRINCIPAL_A, { ...base, ...change });
            assert.equal(r['decision'], 'deny');
            assert.equal(r['reason'], reason);
            // 資料存在，是被權限擋下
            assert.ok(Number(r['rows_matching']) > 0);
            assert.equal(r['rows_visible'], 0);
        });
    }
    test('沒有任何規則的被授權者', async () => {
        const r = await testQuery('0b9f6c3e-0000-4000-8000-0000000000ff', base);
        assert.equal(r['decision'], 'deny');
        assert.equal(r['reason'], 'no_rule');
    });
});

describe('分辨被擋下與本來就沒有資料', () => {
    test('沒有符合的資料列 → no_data', async () => {
        const r = await testQuery(PRINCIPAL_A, { ...base, row: { region: 'central', order_amount: 100001.5 } });
        assert.equal(r['decision'], 'no_data');
        assert.equal(r['rows_matching'], 0);
    });
    test('要求插入測試列時，改用測試列判斷（交易結束後不留下）', async () => {
        const before = await sql<{ n: string }>('select count(*) as n from data.sales_order');
        const r = await testQuery(PRINCIPAL_A, { ...base, row: { region: 'central', order_amount: 100001.5 } }, true);
        assert.equal(r['row_source'], 'probe');
        assert.equal(r['decision'], 'allow');
        const after = await sql<{ n: string }>('select count(*) as n from data.sales_order');
        assert.equal(after[0]?.n, before[0]?.n);
    });
});

describe('權限真的在資料庫裡', () => {
    test('欄位層級權限與列層級安全', async () => {
        const role = 'simdc_t_p_0b9f6c3e00004000800000000000000a';
        const cols = await sql<{ col: string; ok: boolean }>(
            `select c as col, coalesce(bool_or(has_column_privilege(r.rolname, 'data.sales_order', c, 'SELECT')), false) as ok
             from unnest(array['amount', 'gross_margin', 'channel', 'order_no']) as c
             left join pg_roles r on starts_with(r.rolname, $1)
             group by c order by c`,
            [`${role}_r`],
        );
        assert.deepEqual(cols, [
            { col: 'amount', ok: true },
            { col: 'channel', ok: false },
            { col: 'gross_margin', ok: false },
            { col: 'order_no', ok: true },
        ]);
        // 不可匯出：export schema 裡沒有任何這個角色讀得到的檢視表
        const exportable = await sql<{ n: string }>(
            `select count(*) as n from pg_class c join pg_namespace n on n.oid = c.relnamespace
             join pg_roles r on starts_with(r.rolname, $1)
             where n.nspname = 'export' and has_table_privilege(r.oid, c.oid, 'SELECT')`,
            [`${role}_r`],
        );
        assert.equal(exportable[0]?.n, '0');
        const policies = await sql<{ n: string }>(
            `select count(*) as n from pg_policy p join pg_roles r on r.oid = any (p.polroles) where starts_with(r.rolname, $1)`,
            [`${role}_r`],
        );
        assert.equal(policies[0]?.n, '2');
        const login = await sql<{ rolcanlogin: boolean }>('select rolcanlogin from pg_roles where rolname = $1', [role]);
        assert.equal(login[0]?.rolcanlogin, false);
    });
});

describe('可以匯出的規則', () => {
    test('export=true 可以匯出；export=null 不設限制', async () => {
        for (const [i, exp] of [true, null].entries()) {
            const principal = `0b9f6c3e-0000-4000-8000-00000000010${i}`;
            const rs = { ...example1(principal, `DA-2026-010${i}`), export: exp };
            assert.equal((await putRuleSet(rs)).status, 200);
            const r = await testQuery(principal, { ...base, action: 'export' });
            assert.equal(r['decision'], 'allow', `export=${String(exp)}`);
            // 匯出也受列條件限制
            assert.equal((await testQuery(principal, { ...base, action: 'export', row: { region: 'east' } }))['decision'], 'deny');
        }
    });
});

describe('驗證案例（02 §8.5 的 verify_request）', () => {
    test('§5.11 範例 1 的 9 個案例，實際結果都等於預期', async () => {
        const q = (o: Partial<QueryInput>): QueryInput => ({ ...base, ...o });
        const cm = { package: 'customer_master', fields: ['contract_end_date', 'customer_id', 'customer_name'], data_date: null };
        const cases = [
            ['customer_master:in', 'allow', q({ ...cm })],
            ['customer_master:row:region', 'deny', q({ ...cm, row: { region: 'south' } })],
            ['customer_master:field', 'deny', q({ ...cm, fields: ['tax_id'] })],
            ['sales_order:in', 'allow', q({})],
            ['sales_order:row:region', 'deny', q({ row: { region: 'south' } })],
            ['sales_order:field', 'deny', q({ fields: ['gross_margin'] })],
            ['sales_order:period', 'deny', q({ data_date: '2024-12-31' })],
            ['request:export', 'deny', q({ ...cm, action: 'export' })],
            ['request:after_validity', 'deny', q({ ...cm, as_of: '2027-05-16' })],
        ] as const;
        const body = {
            request_id: '6d1f3c0e-7c55-4c6b-9a43-1f5f8a3f0a01',
            run_id: 12,
            rule_set: example1(PRINCIPAL_A),
            cases: cases.map(([code, expected, query]) => ({ code, expected, query })),
        };
        const r = await call('POST', '/v1/test-queries', { body: JSON.stringify(body) });
        assert.equal(r.status, 200);
        assert.equal(r.body['status'], 'completed');
        const results = r.body['results'] as { code: string; actual: string }[];
        assert.deepEqual(
            results.map((x) => [x.code, x.actual]),
            cases.map(([code, expected]) => [code, expected]),
        );
    });
    test('無法執行的案例回 error', async () => {
        const body = { rule_set: example1(PRINCIPAL_A), cases: [{ code: 'x', expected: 'allow', query: { ...base, package: 'nope' } }] };
        const r = await call('POST', '/v1/test-queries', { body: JSON.stringify(body) });
        assert.equal((r.body['results'] as { actual: string }[])[0]?.actual, 'error');
    });
});
