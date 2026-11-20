// 遮罩資料的測試環境：結構相同、值是遮罩的；沙箱執行一組查詢，回報實際讀到的主題包、欄位與條件。
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { call, example1, KEYS, putRuleSet, sql, startServer, stopServer } from './harness.ts';

const MASKED_DB = process.env['SIM_DC_DB_MASKED'] ?? '';

interface Report {
    name: string;
    status: string;
    error: string | null;
    row_count: number | null;
    packages: { package: string; fields: string[]; conditions: string[] }[];
}

async function sandbox(queries: { name: string; sql: string }[], base = '/masked/v1'): Promise<{ status: number; reports: Report[] }> {
    const r = await call('POST', `${base}/sandbox/runs`, { body: JSON.stringify({ queries }) });
    return { status: r.status, reports: (r.body['queries'] as Report[] | undefined) ?? [] };
}

before(startServer);
after(stopServer);

test('遮罩資料：結構與筆數相同，L3、L4 的值不同，列條件與日期相同', async () => {
    const q = `select customer_id, customer_name, tax_id, region, industry from data.customer_master order by row_id limit 3`;
    const live = await sql<Record<string, string>>(q);
    const masked = await sql<Record<string, string>>(q, [], MASKED_DB);
    assert.equal(masked.length, 3);
    for (const [i, row] of masked.entries()) {
        const orig = live[i];
        assert.ok(orig !== undefined);
        assert.notEqual(row['tax_id'], orig['tax_id']);
        assert.notEqual(row['customer_name'], orig['customer_name']);
        assert.equal(row['region'], orig['region']);
        assert.equal(row['industry'], orig['industry']);
    }
    const n = 'select count(*)::text as n from data.sales_order';
    assert.deepEqual(await sql(n, [], MASKED_DB), await sql(n));
});

test('沙箱回報實際讀到的欄位與條件', async () => {
    const { status, reports } = await sandbox([
        {
            name: '北區訂單與客戶',
            sql: `select o.order_no, o.amount, c.customer_name
                  from data.sales_order o join data.customer_master c on c.customer_id = o.customer_id
                  where o.region = 'north' and o.order_date >= '2026-01-01'`,
        },
        { name: '區域加總', sql: 'select region, sum(amount) from data.sales_order group by region' },
        { name: '薪資', sql: `select net_pay from data.payroll where pay_date between '2026-01-01' and '2026-12-31';` },
    ]);
    assert.equal(status, 200);
    const [join, agg, pay] = reports;
    assert.equal(join?.status, 'ok');
    assert.ok((join?.row_count ?? 0) > 0);
    const so = join?.packages.find((p) => p.package === 'sales_order');
    const cm = join?.packages.find((p) => p.package === 'customer_master');
    assert.deepEqual(so?.fields, ['amount', 'customer_id', 'order_date', 'order_no', 'region']);
    assert.deepEqual(cm?.fields, ['customer_id', 'customer_name']);
    assert.ok(so?.conditions.some((c) => c.includes("'north'")));
    assert.deepEqual(agg?.packages, [{ package: 'sales_order', fields: ['amount', 'region'], conditions: [] }]);
    assert.deepEqual(pay?.packages[0]?.fields, ['net_pay', 'pay_date']);
});

test('沙箱只能查詢：寫入、多個語句、讀服務的紀錄都失敗，資料沒變', async () => {
    const before = await sql('select count(*)::text as n from data.payroll', [], MASKED_DB);
    const { reports } = await sandbox([
        { name: 'delete', sql: 'delete from data.payroll' },
        { name: 'multi', sql: 'select 1; delete from data.payroll' },
        { name: 'meta', sql: 'select * from simdc_meta.rule_set' },
        { name: 'cte', sql: 'with d as (delete from data.payroll returning 1) select * from d' },
    ]);
    assert.deepEqual(
        reports.map((r) => r.status),
        ['error', 'error', 'error', 'error'],
    );
    assert.deepEqual(await sql('select count(*)::text as n from data.payroll', [], MASKED_DB), before);
});

test('沙箱只在遮罩環境', async () => {
    assert.equal((await sandbox([{ name: 'x', sql: 'select 1' }], '/v1')).status, 422);
    assert.equal((await call('POST', '/masked/v1/sandbox/runs', { key: KEYS.auditor, body: '{}' })).status, 403);
});

test('遮罩環境一樣可以套用規則與測試查詢，與正式環境的角色分開', async () => {
    const principal = '0b9f6c3e-0000-4000-8000-000000000060';
    assert.equal((await putRuleSet(example1(principal, 'DA-2026-0600'), '/masked/v1')).status, 200);
    const r = await call('POST', '/masked/v1/test-query', {
        body: JSON.stringify({
            principal_id: principal,
            query: {
                package: 'sales_order',
                fields: ['amount'],
                row: { region: 'north' },
                data_date: '2025-03-01',
                action: 'query',
                as_of: '2026-12-01',
            },
        }),
    });
    assert.equal(r.body['decision'], 'allow');
    assert.equal(r.body['db_role'], 'simdc_t_m_p_0b9f6c3e000040008000000000000060');
    const live = await sql('select 1 from simdc_meta.rule_set where case_no = $1', ['DA-2026-0600']);
    assert.equal(live.length, 0);
});
