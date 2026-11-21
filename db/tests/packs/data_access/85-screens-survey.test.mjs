// 閉環第三批（docs/handoff/closed-loop-3.md）：
//   A 畫面問題中由資料庫決定的部分——捨棄草稿（K-CASE-DISCARD）、清單的順序與例外的分組（K-HOME-ORDER）、
//     原因會讓誰看到（K-REASON-AUDIENCE）、給操作者看的重疊提示（K-OVERLAP-SHOWN）；
//   B 匯出需求調查（DA-EXPORT-SURVEY*）：目的與頻率進內容與簽的內容，方法是附屬的調查紀錄（不進內容、不簽）。
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { packRoutes, shapeProblems } from '../../../../packages/contract/src/routes.ts';
import { decisionContent, versionSha256 } from '../../../../web/lib/signing.js';
import { call, closePools, login, one, pool, registerPasskey, rejectsWith, setSetting } from '../../kernel/lib/harness.mjs';
import { deliveryPool, drain, mockDc, salesOrderContent, systemDelivery } from './delivery-lib.mjs';
import { DA, decide, principals, today } from './lib.mjs';

const app = pool('APP');
const admin = pool('ADMIN');
const delivery = deliveryPool();
const users = {};
let P;
let dc;

before(async () => {
    for (const uid of ['p03', 'p04', 'p05', 'p11', 'p17', 'p22']) {
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

const bot = (days = 60) => ({ principal_id: P['sales-report-bot'], valid_from: today(), valid_to: today(days) });
const sales = (year, extra = {}) => ({ ...salesOrderContent(year), environment: 'test', ...extra });
const survey = (extra = {}) => ({ purpose: 'offline_analysis', frequency: 'monthly', ...extra });
const exporting = (year, s = survey()) => sales(year, { export_allowed: true, export_survey: s });
// 同一個被授權者在其他測試檔留下的有效授權可能和這裡的單部分重疊：送審一律附理由（K-OVERLAP-REASON 不是這裡要測的）
const OVERLAP_REASON = '測試：和其他測試留下的授權重疊';
const view = (caseId, who = 'p04') => call(app, 'case_get', users[who].session, caseId);
const draft = (content, t = bot(), who = 'p04') => call(app, 'case_create', users[who].session, DA, content, t);
const codes = (list) => list.map((x) => x.code);
/** 流程包路由的回傳結構（不多不少）。 */
const shaped = (fn, value) => {
    assert.deepEqual(shapeProblems(value, packRoutes.data_access.find((r) => r.fn === fn).returns), [], fn);
    return value;
};
const recordMethod = (caseId, method, note = null, who = 'p04') =>
    call(app, 'data_access_export_method_record', users[who].session, caseId, method, note);
const events = async (caseId, type) =>
    (
        await admin.query(
            `select convert_from(body, 'UTF8')::jsonb -> 'data' as data from sgn.audit_event where case_id = $1 and event_type = $2 order by seq`,
            [caseId, type],
        )
    ).rows.map((r) => r.data);
async function submitErrors(caseId) {
    try {
        await call(app, 'case_submit', users.p04.session, caseId, OVERLAP_REASON);
    } catch (err) {
        assert.ok(String(err.message).startsWith('CONTENT_INVALID:'), err.message);
        return JSON.parse(err.detail).map((e) => [e.path, e.code]);
    }
    return [];
}
async function signThrough(caseId) {
    await decide(app, users.p03, caseId);
    await decide(app, users.p11, caseId);
    await call(app, 'task_claim', users.p17.session, caseId);
    await decide(app, users.p17, caseId);
}
async function active(content, t = bot()) {
    const caseId = (await call(app, 'case_submit_new', users.p04.session, DA, content, t, OVERLAP_REASON)).case_id;
    await signThrough(caseId);
    await drain(delivery, dc);
    await call(app, 'case_confirm_verification', users.p04.session, caseId);
    assert.equal((await view(caseId)).state, 'active');
    return caseId;
}

// ── A ──

test('K-CASE-DISCARD 申請人捨棄從沒送審過的草稿：轉為已取消、留稽核事件（內容指紋）、不在我的申請；送審過的單、別人都不能捨棄', async () => {
    const d = await draft(sales(2401));
    assert.ok(d.actions.includes('discard'));
    await rejectsWith(call(app, 'case_discard', users.p05.session, d.case_id), 'NOT_APPLICANT');
    const gone = await call(app, 'case_discard', users.p04.session, d.case_id);
    assert.equal(gone.state, 'cancelled');
    assert.deepEqual(gone.actions, []);
    const [ev] = await events(d.case_id, 'case.discarded');
    assert.deepEqual(ev.rules, ['K-CASE-DISCARD']);
    assert.equal(ev.content_sha256, d.content_sha256);
    assert.equal(ev.version, d.version);
    const mine = await call(app, 'case_list_mine', users.p04.session);
    assert.ok(!mine.some((c) => c.case_id === d.case_id));
    // 內容照樣保存（軟性）
    assert.equal((await one(admin, 'select count(*)::int as n from sgn.case_version where case_id = $1', [d.case_id])).n, 1);
    await rejectsWith(call(app, 'case_discard', users.p04.session, d.case_id), 'STATE_TRANSITION');
    const sent = await call(app, 'case_submit_new', users.p04.session, DA, sales(2402), bot(), null);
    assert.ok(!sent.actions.includes('discard'));
    await rejectsWith(call(app, 'case_discard', users.p04.session, sent.case_id), 'STATE_TRANSITION');
});

test('K-HOME-ORDER 首頁區塊依 capabilities 的順序（稽核在我的申請之前）；待簽清單等最久的在前；我的申請有動作的在前；例外同規則同單合成一筆、未結案與已結案分開', async () => {
    const auditorCaps = (await call(app, 'me', users.p22.session)).capabilities;
    assert.ok(auditorCaps.indexOf('audit') < auditorCaps.indexOf('case.submit'), JSON.stringify(auditorCaps));
    assert.ok(auditorCaps.includes('report'));
    const caps = (await call(app, 'me', users.p03.session)).capabilities;
    if (caps.includes('inbox')) assert.equal(caps[0], 'inbox');
    // 待簽：b 等得比較久（工作較早開始）就排在 a 前面，即使單號比較大
    const a = (await call(app, 'case_submit_new', users.p04.session, DA, sales(2403), bot(), null)).case_id;
    const b = (await call(app, 'case_submit_new', users.p04.session, DA, sales(2404), bot(), null)).case_id;
    await admin.query(`update sgn.case_task set opened_at = opened_at - interval '3 days' where case_id = $1`, [b]);
    const inbox = (await call(app, 'inbox_list', users.p03.session)).map((c) => c.case_id);
    assert.ok(inbox.indexOf(b) >= 0 && inbox.indexOf(b) < inbox.indexOf(a), '等最久的在前');
    // 我的申請：有動作（撤回）的在前
    const mine = await call(app, 'case_list_mine', users.p04.session);
    const firstIdle = mine.findIndex((c) => c.actions.length === 0);
    if (firstIdle >= 0) assert.ok(mine.slice(firstIdle).every((c) => c.actions.length === 0));
    // 例外：同一規則、同一張單的三筆合成一組；結掉一筆後，那一筆在已結案那一組
    const caseNo = (await view(a)).case_no;
    const ids = [];
    for (let i = 0; i < 3; i += 1)
        ids.push((await one(admin, `select sgn_internal.exception_open('K-USAGE-IDLE', $1, '{}') as id`, [a])).id);
    await admin.query(`select sgn_internal.exception_close($1, '{"resolved": "test"}')`, [ids[0]]);
    const groups = await call(app, 'audit_exception_groups', users.p22.session);
    const open = groups.open.filter((g) => g.case_no === caseNo && g.rule_code === 'K-USAGE-IDLE');
    const closed = groups.closed.filter((g) => g.case_no === caseNo && g.rule_code === 'K-USAGE-IDLE');
    assert.deepEqual(
        open.map((g) => [g.count, g.process_type, g.last_closed_at]),
        [[2, DA, null]],
    );
    assert.equal(closed.length, 1);
    assert.equal(closed[0].count, 1);
    assert.ok(closed[0].last_closed_at);
    await rejectsWith(call(app, 'audit_exception_groups', users.p04.session), 'AUDITOR_REQUIRED');
});

test('K-REASON-AUDIENCE 原因會讓誰看到依操作者決定：申請人自己撤銷或縮小＝只記在紀錄（他也是被授權者負責人）；簽核人撤銷＝申請人與負責人；退回＝申請人；撤回＝紀錄', async () => {
    const caseId = await active(sales(2405));
    const own = await view(caseId);
    assert.deepEqual(own.reason_audience, { reduce: 'record', revoke: 'record' });
    const approver = await view(caseId, 'p03');
    assert.equal(approver.reason_audience.revoke, 'applicant_principal_owner');
    const pending = (await call(app, 'case_submit_new', users.p04.session, DA, sales(2406), bot(), null)).case_id;
    assert.deepEqual((await view(pending)).reason_audience, { recall: 'record' });
    const manager = await view(pending, 'p03');
    assert.deepEqual(manager.reason_audience, { reject: 'applicant', return: 'applicant' });
    // 通知對象與畫面的說明是同一個來源：撤銷時通知申請人（同時是負責人）一次
    await call(app, 'case_revoke', users.p03.session, caseId, '測試：簽核人撤銷');
    const sent = await admin.query(`select person_id from sgn.notification_outbox where case_id = $1 and event_code = 'case.revoked'`, [
        caseId,
    ]);
    assert.ok(sent.rows.length >= 1);
});

test('K-OVERLAP-SHOWN 重疊提示列出重疊的主題包與欄位名稱；對方的單號與期間只有能看那張單的人才有', async () => {
    const caseId = await active(sales(2407));
    const caseNo = (await view(caseId)).case_no;
    const mine = await draft(
        sales(2407, { scope: [{ package: 'sales_order', fields: ['amount', 'order_no', 'gross_margin'], row_filters: [] }] }),
    );
    assert.equal(mine.overlap.level, 'partial');
    const [item] = mine.overlap_shown.items.filter((i) => i.case_no === String(caseNo));
    assert.ok(item, JSON.stringify(mine.overlap_shown));
    assert.equal(item.packages[0].package_name, '銷售訂單');
    assert.deepEqual(item.packages[0].fields.map((f) => f.name).sort(), ['訂單金額', '訂單編號'].sort());
    assert.ok(item.valid_from);
    // 別人（不是那張單的經手人）替同一個被授權者試填：看得到重疊的欄位，看不到單號與期間
    const other = await draft(sales(2407), bot(), 'p05');
    const hidden = other.overlap_shown.items.find((i) => i.case_no === null);
    assert.ok(hidden, JSON.stringify(other.overlap_shown));
    assert.equal(hidden.valid_from, null);
    assert.ok(hidden.packages[0].fields.length > 0);
    assert.ok(!JSON.stringify(other.overlap_shown).includes(String(caseNo)));
});

// ── B ──

test('DA-EXPORT-SURVEY 要匯出時必填目的、頻率（進內容、版本雜湊與顯示摘要，瀏覽器與資料庫的要簽內容逐位元組一致）；方法是附屬的調查紀錄，不進內容、不簽', async () => {
    const empty = await draft(exporting(2410, {}));
    assert.deepEqual(
        empty.errors.map((e) => [e.path, e.code]),
        [
            ['export_survey.purpose', 'DA-E-EXPORT-SURVEY-REQUIRED'],
            ['export_survey.frequency', 'DA-E-EXPORT-SURVEY-REQUIRED'],
        ],
    );
    const unknown = await draft(exporting(2410, survey({ frequency: 'hourly' })));
    assert.deepEqual(codes(unknown.errors), ['DA-E-EXPORT-SURVEY-UNKNOWN']);
    const other = await draft(exporting(2410, survey({ purpose: 'other' })));
    assert.deepEqual(codes(other.errors), ['DA-E-EXPORT-SURVEY-DESCRIPTION']);
    // 方法不進內容：輸入帶了也被拿掉
    const d = await draft(exporting(2410, survey({ method: 'manual_download', description: '  季報  ' })));
    assert.deepEqual(d.errors, []);
    assert.deepEqual(d.content.export_survey, { purpose: 'offline_analysis', frequency: 'monthly', description: '季報' });
    assert.equal(d.content.export_allowed, true);
    assert.equal(d.version_sha256, await versionSha256(d.content, d.terms));
    assert.deepEqual(
        codes(d.notices).filter((c) => c.startsWith('DA-N-EXPORT')),
        ['DA-N-EXPORT-ALTERNATIVE'],
    );
    // 送審：方法沒有調查紀錄就不能送
    assert.deepEqual(await submitErrors(d.case_id), [['export_survey.method', 'DA-E-EXPORT-SURVEY-REQUIRED']]);
    await rejectsWith(recordMethod(d.case_id, 'manual_download', null, 'p05'), 'NOT_APPLICANT');
    await rejectsWith(recordMethod(d.case_id, 'carrier_pigeon'), 'DA-E-EXPORT-METHOD-UNKNOWN');
    await rejectsWith(recordMethod(d.case_id, 'other'), 'DA-E-EXPORT-METHOD-NOTE');
    assert.equal(
        shaped('data_access_export_method_latest', await call(app, 'data_access_export_method_latest', users.p04.session, d.case_id)),
        null,
    );
    const r = shaped('data_access_export_method_record', await recordMethod(d.case_id, 'manual_download'));
    const latest = shaped(
        'data_access_export_method_latest',
        await call(app, 'data_access_export_method_latest', users.p04.session, d.case_id),
    );
    assert.equal(latest.method, 'manual_download');
    await rejectsWith(call(app, 'data_access_export_method_latest', users.p05.session, d.case_id), 'CASE_UNKNOWN');
    assert.deepEqual(r, { method: { code: 'manual_download', name: '人工下載檔案' }, guidance: null, close_export: false });
    const [ev] = await events(d.case_id, 'data_access.export_method_recorded');
    assert.equal(ev.method, 'manual_download');
    await rejectsWith(
        admin.query(`update pack_data_access.export_method_record set method_code = 'other' where case_id = $1`, [d.case_id]),
        'DA-E-SURVEY-APPEND-ONLY',
    );
    const before = (await view(d.case_id)).version_sha256;
    const submitted = await call(app, 'case_submit', users.p04.session, d.case_id, OVERLAP_REASON);
    assert.equal(submitted.version_sha256, before, '記錄方法不產生新的內容版本');
    const shown = await view(d.case_id, 'p03');
    assert.equal(shown.display.content.export_survey.text, '匯出需求調查：目的「離線分析（Excel、統計軟體）」、頻率「每月」（說明：季報）');
    assert.equal(shown.display.content.export_survey.method, undefined, '方法不在顯示摘要');
    assert.ok(!JSON.stringify(shown.display).includes('manual_download'));
    await decide(app, users.p03, d.case_id);
    const [approve] = await events(d.case_id, 'case.approve');
    assert.deepEqual(approve.signed.content, await decisionContent(shown.display, 'approve', {}));
    assert.ok(!JSON.stringify(approve.signed.content).includes('人工下載'));
    // 調查改了（仍要匯出）算擴大；改成不匯出算縮小
    const k = async (a, b) => (await one(admin, 'select pack_data_access.compare_surveyed($1, $2) as k', [a, b])).k;
    assert.equal(await k(d.content, { ...d.content, export_survey: { ...d.content.export_survey, frequency: 'daily' } }), 'expand');
    assert.equal(await k(d.content, { ...d.content, export_allowed: false }), 'reduce');
});

test('DA-EXPORT-SURVEY 舊單（升版前、沒有環境與調查的內容）要匯出也不重算、照樣能送審與簽', async () => {
    const current = (
        await one(admin, `select split_part(hooks ->> 'normalize_content', '(', 1) as f from sgn.process_type where code = 'data_access'`)
    ).f;
    await admin.query(`select sgn_sdk.register_hook('data_access', 'normalize_content', 'pack_data_access.normalize_capable')`);
    let caseId;
    try {
        caseId = (
            await call(
                app,
                'case_submit_new',
                users.p04.session,
                DA,
                { ...salesOrderContent(2411), export_allowed: true },
                bot(),
                OVERLAP_REASON,
            )
        ).case_id;
    } finally {
        await admin.query(`select sgn_sdk.register_hook('data_access', 'normalize_content', $1)`, [current]);
    }
    const v = await view(caseId, 'p03');
    assert.equal(v.content.export_allowed, true);
    assert.equal(v.content.export_survey, undefined);
    assert.equal(v.display.content.export_survey, undefined);
    assert.equal(v.version_sha256, await versionSha256(v.content, v.terms));
    await decide(app, users.p03, caseId);
    const [approve] = await events(caseId, 'case.approve');
    assert.deepEqual(approve.signed.content, await decisionContent(v.display, 'approve', {}));
});

test('DA-EXPORT-SURVEY-GUIDE 目的是匯入另一個系統：關閉匯出並提示（參數 warn 時只提示）；方法是介面串接：依調查紀錄回傳要關閉匯出、送審時擋下；可以在系統內完成的目的提示替代做法', async () => {
    const feed = await draft(exporting(2412, survey({ purpose: 'system_feed' })));
    assert.equal(feed.content.export_allowed, false);
    assert.ok(codes(feed.notices).includes('DA-N-EXPORT-REDIRECT-BLOCKED'));
    assert.equal(feed.content.export_survey.purpose, 'system_feed', '調查照樣留下（之後收斂需求用）');
    assert.deepEqual(feed.errors, []);
    await setSetting(admin, 'data_access.export_redirect_action', 'warn', 'tier:data_access:L3');
    try {
        const warned = await draft(exporting(2413, survey({ purpose: 'system_feed' })));
        assert.equal(warned.content.export_allowed, true);
        assert.ok(codes(warned.notices).includes('DA-N-EXPORT-REDIRECT'));
    } finally {
        await setSetting(admin, 'data_access.export_redirect_action', 'block', 'tier:data_access:L3');
    }
    const slides = await draft(exporting(2414, survey({ purpose: 'report_slides' })));
    assert.ok(slides.notices.some((n) => n.code === 'DA-N-EXPORT-ALTERNATIVE' && n.message.includes('彙總與圖表')));
    assert.equal(slides.content.export_allowed, true);
    // 方法：判斷依據是調查紀錄（簽的內容裡沒有方法）
    const r = await recordMethod(slides.case_id, 'system_integration');
    assert.equal(r.close_export, true);
    assert.equal(r.guidance.kind, 'redirect');
    assert.deepEqual(await submitErrors(slides.case_id), [['export_survey.method', 'DA-E-EXPORT-METHOD-REDIRECT']]);
    // 畫面依 close_export 把匯出取消之後就能送；方法照樣記著
    const closed = await call(
        app,
        'case_revise',
        users.p04.session,
        slides.case_id,
        { ...exporting(2414, survey({ purpose: 'report_slides' })), export_allowed: false },
        bot(),
    );
    assert.equal(closed.content.export_allowed, false);
    assert.equal((await call(app, 'case_submit', users.p04.session, slides.case_id, OVERLAP_REASON)).state, 'in_approval');
    const catalog = shaped('data_access_catalog', await call(app, 'data_access_catalog', users.p04.session));
    assert.equal(catalog.export_survey.purposes.find((p) => p.code === 'system_feed').guidance.kind, 'redirect');
    assert.equal(catalog.export_survey.purposes.find((p) => p.code === 'report_slides').guidance.kind, 'alternative');
    assert.equal(catalog.export_survey.methods.find((m) => m.code === 'system_integration').guidance.kind, 'redirect');
    assert.deepEqual(
        catalog.export_survey.frequencies.map((f) => f.code),
        ['one_time', 'monthly', 'weekly', 'daily', 'continuous'],
    );
});

test('DA-EXPORT-SURVEY-RULES 交給使用方系統的規則不因調查而異：只有可否匯出', async () => {
    const withSurvey = await draft(exporting(2415, survey({ purpose: 'legal_hold', frequency: 'one_time' })));
    await recordMethod(withSurvey.case_id, 'scheduled_file');
    const plain = await draft(sales(2415, { export_allowed: true, export_survey: survey() }));
    const payload = async (id) => (await one(admin, 'select pack_data_access.build_fulfilment($1) as p', [id])).p;
    const a = await payload(withSurvey.case_id);
    const b = await payload(plain.case_id);
    assert.equal(a.export, true);
    const strip = (p) => ({ ...p, case_no: null, rules: p.rules.map((x) => ({ ...x, rule_id: null })) });
    assert.deepEqual(strip(a), strip(b));
    for (const word of ['survey', 'purpose', 'frequency', 'method', 'legal_hold', 'scheduled_file'])
        assert.ok(!JSON.stringify(a).includes(word), word);
});

test('DA-EXPORT-SURVEY-SUMMARY 稽核與 MIS 看得到依目的、頻率、方法的彙總（送審過的單；方法取調查紀錄）；其他人不行', async () => {
    const summary = shaped('data_access_export_survey_summary', await call(app, 'data_access_export_survey_summary', users.p22.session));
    assert.ok(summary.total >= 2);
    const purpose = Object.fromEntries(summary.by_purpose.map((x) => [x.code, x]));
    assert.ok(purpose.offline_analysis.cases >= 1);
    assert.ok(purpose.offline_analysis.exported >= 1);
    const method = Object.fromEntries(summary.by_method.map((x) => [x.code, x]));
    assert.ok(method.manual_download.cases >= 1);
    assert.ok(method.system_integration.cases >= 1, '方法是介面串接、匯出已關閉的單也算（調查紀錄）');
    assert.equal(method.system_integration.exported, 0);
    assert.deepEqual(
        summary.by_frequency.map((x) => x.code),
        ['one_time', 'monthly', 'weekly', 'daily', 'continuous'],
    );
    const mis = await call(app, 'data_access_export_survey_summary', users.p17.session);
    assert.equal(mis.total, summary.total);
    assert.ok((await call(app, 'me', users.p17.session)).capabilities.includes('report'));
    await rejectsWith(call(app, 'data_access_export_survey_summary', users.p04.session), 'AUDITOR_REQUIRED');
});
