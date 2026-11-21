// 核心與流程包的邊界（骨幹第 9 節的邊界規則）與流程包的對外介面。
//   1. 核心（db/kernel 的檔案、核心 schema 的 function）不出現任何流程包的概念
//   2. 流程包只經 sgn_sdk 接觸核心，不直接讀寫 sgn 的資料表、不呼叫 sgn_internal
//   3. 應用程式角色碰不到流程包的 schema 與 sgn_sdk
//   4. 流程包登記的 hook 與路徑；對外路由的回傳結構
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { packRoutes, shapeProblems } from '../../../../packages/contract/src/routes.ts';
import { DB_DIR } from '../../../tools/lib/env.mjs';
import { call, closePools, config, login, pool } from '../../kernel/lib/harness.mjs';

const admin = pool('ADMIN');
const app = pool('APP');
after(closePools);

const PACKS = readdirSync(join(DB_DIR, 'packs'));
// 流程包的概念：代號、schema、規則代碼前綴
const packMarkers = PACKS.flatMap((code) => [code, `pack_${code}`]).concat(['DA-']);

async function sources(where) {
    const { rows } = await admin.query(
        `select n.nspname || '.' || p.proname as fn, p.prosrc as src
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         join pg_language l on l.oid = p.prolang
         where l.lanname in ('sql', 'plpgsql') and ${where}`,
    );
    return rows;
}

test('架構：核心的 migration 檔案與核心 schema 的 function 裡，不出現任何流程包的代號、schema 或規則代碼', async () => {
    assert.deepEqual(PACKS, ['data_access']);
    const kernelDir = join(DB_DIR, 'kernel');
    for (const file of readdirSync(kernelDir).filter((f) => f.endsWith('.sql'))) {
        const text = readFileSync(join(kernelDir, file), 'utf8');
        for (const marker of packMarkers) assert.ok(!text.includes(marker), `db/kernel/${file} 含有流程包的概念 ${marker}`);
    }
    const kernelFns = await sources(
        `(n.nspname in ('sgn_internal', 'sgn_sdk', 'api_sync', 'api_job') or (n.nspname = 'api' and p.proname not like all (array[${PACKS.map((c) => `'${c}\\_%'`).join(', ')}])))`,
    );
    assert.ok(kernelFns.length > 100, `只找到 ${kernelFns.length} 個核心 function`);
    for (const { fn, src } of kernelFns) {
        for (const marker of packMarkers) assert.ok(!src.includes(marker), `${fn} 含有流程包的概念 ${marker}`);
    }
});

test('架構：流程包只經 sgn_sdk 接觸核心——流程包的 function 不直接引用 sgn 的資料表，也不呼叫 sgn_internal', async () => {
    const packFns = await sources(`(n.nspname like 'pack\\_%' or (n.nspname = 'api' and p.proname like 'data\\_access\\_%'))`);
    assert.ok(packFns.length >= 20, `只找到 ${packFns.length} 個流程包 function`);
    for (const { fn, src } of packFns) {
        assert.ok(!/\bsgn\s*\.\s*\w/.test(src), `${fn} 直接引用核心的資料表`);
        assert.ok(!/\bsgn_internal\s*\./.test(src), `${fn} 直接呼叫 sgn_internal`);
    }
    // migration 檔案本身（含登記）也只經 sgn_sdk
    const packDir = join(DB_DIR, 'packs', 'data_access');
    for (const file of readdirSync(packDir)) {
        const text = readFileSync(join(packDir, file), 'utf8');
        assert.ok(!/\bsgn\.\w/.test(text) && !/\bsgn_internal\./.test(text), `db/packs/data_access/${file} 繞過 sgn_sdk`);
    }
});

test('架構：流程包的程式裡沒有寫死的時限（不得出現 interval 常數；時限一律是參數）', async () => {
    for (const { fn, src } of await sources(`n.nspname like 'pack\\_%'`)) {
        assert.ok(!/\binterval\b/i.test(src), `${fn} 有寫死的時限`);
    }
});

test('架構：應用程式角色對流程包的 schema 與 sgn_sdk 沒有任何權限；流程包的 function 不對 PUBLIC 開放', async () => {
    const role = config.db.SGN_ROLE_APP;
    for (const schema of ['pack_data_access', 'sgn_sdk']) {
        const { rows } = await admin.query(`select has_schema_privilege($1, $2, 'usage') as usage`, [role, schema]);
        assert.equal(rows[0].usage, false, `${role} 有 ${schema} 的 usage`);
    }
    const tables = await admin.query(
        `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'pack_data_access' and c.relkind = 'r'
           and (has_table_privilege($1, c.oid, 'select') or has_table_privilege($1, c.oid, 'insert'))`,
        [role],
    );
    assert.deepEqual(tables.rows, []);
    const open = await admin.query(
        `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname in ('pack_data_access', 'sgn_sdk') and has_function_privilege('public', p.oid, 'execute')`,
    );
    assert.deepEqual(open.rows, []);
});

test('架構：資料授權登記了十六個 hook（簽章由核心檢查；顯示的兩個是 D75 新增；交付、驗證、對帳的四個是 D63 新增；交付結果與對帳回報的判定是 D92 新增；送審複核是 D93 新增，K-SUBMIT-REVIEW；生效後的後續是 D94 新增，K-GRANT-FOLLOWUP），路徑的關卡與 resolver 是資料；第 2 版路徑多了代填時的負責人確認（K-PRINCIPAL-OWNER-CONFIRM）', async () => {
    const pt = (await admin.query(`select hooks from sgn.process_type where code = 'data_access'`)).rows[0];
    assert.deepEqual(Object.keys(pt.hooks).sort(), [
        'after_grant_activated',
        'build_delivery',
        'build_fulfilment',
        'build_verification_cases',
        'check_delivery_result',
        'check_reconciliation_report',
        'classify_tier',
        'compare_content',
        'display_content',
        'display_overlap',
        'expected_entitlements',
        'find_overlaps',
        'normalize_constraints',
        'normalize_content',
        'review_submission',
        'stage_scopes',
    ]);
    const { rows } = await admin.query(
        `select p.version, s.seq, s.code, s.phase, s.resolver_kind, s.resolver_role, s.mode, s.applies_when, p.top_resolver_role
         from sgn.policy_stage s join sgn.approval_policy p on p.id = s.policy_id
         where p.process_type = 'data_access' order by p.version, s.seq`,
    );
    const v1 = [
        ['manager', 'approval', 'applicant_manager', null, 'one', null],
        ['data_owner', 'approval', 'scoped_role', 'data_owner', 'all', null],
        ['ciso', 'approval', 'role_holder', 'ciso', 'one', { tier_in: ['L4'] }],
        ['mis', 'approval', 'role_group_claim', 'mis', 'one', null],
        ['fulfil', 'fulfilment', 'system_custodian', 'system_custodian', 'one', null],
    ];
    const of = (version) =>
        rows.filter((r) => r.version === version).map((r) => [r.code, r.phase, r.resolver_kind, r.resolver_role, r.mode, r.applies_when]);
    // 已送審的單綁定送審當時的版本：第 1 版不變（只增不改）
    assert.deepEqual(of(1), v1);
    assert.deepEqual(of(2), [
        ['principal_owner', 'approval', 'principal_owner', null, 'one', { applicant_not_principal_owner: true }],
        ...v1,
    ]);
    assert.deepEqual([...new Set(rows.map((r) => r.version))], [1, 2]);
    assert.ok(rows.every((r) => r.top_resolver_role === 'board_chair'));
});

let user;
before(async () => {
    user = await login(app, 'p04');
});

test('契約：流程包的每個路由都存在、參數相符，回傳結構符合路由表（真的呼叫一次）', async () => {
    for (const route of packRoutes.data_access) {
        const fn = await admin.query(
            `select coalesce(p.proargnames, '{}') as args from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'api' and p.proname = $1`,
            [route.fn],
        );
        assert.deepEqual(
            fn.rows[0].args,
            route.params.map((p) => `p_${p}`),
        );
    }
    const catalog = await call(app, 'data_access_catalog', user.session);
    assert.deepEqual(shapeProblems(catalog, packRoutes.data_access[0].returns), []);
    assert.deepEqual(
        catalog.packages.map((p) => p.code),
        ['customer_master', 'sales_order', 'product_cost', 'payroll'],
    );
    assert.equal(catalog.purpose_categories.length, 6);
    assert.deepEqual(
        catalog.environments.map((e) => [e.code, e.requires_test_basis, e.is_default, e.applies_to_legacy]),
        [
            ['test', false, true, false],
            ['prod', true, false, true],
        ],
    );
    const bases = await call(app, 'data_access_test_bases', user.session, '00000000-0000-0000-0000-000000000000');
    assert.deepEqual(shapeProblems(bases, packRoutes.data_access.find((r) => r.fn === 'data_access_test_bases').returns), []);
});
