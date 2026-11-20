// 清除到期的權限：到期當下查不到（列層級安全）；清除後系統目錄上不再有該規則的權限。
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { call, example1, KEYS, putRuleSet, reconciliation, sql, startServer, stopServer, testQuery } from './harness.ts';

const P = '0b9f6c3e-0000-4000-8000-000000000091';
const ROLE = `simdc_t_p_${P.replaceAll('-', '')}`;
const P_ONLY_EXPIRED = '0b9f6c3e-0000-4000-8000-000000000092';
const EXPIRED = { from: '2025-01-01', to: '2025-12-31' };
const FUTURE = { from: '2999-01-01', to: '2999-12-31' };

const purge = (key: string | null = KEYS.platform) => call('POST', '/v1/maintenance/purge-expired', { key, body: '{}' });

before(async () => {
    await startServer();
    // 同一個被授權者：到期的單、有效的單、還沒開始的單
    assert.equal((await putRuleSet({ ...example1(P, 'DA-2025-0900'), valid: EXPIRED, export: true })).status, 200);
    assert.equal((await putRuleSet(example1(P, 'DA-2026-0901'))).status, 200);
    assert.equal((await putRuleSet({ ...example1(P, 'DA-2999-0902'), valid: FUTURE })).status, 200);
    assert.equal((await putRuleSet({ ...example1(P_ONLY_EXPIRED, 'DA-2025-0903'), valid: EXPIRED })).status, 200);
});
after(stopServer);

const rulesOfCase = (caseNo: string): Promise<{ rolname: string }[]> =>
    sql(
        `select rolname from pg_roles where starts_with(rolname, $1) and rolname like '%\\_r%' and shobj_description(oid, 'pg_authid') like $2`,
        ['simdc_t_p_', `%"rule_id":"${caseNo}-%`],
    );

describe('清除前：對帳分得出「已到期未清除」與「有效」', () => {
    test('lifecycle', async () => {
        const items = (await reconciliation()).filter((i) => i.subject.id === P);
        const by = (c: string): string[] => [
            ...new Set(items.filter((i) => i.properties['case_no'] === c).map((i) => String(i.properties['lifecycle']))),
        ];
        assert.deepEqual(by('DA-2025-0900'), ['expired_uncleared']);
        assert.deepEqual(by('DA-2026-0901'), ['effective']);
        assert.deepEqual(by('DA-2999-0902'), ['not_yet_valid']);
    });
    test('到期的規則權限還在目錄上，但查不到資料', async () => {
        assert.ok((await rulesOfCase('DA-2025-0900')).length > 0);
        const r = await testQuery(P_ONLY_EXPIRED, {
            package: 'customer_master',
            fields: ['customer_id'],
            row: { region: 'north' },
            data_date: null,
            action: 'query',
            as_of: '2026-11-20',
        });
        assert.equal(r['decision'], 'deny');
        assert.equal(r['reason'], 'expired');
    });
});

describe('清除', () => {
    test('只有 platform 金鑰可以呼叫', async () => {
        assert.equal((await purge(null)).status, 401);
        assert.equal((await purge(KEYS.auditor)).status, 403);
    });
    test('清除到期的規則，有效與還沒開始的不動', async () => {
        const r = await purge();
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body['status'], 'purged');
        const purged = r.body['purged'] as { case_no: string; rule_id: string }[];
        assert.deepEqual(purged.map((p) => p.case_no).sort(), ['DA-2025-0900', 'DA-2025-0900', 'DA-2025-0903', 'DA-2025-0903']);
        assert.equal((await rulesOfCase('DA-2025-0900')).length, 0);
        assert.equal((await rulesOfCase('DA-2026-0901')).length, 2);
        assert.equal((await rulesOfCase('DA-2999-0902')).length, 2);
    });
    test('系統目錄上不再有該規則的 policy、匯出檢視表', async () => {
        const policies = await sql<{ polname: string }>(`select polname from pg_policy where polname like 'rule\\_da\\_2025\\_090%'`);
        assert.equal(policies.length, 0);
        const views = await sql(
            `select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'export' and c.relkind = 'v'`,
        );
        assert.equal(views.length, 0);
        const items = (await reconciliation()).filter((i) => i.properties['case_no'] === 'DA-2025-0900');
        assert.equal(items.length, 0);
    });
    test('只剩到期規則的被授權者，連角色都不留', async () => {
        assert.equal(
            (await sql('select 1 from pg_roles where starts_with(rolname, $1)', [`simdc_t_p_${P_ONLY_EXPIRED.replaceAll('-', '')}`]))
                .length,
            0,
        );
        assert.equal((await sql('select 1 from pg_roles where rolname = $1', [ROLE])).length, 1);
    });
    test('有效的規則照常可查', async () => {
        const r = await testQuery(P, {
            package: 'customer_master',
            fields: ['customer_id'],
            row: { region: 'north' },
            data_date: null,
            action: 'query',
            as_of: '2026-11-20',
        });
        assert.equal(r['decision'], 'allow');
        const left = (await reconciliation()).filter((i) => i.subject.id === P);
        assert.ok(left.every((i) => i.properties['lifecycle'] !== 'expired_uncleared'));
    });
    test('再清除一次沒有東西可清；重送同一版也不會讓到期的規則復活', async () => {
        const again = await purge();
        assert.deepEqual(again.body['purged'], []);
        assert.equal((await putRuleSet({ ...example1(P, 'DA-2025-0900'), valid: EXPIRED, export: true })).status, 200);
        assert.equal((await rulesOfCase('DA-2025-0900')).length, 0);
    });
    test('服務的紀錄標出哪些規則已清除', async () => {
        const r = await call('GET', '/v1/rule-sets/DA-2025-0900', { key: KEYS.auditor });
        const rules = r.body['rules'] as { purged: boolean }[];
        assert.ok(rules.length > 0 && rules.every((x) => x.purged));
    });
});
