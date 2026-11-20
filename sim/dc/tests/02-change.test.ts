// 冪等、縮小、部分撤回、全部撤回，以及防止重送舊的已簽章請求。
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
    example1,
    PRINCIPAL_B,
    putRuleSet,
    reconciliation,
    sql,
    startServer,
    stopServer,
    testQuery,
    withdraw,
    type QueryInput,
    type ReconItem,
} from './harness.ts';

const ROLE = 'simdc_t_p_0b9f6c3e00004000800000000000000b';
const sales: QueryInput = {
    package: 'sales_order',
    fields: ['amount', 'order_no'],
    row: { region: 'north' },
    data_date: '2025-06-01',
    action: 'query',
    as_of: '2026-12-01',
};
const customers: QueryInput = { ...sales, package: 'customer_master', fields: ['customer_id'], data_date: null };

function mine(items: ReconItem[]): string[] {
    return items
        .filter((i) => i.properties['db_role'] === ROLE)
        .map((i) => `${i.resource.id}|${i.action.name}|${JSON.stringify(i.constraints)}`)
        .sort();
}

async function catalogState(): Promise<unknown> {
    return sql(
        `select (select array_agg(polname || ':' || pg_get_expr(polqual, polrelid) order by polname) from pg_policy
                  where polroles = array[(select oid from pg_roles where rolname = $1)]) as policies,
                (select array_agg(c.relname || '.' || a.attname order by c.relname, a.attname)
                   from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'data' and a.attnum > 0 and has_column_privilege($1, c.oid, a.attname, 'SELECT')) as columns`,
        [ROLE],
    );
}

before(startServer);
after(stopServer);

test('同一條規則送兩次，結果相同', async () => {
    const first = await putRuleSet(example1(PRINCIPAL_B, 'DA-2026-0200'));
    const state1 = await catalogState();
    const items1 = mine(await reconciliation());
    const second = await putRuleSet(example1(PRINCIPAL_B, 'DA-2026-0200'));
    assert.equal(first.status, 200);
    assert.deepEqual(second.body, first.body);
    assert.deepEqual(await catalogState(), state1);
    assert.deepEqual(mine(await reconciliation()), items1);
    assert.equal(items1.length, 7);
});

test('同一版但內容不同 → 拒絕', async () => {
    const rs = example1(PRINCIPAL_B, 'DA-2026-0200');
    rs.rules[0]?.fields.push('tax_id');
    assert.equal((await putRuleSet(rs)).status, 409);
});

test('新的一版縮小範圍：欄位與列條件真的變小', async () => {
    assert.equal((await testQuery(PRINCIPAL_B, sales))['decision'], 'allow');
    const rs = example1(PRINCIPAL_B, 'DA-2026-0200');
    rs.case_version_no = 2;
    const rule = rs.rules[1];
    assert.ok(rule !== undefined);
    rule.fields = ['order_date', 'order_no'];
    rule.row_filter = [{ filter: 'region', op: 'in', values: ['central'] }];
    assert.equal((await putRuleSet(rs)).status, 200);
    const amount = await testQuery(PRINCIPAL_B, { ...sales, row: { region: 'central' } });
    assert.equal(amount['decision'], 'deny');
    assert.equal(amount['reason'], 'field_not_granted');
    const north = await testQuery(PRINCIPAL_B, { ...sales, fields: ['order_no'] });
    assert.equal(north['reason'], 'row_filter');
    assert.equal((await testQuery(PRINCIPAL_B, { ...sales, fields: ['order_no'], row: { region: 'central' } }))['decision'], 'allow');
    const items = mine(await reconciliation());
    assert.ok(!items.some((i) => i.startsWith('sales_order.amount|')));
    assert.ok(
        items.some((i) => i.startsWith('sales_order.order_no|read|{"row_filter":[{"filter":"region","op":"in","values":["central"]}]')),
    );
});

test('較舊的版本被拒絕', async () => {
    assert.equal((await putRuleSet(example1(PRINCIPAL_B, 'DA-2026-0200'))).status, 409);
});

test('撤回一條規則：那個主題包的權限消失，其他的還在', async () => {
    const r = await withdraw('DA-2026-0200', 'req-1', ['DA-2026-0200-1']);
    assert.deepEqual(r.body, { status: 'withdrawn' });
    assert.equal((await testQuery(PRINCIPAL_B, customers))['reason'], 'no_rule');
    assert.equal((await testQuery(PRINCIPAL_B, { ...sales, fields: ['order_no'], row: { region: 'central' } }))['decision'], 'allow');
    assert.ok(!mine(await reconciliation()).some((i) => i.startsWith('customer_master.')));
});

test('全部撤回：權限與角色都不在了', async () => {
    assert.equal((await withdraw('DA-2026-0200', 'req-2')).status, 200);
    assert.equal((await testQuery(PRINCIPAL_B, { ...sales, fields: ['order_no'], row: { region: 'central' } }))['reason'], 'no_rule');
    assert.deepEqual(mine(await reconciliation()), []);
    assert.equal((await sql('select 1 from pg_roles where rolname = $1', [ROLE])).length, 0);
    assert.equal(
        (await sql(`select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'export'`)).length,
        0,
    );
});

test('撤回後重送同一版的已簽章規則 → 拒絕', async () => {
    const rs = example1(PRINCIPAL_B, 'DA-2026-0200');
    rs.case_version_no = 2;
    const rule = rs.rules[1];
    assert.ok(rule !== undefined);
    rule.fields = ['order_date', 'order_no'];
    rule.row_filter = [{ filter: 'region', op: 'in', values: ['central'] }];
    assert.equal((await putRuleSet(rs)).status, 409);
    assert.equal((await sql('select 1 from pg_roles where rolname = $1', [ROLE])).length, 0);
});

test('重送同一個撤回請求不會撤掉之後新套用的規則', async () => {
    const rs = example1(PRINCIPAL_B, 'DA-2026-0200');
    rs.case_version_no = 3;
    assert.equal((await putRuleSet(rs)).status, 200);
    assert.equal((await withdraw('DA-2026-0200', 'req-2')).status, 200);
    assert.equal((await testQuery(PRINCIPAL_B, sales))['decision'], 'allow');
});

test('撤回不存在的單或規則 → 404', async () => {
    assert.equal((await withdraw('DA-2099-0001', 'req-9')).status, 404);
    assert.equal((await withdraw('DA-2026-0200', 'req-10', ['DA-2026-0200-9'])).status, 404);
});
