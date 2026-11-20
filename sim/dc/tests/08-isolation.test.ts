// 同一個被授權者有多張單時，每條規則各自隔離：實際可讀的範圍恰好是各規則範圍的聯集，
// 不是「所有欄位 × 所有列」的交叉。判定一律是以被授權者的角色真的查資料庫。
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { reconciliation, putRuleSet, sql, startServer, stopServer, testQuery, type QueryInput, type RuleSetInput } from './harness.ts';

const P1 = '0b9f6c3e-0000-4000-8000-000000000081';
const P2 = '0b9f6c3e-0000-4000-8000-000000000082';
const P3 = '0b9f6c3e-0000-4000-8000-000000000083';
const ROLE1 = `simdc_t_p_${P1.replaceAll('-', '')}`;

function order(
    principal: string,
    caseNo: string,
    fields: string[],
    regions: string[],
    opts: { exp?: boolean | null; from?: string; to?: string } = {},
): RuleSetInput {
    return {
        format: 'data_access_rule_set/1',
        case_no: caseNo,
        case_version_no: 1,
        grantee: { type: 'team', principal_id: principal, name: '隔離測試' },
        valid: { from: opts.from ?? '2026-01-01', to: opts.to ?? '2027-12-31' },
        export: opts.exp ?? false,
        rules: [
            {
                rule_id: `${caseNo}-1`,
                system: 'dc',
                package: 'sales_order',
                fields,
                row_filter: [{ filter: 'region', op: 'in', values: regions }],
                data_period: null,
            },
        ],
    };
}

function q(fields: string[], region: string, extra: Partial<QueryInput> = {}): QueryInput {
    return { package: 'sales_order', fields, row: { region }, data_date: '2026-03-01', action: 'query', as_of: '2026-06-01', ...extra };
}

async function decision(principal: string, query: QueryInput): Promise<unknown> {
    return (await testQuery(principal, query))['decision'];
}

before(async () => {
    await startServer();
    // P1：A 單（欄位 amount、北區）與 B 單（欄位 gross_margin、南區），兩張單都可匯出
    assert.equal((await putRuleSet(order(P1, 'DA-2026-0800', ['amount', 'order_no'], ['north'], { exp: true }))).status, 200);
    assert.equal((await putRuleSet(order(P1, 'DA-2026-0801', ['gross_margin', 'channel'], ['south'], { exp: true }))).status, 200);
    // P2：北區同時符合兩條規則；南區只符合 B
    assert.equal((await putRuleSet(order(P2, 'DA-2026-0802', ['amount'], ['north']))).status, 200);
    assert.equal((await putRuleSet(order(P2, 'DA-2026-0803', ['gross_margin'], ['north', 'south']))).status, 200);
    // P3：兩張單的授權期間不重疊
    assert.equal(
        (await putRuleSet(order(P3, 'DA-2026-0804', ['amount'], ['north'], { from: '2026-01-01', to: '2026-12-31' }))).status,
        200,
    );
    assert.equal(
        (await putRuleSet(order(P3, 'DA-2026-0805', ['gross_margin'], ['north'], { from: '2027-01-01', to: '2027-12-31' }))).status,
        200,
    );
});
after(stopServer);

describe('兩張單各自隔離（A：amount＋北區；B：gross_margin＋南區）', () => {
    test('北區的 amount、南區的 gross_margin 讀得到', async () => {
        assert.equal(await decision(P1, q(['amount'], 'north')), 'allow');
        assert.equal(await decision(P1, q(['gross_margin'], 'south')), 'allow');
    });
    test('北區的 gross_margin、南區的 amount 讀不到（不是對方的範圍）', async () => {
        const a = await testQuery(P1, q(['gross_margin'], 'north'));
        assert.equal(a['decision'], 'deny');
        assert.equal(a['reason'], 'row_filter');
        assert.ok(Number(a['rows_matching']) > 0);
        const b = await testQuery(P1, q(['amount'], 'south'));
        assert.equal(b['decision'], 'deny');
        assert.equal(b['reason'], 'row_filter');
    });
    test('兩組欄位一起查，同一列沒有任何一條規則涵蓋全部，就讀不到', async () => {
        assert.equal(await decision(P1, q(['amount', 'gross_margin'], 'north')), 'deny');
        assert.equal(await decision(P1, q(['amount', 'gross_margin'], 'south')), 'deny');
    });
    test('權限在資料庫裡是分開的：每條規則一個角色，沒有任何一個角色同時有兩組欄位', async () => {
        const rows = await sql<{ rolname: string; cols: string }>(
            `select r.rolname,
                    (select string_agg(a.attname, ',' order by a.attname) from pg_attribute a
                      where a.attrelid = 'data.sales_order'::regclass and a.attnum > 0
                        and a.attname not in ('row_id') and has_column_privilege(r.oid, a.attrelid, a.attname, 'SELECT')) as cols
             from pg_roles r where starts_with(r.rolname, $1) order by 1`,
            [`${ROLE1}_r`],
        );
        assert.deepEqual(rows.map((r) => r.cols).sort(), ['amount,order_no', 'channel,gross_margin']);
        const anchor = await sql<{ ok: boolean }>(`select has_any_column_privilege($1, 'data.sales_order', 'SELECT') as ok`, [ROLE1]);
        assert.equal(anchor[0]?.ok, false);
    });
});

describe('匯出不得跨規則', () => {
    test('各自的範圍可以匯出', async () => {
        assert.equal(await decision(P1, q(['amount'], 'north', { action: 'export' })), 'allow');
        assert.equal(await decision(P1, q(['gross_margin'], 'south', { action: 'export' })), 'allow');
    });
    test('對方的欄位×列不能匯出', async () => {
        assert.equal(await decision(P1, q(['gross_margin'], 'north', { action: 'export' })), 'deny');
        assert.equal(await decision(P1, q(['amount'], 'south', { action: 'export' })), 'deny');
        assert.equal(await decision(P1, q(['amount', 'gross_margin'], 'north', { action: 'export' })), 'deny');
    });
});

describe('同一列同時符合兩條規則', () => {
    test('兩組欄位都讀得到；只符合其中一條的列只讀得到那一條的欄位', async () => {
        assert.equal(await decision(P2, q(['amount', 'gross_margin'], 'north')), 'allow');
        assert.equal(await decision(P2, q(['amount'], 'north')), 'allow');
        assert.equal(await decision(P2, q(['gross_margin'], 'south')), 'allow');
        assert.equal(await decision(P2, q(['amount'], 'south')), 'deny');
        assert.equal(await decision(P2, q(['amount', 'gross_margin'], 'south')), 'deny');
    });
});

describe('授權期間也各自隔離', () => {
    test('A 的欄位只在 A 的期間內讀得到', async () => {
        assert.equal(await decision(P3, q(['amount'], 'north', { as_of: '2026-06-01' })), 'allow');
        const early = await testQuery(P3, q(['gross_margin'], 'north', { as_of: '2026-06-01' }));
        assert.equal(early['decision'], 'deny');
        assert.equal(early['reason'], 'not_yet_valid');
        assert.equal(await decision(P3, q(['gross_margin'], 'north', { as_of: '2027-06-01' })), 'allow');
        const late = await testQuery(P3, q(['amount'], 'north', { as_of: '2027-06-01' }));
        assert.equal(late['decision'], 'deny');
        assert.equal(late['reason'], 'expired');
    });
});

describe('對帳如實反映每條規則的欄位×列範圍', () => {
    test('P1：8 個項目（4 欄 × 讀＋匯出），每個欄位只掛在自己那條規則的列條件下', async () => {
        const items = (await reconciliation()).filter((i) => i.subject.id === P1);
        assert.equal(items.length, 8);
        const regionOf = (field: string, action: string): unknown =>
            items.filter((i) => i.resource.id === `sales_order.${field}` && i.action.name === action).map((i) => i.constraints);
        for (const action of ['read', 'export']) {
            for (const f of ['amount', 'order_no']) {
                assert.deepEqual(regionOf(f, action), [{ row_filter: [{ filter: 'region', op: 'in', values: ['north'] }] }]);
            }
            for (const f of ['gross_margin', 'channel']) {
                assert.deepEqual(regionOf(f, action), [{ row_filter: [{ filter: 'region', op: 'in', values: ['south'] }] }]);
            }
        }
        assert.ok(items.every((i) => i.properties['column_not_in_rule'] === undefined));
    });
    test('P2：北區同時符合兩條規則的欄位各一項；項目鍵不重複', async () => {
        const items = (await reconciliation()).filter((i) => i.subject.id === P2);
        assert.equal(items.length, 2);
        assert.equal(new Set(items.map((i) => i.item_key)).size, 2);
        const margin = items.find((i) => i.resource.id === 'sales_order.gross_margin');
        assert.deepEqual(margin?.constraints, { row_filter: [{ filter: 'region', op: 'in', values: ['north', 'south'] }] });
    });
});
