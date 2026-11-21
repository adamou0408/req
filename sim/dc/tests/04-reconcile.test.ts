// 對帳回報讀的是系統目錄：用管理後門直接改資料庫後，回報要看得到改過的樣子（而服務自己的紀錄沒變）。
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
    backdoor,
    call,
    example1,
    KEYS,
    putRuleSet,
    reconciliation,
    startServer,
    stopServer,
    testQuery,
    type ReconItem,
} from './harness.ts';

const PRINCIPAL = '0b9f6c3e-0000-4000-8000-00000000000d';
const ROLE = 'simdc_t_p_0b9f6c3e00004000800000000000000d';
const CASE = 'DA-2026-0400';

function mine(items: ReconItem[]): ReconItem[] {
    return items.filter((i) => String(i.properties['db_role']).startsWith(`${ROLE}_r`));
}

function find(items: ReconItem[], resource: string, action = 'read'): ReconItem[] {
    return mine(items).filter((i) => i.resource.id === resource && i.action.name === action);
}

before(async () => {
    await startServer();
    assert.equal((await putRuleSet(example1(PRINCIPAL, CASE))).status, 200);
});
after(stopServer);

test('回報的格式對齊 05 §8.3 的上傳項目', async () => {
    const r = await call('GET', '/v1/reconciliation', { key: KEYS.auditor });
    assert.equal(r.body['process_type'], 'data_access');
    assert.equal(r.body['resource_type'], 'data_field');
    const items = mine(r.body['items'] as ReconItem[]);
    assert.equal(items.length, 7);
    const amount = find(items, 'sales_order.amount')[0];
    assert.deepEqual(amount?.subject, { type: 'principal', id: PRINCIPAL, properties: { provider: 'sgn', kind: 'team' } });
    assert.deepEqual(amount?.constraints, {
        row_filter: [{ filter: 'region', op: 'in', values: ['central', 'north'] }],
        data_period: { field: 'order_date', from: '2025-01-01', to: '2026-12-31' },
        environment: 'prod',
    });
    assert.equal(amount?.properties['rule_id'], `${CASE}-2`);
    // 不可匯出：沒有 export 的項目
    assert.equal(items.filter((i) => i.action.name === 'export').length, 0);
});

test('後門多給一個欄位 → 對帳看得到', async () => {
    assert.equal((await backdoor('grant_column', { principal_id: PRINCIPAL, package: 'sales_order', field: 'gross_margin' })).status, 200);
    const extra = find(await reconciliation(), 'sales_order.gross_margin');
    assert.equal(extra.length, 1);
    assert.equal(extra[0]?.properties['column_not_in_rule'], true);
    // 真的查得到了：資料庫的權限確實被改了
    const r = await testQuery(PRINCIPAL, {
        package: 'sales_order',
        fields: ['gross_margin'],
        row: { region: 'north' },
        data_date: '2025-06-01',
        action: 'query',
        as_of: '2026-12-01',
    });
    assert.equal(r['decision'], 'allow');
    // 服務自己記的規則沒變
    const listed = await call('GET', `/v1/rule-sets/${CASE}`, { key: KEYS.auditor });
    assert.ok(!JSON.stringify(listed.body).includes('gross_margin'));
});

test('後門多給匯出權限 → 對帳看得到 export', async () => {
    assert.equal(
        (await backdoor('grant_column', { principal_id: PRINCIPAL, package: 'sales_order', field: 'amount', action: 'export' })).status,
        200,
    );
    assert.equal(find(await reconciliation(), 'sales_order.amount', 'export').length, 1);
});

test('後門少給一個欄位 → 對帳看不到它', async () => {
    assert.equal((await backdoor('revoke_column', { principal_id: PRINCIPAL, package: 'sales_order', field: 'order_no' })).status, 200);
    assert.equal(find(await reconciliation(), 'sales_order.order_no').length, 0);
});

test('後門拿掉列條件 → 對帳回報的限制變寬', async () => {
    assert.equal((await backdoor('clear_row_filter', { package: 'customer_master', rule_id: `${CASE}-1` })).status, 200);
    const item = find(await reconciliation(), 'customer_master.customer_id')[0];
    assert.deepEqual(item?.constraints, { row_filter: [], environment: 'prod' });
});

test('後門刪掉 policy → 對帳標出「有欄位權限但沒有 policy」', async () => {
    assert.equal((await backdoor('drop_policy', { package: 'customer_master', rule_id: `${CASE}-1` })).status, 200);
    const item = find(await reconciliation(), 'customer_master.customer_id')[0];
    assert.equal(item?.properties['no_policy'], true);
    assert.deepEqual(item?.constraints, { environment: 'prod' });
});

test('重新套用同一份規則，資料庫回到規則描述的狀態', async () => {
    assert.equal((await putRuleSet(example1(PRINCIPAL, CASE))).status, 200);
    const items = mine(await reconciliation());
    assert.equal(items.length, 7);
    assert.equal(find(items, 'sales_order.gross_margin').length, 0);
    assert.equal(find(items, 'sales_order.order_no').length, 1);
    assert.deepEqual(find(items, 'customer_master.customer_id')[0]?.constraints, {
        row_filter: [{ filter: 'region', op: 'in', values: ['central', 'north'] }],
        environment: 'prod',
    });
});

test('讓一條規則套用失敗（默默略過）→ 套用回 applied，但對帳看得出少了', async () => {
    const principal = '0b9f6c3e-0000-4000-8000-00000000000e';
    const rs = example1(principal, 'DA-2026-0401');
    assert.equal((await backdoor('sabotage', { rule_id: 'DA-2026-0401-2' })).status, 200);
    const r = await putRuleSet(rs);
    assert.equal(r.body['status'], 'applied');
    const items = (await reconciliation()).filter((i) => i.subject.id === principal);
    assert.deepEqual([...new Set(items.map((i) => i.resource.id.split('.')[0]))], ['customer_master']);
    assert.equal(items.length, 3);
});

test('後門只給 admin 金鑰，回應標示只供測試', async () => {
    const r = await backdoor('sabotage', { rule_id: 'x', clear: true });
    assert.equal(r.body['test_only_backdoor'], true);
    assert.equal((await call('POST', '/v1/admin/sabotage', { key: KEYS.auditor, body: '{}' })).status, 403);
});

test('到期的規則：權限還在目錄上（effective_now=false），exclude_inactive=1 時不列出', async () => {
    const principal = '0b9f6c3e-0000-4000-8000-000000000041';
    const rs = { ...example1(principal, 'DA-2025-0041'), valid: { from: '2025-01-01', to: '2025-12-31' } };
    assert.equal((await putRuleSet(rs)).status, 200);
    const all = (await reconciliation()).filter((i) => i.subject.id === principal);
    assert.equal(all.length, 7);
    assert.ok(all.every((i) => i.properties['effective_now'] === false));
    const r = await call('GET', '/v1/reconciliation?exclude_inactive=1', { key: KEYS.auditor });
    assert.equal((r.body['items'] as ReconItem[]).filter((i) => i.subject.id === principal).length, 0);
});
