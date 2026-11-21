// 使用方系統的能力宣告（裁決 D92 (5)；db/packs/data_access/140_capability.sql）：受管系統做不到的限制，送審時提示落差
// （進入簽的內容）或擋下（參數，依級別），匯出做不到時關閉可否匯出；自動驗證不驗做不到的限制並記下。
// 這個檔案改受管系統 dc 的宣告：每個測試結束前改回「做得到」（參數只增不改，改回去也是新增一筆）。
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { call, closePools, login, one, pool, registerPasskey, rejectsWith, setSetting } from '../../kernel/lib/harness.mjs';
import { deliveryPool, drain, mockDc, salesOrderContent, systemDelivery } from './delivery-lib.mjs';
import { DA, decide, l4Content, principals, terms, today } from './lib.mjs';

const app = pool('APP');
const admin = pool('ADMIN');
const delivery = deliveryPool();
const users = {};
let P;
let dc;

before(async () => {
    for (const uid of ['p03', 'p04', 'p11', 'p17']) {
        users[uid] = await login(app, uid);
        users[uid].key = await registerPasskey(app, users[uid]);
    }
    P = await principals(app, users.p04.session);
    await systemDelivery(admin);
    dc = await mockDc(admin);
    await drain(delivery, dc);
});
after(async () => {
    await delivery.end();
    await closePools();
});

const declare = (system, aspect, value) => setSetting(admin, `data_access.capability.${aspect}`, value, `system:${system}`);
const capable = async (system, aspect) => (await one(admin, 'select pack_data_access.system_capable($1, $2) as c', [system, aspect])).c;
const ASPECTS = ['column', 'row', 'data_period', 'export', 'usage_log'];
const botTerms = () => ({ principal_id: P['sales-report-bot'], valid_from: today(), valid_to: today(60) });
const draft = async (content, t = botTerms()) => call(app, 'case_create', users.p04.session, DA, content, t);

test('DA-CAPABILITY-DECLARE 能力宣告放在受管系統的參數：沒有宣告的系統每一項都當作做不到；示範環境的 dc 宣告全部做得到', async () => {
    for (const aspect of ASPECTS) {
        assert.equal(await capable('erp', aspect), false, `erp ${aspect}`);
        assert.equal(await capable('dc', aspect), true, `dc ${aspect}`);
    }
    const def = await one(admin, `select scope_kinds, default_value from sgn.setting_definition where key = 'data_access.capability.row'`);
    assert.deepEqual(def, { scope_kinds: ['system'], default_value: false });
    // 宣告帶生效時間、只增不改：改成做不到之後立即生效，改回來也是新增一筆
    await declare('dc', 'row', false);
    assert.equal(await capable('dc', 'row'), false);
    await declare('dc', 'row', true);
    assert.equal(await capable('dc', 'row'), true);
});

test('DA-CAPABILITY-GAP L3：用到做不到的限制時提示，記進內容並出現在顯示摘要（簽核人簽的內容包含它）；跨兩個系統只提示做不到的那一個；匯出做不到時關閉可否匯出', async () => {
    await declare('dc', 'row', false);
    try {
        const content = {
            ...salesOrderContent(2130),
            scope: [
                ...salesOrderContent(2130).scope,
                {
                    package: 'payroll',
                    fields: ['employee_id', 'pay_date'],
                    row_filters: [{ filter: 'pay_type', op: 'in', values: ['monthly'] }],
                },
            ],
        };
        const c = await draft(content);
        assert.deepEqual(c.content.capability_gaps, [{ package: 'sales_order', system: 'dc', aspect: 'row' }]);
        assert.ok(c.notices.some((n) => n.code === 'DA-N-CAPABILITY-GAP' && n.message.includes('列條件')));
        assert.deepEqual(c.errors, [], 'L3 只提示，不擋');
        const v = await call(app, 'case_get', users.p04.session, c.case_id);
        assert.equal(v.display.content.capability_gaps.length, 1);
        assert.match(v.display.content.capability_gaps[0].text, /銷售訂單.*dc.*列條件.*所有的列都會開放/);
        // 送審後主管簽的內容含這個提示：鏈上的顯示雜湊和沒有落差時的不同
        await call(app, 'case_submit', users.p04.session, c.case_id, null);
        await decide(app, users.p03, c.case_id);
        await declare('dc', 'row', true);
        const same = await draft(content);
        assert.deepEqual(same.content.capability_gaps, []);
        const a = await one(admin, `select sgn_internal.jcs_sha256(pack_data_access.display_capable($1)) as h`, [c.content]);
        const b = await one(admin, `select sgn_internal.jcs_sha256(pack_data_access.display_capable($1)) as h`, [same.content]);
        assert.notDeepEqual(a.h, b.h);
        // 匯出：系統分不出查詢與匯出時，可否匯出的欄位關閉
        await declare('dc', 'export', false);
        const exp = await draft({ ...salesOrderContent(2131), export_allowed: true });
        assert.equal(exp.content.export_allowed, false);
        assert.ok(exp.notices.some((n) => n.code === 'DA-N-CAPABILITY-EXPORT'));
    } finally {
        await declare('dc', 'row', true);
        await declare('dc', 'export', true);
    }
});

test('DA-CAPABILITY-GAP L4 預設擋下（參數 data_access.capability_gap_action 依級別）：送審被擋、錯誤寫明哪個系統的哪一項；改成 warn 就只提示', async () => {
    await declare('hr_saas', 'column', false);
    try {
        const content = l4Content({ data_period: { from: '2026-01-01', to: '2026-12-31' } });
        const c = await draft(content, terms(P['ap-recon-bot'], 2));
        assert.ok(c.errors.some((e) => e.code === 'DA-E-CAPABILITY-GAP' && e.message.includes('hr_saas')));
        await rejectsWith(call(app, 'case_submit', users.p04.session, c.case_id, null), 'CONTENT_INVALID');
        await setSetting(admin, 'data_access.capability_gap_action', 'warn', 'tier:data_access:L4');
        const warned = await draft(content, terms(P['ap-recon-bot'], 2));
        assert.deepEqual(warned.errors, []);
        assert.equal(warned.content.capability_gaps[0].aspect, 'column');
    } finally {
        await setSetting(admin, 'data_access.capability_gap_action', 'block', 'tier:data_access:L4');
        await declare('hr_saas', 'column', true);
    }
});

test('DA-CAPABILITY-VERIFY K-VERIFY-SKIPPED 自動驗證依能力產生案例：做不到的限制不驗、不送外部系統、不算進比對，記在驗證紀錄並標示「未驗證」；其他照驗', async () => {
    await declare('dc', 'row', false);
    let caseId;
    try {
        const c = await call(app, 'case_submit_new', users.p04.session, DA, salesOrderContent(2132), botTerms(), null);
        caseId = c.case_id;
        await decide(app, users.p03, caseId);
        await decide(app, users.p11, caseId);
        await call(app, 'task_claim', users.p17.session, caseId);
        await decide(app, users.p17, caseId);
        await drain(delivery, dc);
    } finally {
        await declare('dc', 'row', true);
    }
    const v = await call(app, 'case_get', users.p04.session, caseId);
    const [run] = v.delivery.verifications;
    assert.equal(run.status, 'passed');
    assert.deepEqual(
        run.skipped.map((s) => s.code),
        ['sales_order:row:region'],
    );
    assert.match(run.skipped[0].reason, /dc.*列條件.*未驗證/);
    assert.ok(!run.cases.some((x) => x.code === 'sales_order:row:region'));
    const sent = await one(admin, `select body from sgn.delivery_op where case_id = $1 and kind = 'verify'`, [caseId]);
    assert.ok(!JSON.parse(sent.body).cases.some((x) => x.code === 'sales_order:row:region'), '不送外部系統');
    const ev = await one(
        admin,
        `select convert_from(body, 'UTF8')::jsonb -> 'data' as d from sgn.audit_event where case_id = $1 and event_type = 'verification.started'`,
        [caseId],
    );
    assert.deepEqual(
        ev.d.skipped.map((s) => s.code),
        ['sales_order:row:region'],
    );
    assert.ok(ev.d.rules.includes('K-VERIFY-SKIPPED'));
});
