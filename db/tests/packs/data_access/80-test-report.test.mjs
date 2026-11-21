// 測試報告（裁決 D94；db/packs/data_access/160_test_report.sql、db/kernel/560_grant_followup.sql；威脅表 docs/handoff/closed-loop-2.md）。
// 正式區的單引用測試區單時，系統從那張單的使用紀錄算出報告、凍結進內容（簽核人簽的內容包含它）；四種警示；版本識別；
// 沒有測試紀錄就上線時限期補上線後的使用報告（同一個報告 function）。
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { decisionContent, versionSha256 } from '../../../../web/lib/signing.js';
import { call, closePools, login, one, pool, registerPasskey, rejectsWith, setSetting } from '../../kernel/lib/harness.mjs';
import { CHANNEL, deliveryPool, drain, mockDc, salesOrderContent, systemDelivery } from './delivery-lib.mjs';
import { application, DA, decide, principals, today } from './lib.mjs';

const app = pool('APP');
const admin = pool('ADMIN');
const reconciler = pool('RECONCILER');
const scheduler = pool('SCHEDULER');
const delivery = deliveryPool();
const users = {};
let P;
let dc;

before(async () => {
    for (const uid of ['p03', 'p04', 'p05', 'p11', 'p17']) {
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

const view = (caseId, who = 'p04') => call(app, 'case_get', users[who].session, caseId);
const bot = () => ({ principal_id: P['sales-report-bot'], valid_from: today(), valid_to: today(60) });
const fields3 = ['amount', 'order_date', 'order_no'];
const testContent = (year, extra = {}) => ({ ...salesOrderContent(year, fields3), environment: 'test', ...extra });
const prodContent = (year, basis, extra = {}) => ({
    ...salesOrderContent(year, fields3),
    environment: 'prod',
    test_basis: { case_id: basis },
    application: application(),
    ...extra,
});
const draft = (content) => call(app, 'case_create', users.p04.session, DA, content, bot());
const revise = (caseId, content) => call(app, 'case_revise', users.p04.session, caseId, content, bot());
async function submitErrors(caseId) {
    try {
        await call(app, 'case_submit', users.p04.session, caseId, null);
    } catch (err) {
        assert.ok(String(err.message).startsWith('CONTENT_INVALID:'), err.message);
        return JSON.parse(err.detail).map((e) => e.code);
    }
    return [];
}
async function signThrough(caseId) {
    await decide(app, users.p03, caseId);
    await decide(app, users.p11, caseId);
    await call(app, 'task_claim', users.p17.session, caseId);
    await decide(app, users.p17, caseId);
}
async function active(content) {
    const caseId = (await call(app, 'case_submit_new', users.p04.session, DA, content, bot(), null)).case_id;
    await signThrough(caseId);
    await drain(delivery, dc);
    await call(app, 'case_confirm_verification', users.p04.session, caseId);
    assert.equal((await view(caseId)).state, 'active');
    return caseId;
}

const HOUR = 3600000;
let hoursAgo = 30;
/** 模擬的使用方系統交一批這張單的使用摘要（每次一個新的時段）。fields：{欄位: [查詢, 被擋]}。 */
async function used(caseId, fields, { versions = [], actor = 'p04' } = {}) {
    hoursAgo -= 1;
    const from = new Date(Math.floor((Date.now() - hoursAgo * HOUR) / HOUR) * HOUR);
    const at = new Date(from.getTime() + 60000).toISOString();
    const rows = Object.entries(fields).map(([field, [queries, blocked]]) => ({
        package: 'sales_order',
        field,
        queries,
        exports: 0,
        blocked,
        last_used_at: at,
    }));
    const item = {
        case_no: String((await view(caseId)).case_no),
        actor: { provider: 'sim-ldap', external_id: actor },
        period: { from: from.toISOString(), to: new Date(from.getTime() + HOUR).toISOString() },
        queries: Math.max(0, ...rows.map((r) => r.queries)),
        exports: 0,
        blocked: rows.reduce((n, r) => n + r.blocked, 0),
        last_used_at: at,
        environment: 'test',
        fields: rows,
        client_versions: versions,
    };
    const batch = { format: 'usage_summary_batch/2', database: 'mock', period_seconds: 3600, items: [item] };
    const r = (await one(reconciler, 'select api_job.usage_submit($1, $2) as r', [CHANNEL, dc.usage(batch)])).r;
    assert.equal(r.status, 'accepted', JSON.stringify(r));
}
const codes = (report) => report.warnings.map((w) => w.code);

test('DA-TEST-REPORT 系統從引用的測試區單的使用紀錄算出七個區塊，凍結進內容（版本雜湊與顯示摘要涵蓋它，瀏覽器與資料庫算出相同的要簽內容）；送審時重算，有新的使用紀錄就擋下、重新整理後才能送', async () => {
    const basis = await active(testContent(2410, { application: { program: '月報', version: 'report@1.0.0', audience: '業務主管' } }));
    await used(basis, { amount: [12, 0], order_no: [12, 0], order_date: [12, 0] });
    const d = await draft(prodContent(2411, basis));
    const r = d.content.test_report;
    assert.equal(r.format, 'data_access_test_report/1');
    assert.deepEqual(Object.keys(r).sort(), [
        'application',
        'blocked',
        'completeness',
        'diff',
        'format',
        'rows',
        'settings',
        'sha256',
        'source',
        'tested',
        'unused',
        'used',
        'warnings',
    ]);
    assert.equal(r.source.case_id, basis);
    assert.deepEqual(
        r.used.map((u) => [u.field, u.queries]),
        [
            ['amount', 12],
            ['order_date', 12],
            ['order_no', 12],
        ],
    );
    assert.equal(r.completeness.reported, true);
    assert.equal(r.completeness.total_uses, 12);
    assert.deepEqual(r.application.tested_version, { value: 'report@1.0.0', source: 'applicant' });
    // 申請人不能自己寫報告：輸入帶的 test_report 被換掉
    const forged = await draft(prodContent(2412, basis, { test_report: { sha256: 'ab'.repeat(32), warnings: [] } }));
    assert.equal(forged.content.test_report.sha256, (await draft(prodContent(2412, basis))).content.test_report.sha256);
    const v = await view(d.case_id);
    assert.equal(v.version_sha256, await versionSha256(v.content, v.terms));
    const shown = v.display.content.test_report;
    assert.equal(shown.sha256, r.sha256);
    assert.deepEqual(
        shown.sections.map((s) => s.key),
        ['tested', 'used', 'unused', 'blocked', 'diff', 'application', 'completeness'],
    );
    assert.ok(shown.sections.every((s) => s.lines.every((l) => typeof l === 'string')));
    // 送審前又進來一批：報告不同，擋下；重新整理（再存一次）後可以送
    await used(basis, { amount: [1, 0] });
    assert.deepEqual(await submitErrors(d.case_id), ['DA-E-TEST-REPORT-STALE']);
    const fresh = await revise(d.case_id, prodContent(2411, basis));
    assert.notEqual(fresh.content.test_report.sha256, r.sha256);
    assert.deepEqual(await submitErrors(d.case_id), []);
    const manager = await view(d.case_id, 'p03');
    await decide(app, users.p03, d.case_id);
    const ev = await one(
        admin,
        `select convert_from(body, 'UTF8')::jsonb -> 'data' as d from sgn.audit_event where case_id = $1 and event_type = 'case.approve'`,
        [d.case_id],
    );
    assert.deepEqual(ev.d.signed.content, await decisionContent(manager.display, 'approve', {}), '簽核人簽到的內容包含報告');
    // 送審時寫進快照（只增不改）：和內容裡的雜湊相同
    const snap = await one(admin, 'select version, report_sha256 from pack_data_access.test_report_snapshot where case_id = $1', [
        d.case_id,
    ]);
    assert.deepEqual(snap, { version: fresh.version, report_sha256: fresh.content.test_report.sha256 });
    await rejectsWith(
        admin.query(`update pack_data_access.test_report_snapshot set report = '{}' where case_id = $1`, [d.case_id]),
        'DA-E-REPORT-APPEND-ONLY',
    );
});

test('DA-TEST-REPORT-WARN 四種警示：沒測過的欄位、沒用到的欄位仍在申請裡、測試期間有被擋下的嘗試、測試量低於門檻（參數，依級別）；使用方沒有回報也標示', async () => {
    const basis = await active(testContent(2420));
    const none = await draft(prodContent(2421, basis));
    // 這個通道回報過使用紀錄，但這張單沒有任何一筆：每一欄都是沒用到、測試量 0
    assert.deepEqual(codes(none.content.test_report), ['unused_requested', 'low_volume']);
    await used(basis, { amount: [3, 0], order_date: [3, 0], gross_margin: [0, 2] });
    const d = await draft(prodContent(2421, basis));
    const r = d.content.test_report;
    assert.deepEqual(codes(r), ['unused_requested', 'blocked_attempts', 'low_volume']);
    assert.deepEqual(r.diff.unused_requested, [{ package: 'sales_order', field: 'order_no' }]);
    assert.deepEqual(r.blocked.outside_scope, [{ package: 'sales_order', field: 'gross_margin', blocked: 2 }]);
    assert.equal(r.warnings.find((w) => w.code === 'low_volume').threshold, 10);
    // 從申請拿掉沒用到的欄位：那個警示就沒了
    const smaller = await draft(
        prodContent(2421, basis, { scope: [{ ...salesOrderContent(2421).scope[0], fields: ['amount', 'order_date'] }] }),
    );
    assert.ok(!codes(smaller.content.test_report).includes('unused_requested'));
    assert.deepEqual(smaller.content.test_report.diff.dropped, [{ package: 'sales_order', field: 'order_no' }]);
    // 門檻是參數（依級別）
    await setSetting(admin, 'data_access.test_report_min_uses', 2, 'tier:data_access:L3');
    try {
        assert.ok(!codes((await draft(prodContent(2421, basis))).content.test_report).includes('low_volume'));
    } finally {
        await setSetting(admin, 'data_access.test_report_min_uses', 10, 'tier:data_access:L3');
    }
    // 沒測過的欄位（報告重用在範圍不一定被涵蓋的地方，例如續期）：直接以 function 驗
    const wider = {
        ...d.content,
        scope: [{ ...d.content.scope[0], fields: [...d.content.scope[0].fields, { code: 'customer_id', classification: 'L3' }] }],
    };
    const rep = (await one(admin, 'select pack_data_access.test_report($1, $2) as r', [basis, wider])).r;
    assert.deepEqual(rep.diff.untested, [{ package: 'sales_order', field: 'customer_id' }]);
    assert.ok(codes(rep).includes('untested_fields'));
    // 警示出現在顯示摘要（簽核人的決定畫面）
    const texts = (await view(d.case_id)).display.content.test_report.warnings.map((w) => w.text);
    assert.ok(texts.some((x) => x.includes('訂單編號') && x.includes('建議從這次申請拿掉')));
    assert.ok(texts.some((x) => x.includes('2 次被擋下')));
    const unreported = (
        await one(admin, 'select pack_data_access.test_report_warnings($1, $2) as w', [
            { ...rep, completeness: { ...rep.completeness, reported: false } },
            d.content,
        ])
    ).w;
    assert.ok(unreported.some((w) => w.code === 'usage_unreported'));
});

test('DA-TEST-VERSION 版本識別以使用方在使用紀錄裡帶的為準（沒有才用申請人填的）；和這次申請的不同時依參數：提示（L3 預設）或要重新測試（L4 預設）', async () => {
    const value = async (tier) =>
        (
            await one(
                admin,
                `select sgn_sdk.setting('data_access.version_change_action', array['tier:data_access:' || $1]) #>> '{}' as v`,
                [tier],
            )
        ).v;
    assert.equal(await value('L3'), 'warn');
    assert.equal(await value('L4'), 'block');
    const basis = await active(testContent(2430, { application: { program: '月報', version: 'report@1.0.0', audience: '業務主管' } }));
    await used(basis, { amount: [20, 0], order_date: [20, 0], order_no: [20, 0] }, { versions: ['report@1.1.0'] });
    const same = await draft(prodContent(2431, basis, { application: application('report@1.1.0') }));
    assert.deepEqual(same.content.test_report.application.tested_version, { value: 'report@1.1.0', source: 'usage' });
    assert.ok(!codes(same.content.test_report).includes('version_changed'));
    const changed = await draft(prodContent(2431, basis, { application: application('report@2.0.0') }));
    assert.deepEqual(
        changed.content.test_report.warnings.find((w) => w.code === 'version_changed'),
        { code: 'version_changed', tested: 'report@1.1.0', requested: 'report@2.0.0' },
    );
    await setSetting(admin, 'data_access.version_change_action', 'block', 'tier:data_access:L3');
    try {
        assert.deepEqual(await submitErrors(changed.case_id), ['DA-E-VERSION-RETEST']);
    } finally {
        await setSetting(admin, 'data_access.version_change_action', 'warn', 'tier:data_access:L3');
    }
    assert.deepEqual(await submitErrors(changed.case_id), [], 'L3 只提示');
});

test('DA-TEST-REPORT-FOLLOWUP K-GRANT-FOLLOWUP 沒有測試紀錄就上線：生效時開帶期限的例外並通知申請人；只有申請人能產生上線後的使用報告（同一套報告，只增不改、進鏈），產生後結案；逾期升級、不撤銷', async () => {
    const content = {
        ...salesOrderContent(2440, fields3),
        environment: 'prod',
        test_exception: { reason: '新報表' },
        application: application(),
    };
    const caseId = await active(content);
    const [x] = (
        await admin.query(
            `select id::int, detail, closed_at from sgn.exception_record where case_id = $1 and rule_code = 'DA-TEST-REPORT-FOLLOWUP'`,
            [caseId],
        )
    ).rows;
    assert.ok(x && x.closed_at === null);
    assert.equal(x.detail.settings['data_access.post_launch_report_workdays'], 20);
    assert.deepEqual(x.detail.rules, ['DA-TEST-REPORT-FOLLOWUP', 'K-GRANT-FOLLOWUP']);
    const f = await one(admin, 'select due_at > clock_timestamp() as later from sgn.exception_followup where exception_id = $1', [x.id]);
    assert.equal(f.later, true);
    const n = await one(
        admin,
        `select count(*)::int as n from sgn.notification_outbox where case_id = $1 and event_code = 'grant.followup'`,
        [caseId],
    );
    assert.equal(n.n, 1);
    const pending = await call(app, 'data_access_report_pending', users.p04.session);
    assert.ok(pending.some((p) => p.case_id === caseId));
    await rejectsWith(call(app, 'data_access_usage_report', users.p05.session, caseId), 'DA-E-USAGE-REPORT-DENIED');
    const made = await call(app, 'data_access_usage_report', users.p04.session, caseId);
    assert.ok(made.display.sections.length === 7);
    const row = await one(admin, 'select report_sha256, event_seq from pack_data_access.usage_report where case_id = $1', [caseId]);
    assert.equal(row.report_sha256, made.report_sha256);
    await rejectsWith(admin.query('update pack_data_access.usage_report set kind = kind'), 'DA-E-REPORT-APPEND-ONLY');
    assert.ok((await one(admin, 'select closed_at from sgn.exception_record where id = $1', [x.id])).closed_at);
    assert.ok(!(await call(app, 'data_access_report_pending', users.p04.session)).some((p) => p.case_id === caseId));
    // 逾期：期限 0 個工作天的單，排程升級一次，授權照樣有效
    await setSetting(admin, 'data_access.post_launch_report_workdays', 0, 'tier:data_access:L3');
    let late;
    try {
        late = await active({ ...content, data_period: { from: '2441-01-01', to: '2441-12-31' } });
    } finally {
        await setSetting(admin, 'data_access.post_launch_report_workdays', 20, 'tier:data_access:L3');
    }
    await one(scheduler, 'select api_job.exception_followup_due() as r');
    const esc = await one(
        admin,
        `select f.escalated_at from sgn.exception_followup f join sgn.exception_record x on x.id = f.exception_id
         where x.case_id = $1 and x.rule_code = 'DA-TEST-REPORT-FOLLOWUP'`,
        [late],
    );
    assert.ok(esc.escalated_at, '逾期升級');
    assert.equal((await view(late)).state, 'active', '不撤銷');
});
