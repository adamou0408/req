// 注入：列條件的值（引號、分號、註解、聯集、反斜線、dollar quote）只會被當成一個字串值，
// 不會變成 SQL；代碼類的輸入（主題包、欄位、列條件、principal_id、單號）不在目錄上就拒絕。
import assert from 'node:assert/strict';
import { ruleRoleFor } from '../src/roles.ts';
import { after, before, test } from 'node:test';
import pg from 'pg';
import {
    call,
    example1,
    putRuleSet,
    reconciliation,
    signed,
    sql,
    startServer,
    stopServer,
    testQuery,
    type QueryInput,
    envelope,
} from './harness.ts';

const PRINCIPAL = '0b9f6c3e-0000-4000-8000-00000000000f';
const ROLE = 'simdc_t_p_0b9f6c3e00004000800000000000000f';

const PAYLOADS = [
    "north'",
    "north'; drop table data.sales_order; --",
    "' or '1'='1",
    "north' union select 1 --",
    "north') or true or ('",
    'north /* comment */',
    "north'::text or region is not null --",
    '$$; drop table data.customer_master; $$',
    "north\\'; select pg_sleep(5); --",
    'north"; drop role simdc_service; --',
];

async function counts(): Promise<Record<string, string>> {
    const rows = await sql<{ t: string; n: string }>(
        `select 'customer_master' as t, count(*)::text as n from data.customer_master
         union all select 'sales_order', count(*)::text from data.sales_order`,
    );
    return Object.fromEntries(rows.map((r) => [r.t, r.n]));
}

before(startServer);
after(stopServer);

test('列條件的值是注入字串：照樣套用成字面值，看不到任何一列，資料表完好', async () => {
    const before = await counts();
    const rs = example1(PRINCIPAL, 'DA-2026-0500');
    for (const rule of rs.rules) rule.row_filter = [{ filter: 'region', op: 'in', values: PAYLOADS }];
    const r = await putRuleSet(rs);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(await counts(), before);
    for (const region of ['north', 'central', 'south', 'east']) {
        const q = await testQuery(PRINCIPAL, {
            package: 'customer_master',
            fields: ['customer_id'],
            row: { region },
            data_date: null,
            action: 'query',
            as_of: '2026-12-01',
        });
        assert.equal(q['decision'], 'deny', region);
        assert.equal(q['reason'], 'row_filter');
    }
    // 對帳讀回來的值和送進去的一模一樣
    const item = (await reconciliation()).find(
        (i) => String(i.properties['db_role']).startsWith(`${ROLE}_r`) && i.resource.id === 'customer_master.customer_id',
    );
    assert.deepEqual(item?.constraints, { row_filter: [{ filter: 'region', op: 'in', values: PAYLOADS }] });
    // 服務角色仍然在、不是 superuser
    const svc = await sql<{ rolsuper: boolean }>(`select rolsuper from pg_roles where rolname = 'simdc_service'`);
    assert.deepEqual(svc, [{ rolsuper: false }]);
});

test('測試查詢的 row 值是注入字串：以參數傳遞，只是查不到資料', async () => {
    const before = await counts();
    for (const region of PAYLOADS) {
        const q = await testQuery(PRINCIPAL, {
            package: 'customer_master',
            fields: ['customer_id'],
            row: { region },
            data_date: null,
            action: 'query',
            as_of: '2026-12-01',
        });
        assert.equal(q['decision'], 'no_data', region);
    }
    // 注入值存在的那一列（用測試列）只有規則裡的值本身符合
    const probe = await testQuery(
        PRINCIPAL,
        {
            package: 'customer_master',
            fields: ['customer_id'],
            row: { region: PAYLOADS[1] ?? '' },
            data_date: null,
            action: 'query',
            as_of: '2026-12-01',
        },
        true,
    );
    assert.equal(probe['decision'], 'allow');
    assert.deepEqual(await counts(), before);
});

test('代碼類的輸入不在目錄上就拒絕', async () => {
    const mk = (mutate: (rs: ReturnType<typeof example1>) => void): string => {
        const rs = example1(PRINCIPAL, 'DA-2026-0501');
        mutate(rs);
        return JSON.stringify(rs);
    };
    const bodies = [
        mk((rs) => {
            if (rs.rules[0] !== undefined) rs.rules[0].package = 'customer_master; drop table data.payroll';
        }),
        mk((rs) => {
            if (rs.rules[0] !== undefined) rs.rules[0].fields = ['customer_id", "tax_id'];
        }),
        mk((rs) => {
            if (rs.rules[0] !== undefined) rs.rules[0].fields = ['row_id'];
        }),
        mk((rs) => {
            if (rs.rules[0] !== undefined) rs.rules[0].row_filter = [{ filter: 'region) or (true', op: 'in', values: ['north'] }];
        }),
        mk((rs) => {
            if (rs.rules[1] !== undefined) rs.rules[1].row_filter = [{ filter: 'order_amount', op: 'between', values: ['0 or 1=1', null] }];
        }),
        mk((rs) => {
            if (rs.rules[1]?.data_period) rs.rules[1].data_period.from = "2025-01-01' or '1'='1";
        }),
        mk((rs) => {
            if (rs.rules[0] !== undefined) rs.rules[0].rule_id = "x'; drop table data.payroll; --";
        }),
        mk((rs) => {
            rs.grantee.principal_id = '1; drop role simdc_service';
        }),
    ];
    for (const raw of bodies) {
        const body = envelope('PUT', '/v1/rule-sets/DA-2026-0501', JSON.parse(raw));
        const r = await call('PUT', '/v1/rule-sets/DA-2026-0501', { body, headers: signed(body) });
        assert.equal(r.status, 422, body.slice(0, 120));
    }
    const caseNo = encodeURIComponent("DA'; drop table data.payroll; --");
    const body = envelope('PUT', `/v1/rule-sets/${caseNo}`, example1(PRINCIPAL, 'DA-2026-0501'));
    assert.equal((await call('PUT', `/v1/rule-sets/${caseNo}`, { body, headers: signed(body) })).status, 400);
    assert.equal((await sql(`select to_regclass('data.payroll') is not null as ok`))[0]?.['ok'], true);
});

test('測試查詢的代碼類輸入不在目錄上就拒絕', async () => {
    const bad = [
        { package: 'payroll; drop table data.payroll', fields: ['net_pay'] },
        { package: 'payroll', fields: ['net_pay from data.payroll; --'] },
        { package: 'payroll', fields: ['net_pay'], row: { 'pay_type = pay_type or true --': 'x' } },
    ];
    for (const q of bad) {
        const r = await call('POST', '/v1/test-query', {
            body: JSON.stringify({
                principal_id: PRINCIPAL,
                query: { row: {}, data_date: null, action: 'query', as_of: '2026-12-01', ...q },
            }),
        });
        assert.equal(r.status, 422, JSON.stringify(q));
    }
    const r = await call('POST', '/v1/test-query', {
        body: JSON.stringify({
            principal_id: "x' or '1'='1",
            query: { package: 'payroll', fields: ['net_pay'], row: {}, data_date: null, action: 'query', as_of: '2026-12-01' },
        }),
    });
    assert.equal(r.status, 422);
});

test('被授權者不能自己指定查詢日期，把過期的授權變回有效', async () => {
    const principal = '0b9f6c3e-0000-4000-8000-000000000050';
    const role = 'simdc_t_p_0b9f6c3e000040008000000000000050';
    const rs = { ...example1(principal, 'DA-2025-0050'), valid: { from: '2025-01-01', to: '2025-12-31' } };
    assert.equal((await putRuleSet(rs)).status, 200);
    const query: QueryInput = {
        package: 'customer_master',
        fields: ['customer_id'],
        row: { region: 'north' },
        data_date: null,
        action: 'query',
        as_of: '2025-06-01',
    };
    // 服務自己的測試查詢可以指定日期
    assert.equal((await testQuery(principal, query))['decision'], 'allow');
    // 以一個登入帳號（被授權者角色的成員）自己連進來，設定 simdc.as_of 也沒用
    await sql(`drop role if exists simdc_t_login`);
    await sql(`create role simdc_t_login login password 'simdc-t-login'`);
    // 規則是各自的角色：成員要是那條規則的角色才讀得到它的欄位
    const ruleRole = ruleRoleFor(role, 'DA-2025-0050-1');
    await sql(`grant ${ruleRole} to simdc_t_login`);
    await sql(`grant connect on database ${process.env['SIM_DC_DB'] ?? ''} to simdc_t_login`);
    const client = new pg.Client({
        host: process.env['SIM_DC_PG_HOST'],
        port: Number(process.env['SIM_DC_PG_PORT']),
        database: process.env['SIM_DC_DB'],
        user: 'simdc_t_login',
        password: 'simdc-t-login',
    });
    await client.connect();
    try {
        await client.query(`set role ${ruleRole}`);
        await client.query(`set simdc.as_of = '2025-06-01'`);
        const seen = await client.query<{ n: string }>(`select count(customer_id)::text as n from data.customer_master`);
        assert.equal(seen.rows[0]?.n, '0');
        await assert.rejects(client.query('select tax_id from data.customer_master'), /permission denied/);
        await assert.rejects(client.query('select * from simdc_meta.rule_set'), /permission denied/);
    } finally {
        await client.end();
        await sql(`revoke connect on database ${process.env['SIM_DC_DB'] ?? ''} from simdc_t_login`);
        await sql(`drop role simdc_t_login`);
    }
});
