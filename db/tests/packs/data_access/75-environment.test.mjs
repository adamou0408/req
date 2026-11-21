// 測試區與正式區（裁決 D93；db/packs/data_access/150_environment.sql、db/kernel/550_submission_review.sql、555_usage_detail.sql；
// 威脅表 docs/handoff/closed-loop-2.md）。環境是申請內容的必填欄位、級別逐欄逐區、交付與驗證帶區、重疊只比同一區、
// 正式區要引用測試區的單或填理由、期限上限依環境、使用摘要分區並到欄位層級。
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { decisionContent, versionSha256 } from '../../../../web/lib/signing.js';
import { deliverChannel } from '../../../../api/src/delivery.ts';
import { call, closePools, login, one, pool, registerPasskey, rejectsWith } from '../../kernel/lib/harness.mjs';
import { CHANNEL, deliveryPool, drain, mockDc, ops, salesOrderContent, systemDelivery } from './delivery-lib.mjs';
import { addMonths, application, DA, decide, principals, today } from './lib.mjs';

const app = pool('APP');
const admin = pool('ADMIN');
const reconciler = pool('RECONCILER');
const delivery = deliveryPool();
const users = {};
let P;
let dc;

before(async () => {
    for (const uid of ['p03', 'p04', 'p05', 'p09', 'p11', 'p17']) {
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
const bot = (days = 60) => ({ principal_id: P['sales-report-bot'], valid_from: today(), valid_to: today(days) });
const sales = (year, environment, extra = {}) => ({
    ...salesOrderContent(year),
    environment,
    ...(environment === 'prod' ? { application: application() } : {}),
    ...extra,
});
const prodSales = (year, extra = {}) => sales(year, 'prod', { test_exception: { reason: '新系統上線，測試區沒有這張表' }, ...extra });
const submitted = async (content, t = bot(), who = 'p04') =>
    (await call(app, 'case_submit_new', users[who].session, DA, content, t, null)).case_id;
const draft = (content, t = bot()) => call(app, 'case_create', users.p04.session, DA, content, t);
const codes = (list) => list.map((x) => x.code);
const exceptions = async (caseId) =>
    (await admin.query('select rule_code, detail, closed_at from sgn.exception_record where case_id = $1 order by id', [caseId])).rows;
const events = async (caseId, type) =>
    (
        await admin.query(
            `select convert_from(body, 'UTF8')::jsonb -> 'data' as data from sgn.audit_event where case_id = $1 and event_type = $2 order by seq`,
            [caseId, type],
        )
    ).rows.map((r) => r.data);
async function signThrough(caseId) {
    await decide(app, users.p03, caseId);
    await decide(app, users.p11, caseId);
    await call(app, 'task_claim', users.p17.session, caseId);
    await decide(app, users.p17, caseId);
}
async function active(content, t = bot()) {
    const caseId = await submitted(content, t);
    await signThrough(caseId);
    await drain(delivery, dc);
    await call(app, 'case_confirm_verification', users.p04.session, caseId);
    assert.equal((await view(caseId)).state, 'active');
    return caseId;
}
/** 送審複核的錯誤代碼（CONTENT_INVALID 的 detail 是錯誤清單）。 */
async function submitErrors(caseId) {
    try {
        await call(app, 'case_submit', users.p04.session, caseId, null);
    } catch (err) {
        assert.ok(String(err.message).startsWith('CONTENT_INVALID:'), err.message);
        return JSON.parse(err.detail).map((e) => [e.path, e.code]);
    }
    return [];
}

test('DA-ENV-FIELD 環境是申請內容的鍵（代碼表的值），進版本雜湊與顯示摘要；瀏覽器與資料庫算出相同的要簽內容；沒有指定以測試區處理並提示；不認得的值不能送審', async () => {
    const env = (await admin.query(`select environment_code from pack_data_access.data_environment order by sort_order`)).rows;
    assert.deepEqual(
        env.map((r) => r.environment_code),
        ['test', 'prod'],
    );
    const caseId = await submitted(sales(2310, 'test'));
    const v = await view(caseId);
    assert.equal(v.content.environment, 'test');
    assert.equal(v.version_sha256, await versionSha256(v.content, v.terms));
    assert.deepEqual(v.display.content.environment, { code: 'test', name: '測試區', text: '環境：測試區' });
    const shown = await view(caseId, 'p03');
    await decide(app, users.p03, caseId);
    const [approve] = await events(caseId, 'case.approve');
    assert.deepEqual(approve.signed.content, await decisionContent(shown.display, 'approve', {}));
    const missing = await draft(salesOrderContent(2311));
    assert.equal(missing.content.environment, 'test');
    assert.ok(codes(missing.notices).includes('DA-N-ENVIRONMENT-DEFAULT'));
    const unknown = await draft(sales(2312, 'staging'));
    assert.deepEqual(
        unknown.errors.map((e) => [e.path, e.code]),
        [['environment', 'DA-E-ENVIRONMENT-UNKNOWN']],
    );
    await rejectsWith(call(app, 'case_submit', users.p04.session, unknown.case_id, null), 'CONTENT_INVALID');
    // 換環境一律算擴大（是另一份資料）
    const k = await one(admin, 'select pack_data_access.compare_environment($1, $2) as k', [
        v.content,
        { ...v.content, environment: 'prod' },
    ]);
    assert.equal(k.k, 'expand');
});

test('DA-ENV-FIELD 舊單（升版前、沒有環境鍵的內容）：雜湊不重算、顯示摘要不多環境這一行、視為正式區但不追加測試依據的規則，照樣可以送審與簽', async () => {
    const current = (
        await one(admin, `select split_part(hooks ->> 'normalize_content', '(', 1) as f from sgn.process_type where code = 'data_access'`)
    ).f;
    await admin.query(`select sgn_sdk.register_hook('data_access', 'normalize_content', 'pack_data_access.normalize_capable')`);
    let caseId;
    try {
        caseId = await submitted(salesOrderContent(2313));
    } finally {
        await admin.query(`select sgn_sdk.register_hook('data_access', 'normalize_content', $1)`, [current]);
    }
    const v = await view(caseId);
    assert.equal(v.content.environment, undefined);
    assert.equal(v.display.content.environment, undefined, '舊的顯示摘要不變');
    assert.equal(v.version_sha256, await versionSha256(v.content, v.terms));
    assert.equal((await one(admin, 'select pack_data_access.content_environment($1) as e', [v.content])).e, 'prod');
    // 系統整理過的舊內容（帶 catalog）再整理時仍是正式區（例如目錄改版重新綁定），不會被改到測試區
    const again = await one(admin, 'select pack_data_access.normalize_environment($1) as r', [v.content]);
    assert.equal(again.r.content.environment, 'prod');
    assert.equal((await one(admin, 'select pack_data_access.compare_environment($1, $2) as k', [v.content, again.r.content])).k, 'same');
    await signThrough(caseId);
    const [apply] = await ops(admin, caseId);
    assert.equal(JSON.parse(apply.body).environment, undefined, '舊單的規則不帶區（使用方視為正式區）');
    await drain(delivery, dc);
    assert.equal((await view(caseId)).state, 'verifying');
});

test('DA-ENV-TIER 級別由目錄逐欄、逐環境決定：測試區已遮罩的欄位降級並提示，正式區同一欄維持原分級；引用摘要只看這張單那一區的標示', async () => {
    const content = (environment) => ({
        environment,
        scope: [{ package: 'customer_master', fields: ['customer_id', 'contact_phone'], row_filters: [] }],
        data_period: null,
        purpose_category: 'reporting',
        purpose_description: '客戶聯絡',
        export_allowed: false,
        ...(environment === 'prod' ? { test_exception: { reason: '分級測試' }, application: application() } : {}),
    });
    const t = { principal_id: P['業務分析部'], valid_from: today(), valid_to: today(30) };
    const test_ = await draft(content('test'), t);
    assert.equal(test_.tier, 'L3');
    assert.deepEqual(test_.content.scope[0].fields, [
        { code: 'contact_phone', classification: 'L3' },
        { code: 'customer_id', classification: 'L3' },
    ]);
    assert.ok(test_.notices.some((n) => n.code === 'DA-N-ENV-DOWNGRADED' && n.message.includes('聯絡人電話')));
    const prod = await draft(content('prod'), t);
    assert.equal(prod.tier, 'L4');
    assert.ok(!codes(prod.notices).includes('DA-N-ENV-DOWNGRADED'));
    // 申請人不能自稱分級：輸入帶的 classification 不算數
    const claimed = await draft(
        { ...content('prod'), scope: [{ ...content('prod').scope[0], fields: [{ code: 'contact_phone', classification: 'L3' }] }] },
        t,
    );
    assert.equal(claimed.tier, 'L4');
    const ver = (await one(admin, `select (pack_data_access.catalog_current() ->> 'version_no')::int as v`)).v;
    const ref = async (c) =>
        (await one(admin, 'select pack_data_access.catalog_ref($1, $2) as r', [c, ver])).r.packages[0].fields.find(
            (f) => f.code === 'contact_phone',
        );
    assert.deepEqual((await ref(test_.content)).environments, [{ environment: 'test', treatment: 'masked', classification: 'L3' }]);
    assert.equal((await ref(prod.content)).environments, undefined, '正式區的單不受測試區標示影響');
});

test('DA-ENV-MISMATCH 交付的規則帶區；使用方系統回報套用到另一區（或沒有回報）：不生效、撤回已送出的部分、開例外', async () => {
    const caseId = await submitted(sales(2320, 'test'));
    await signThrough(caseId);
    const [apply] = await ops(admin, caseId);
    assert.equal(JSON.parse(apply.body).environment, 'test');
    const caseNo = String((await view(caseId)).case_no);
    // 使用方系統（被改過的）把測試區的規則套在正式區，並在已簽的結果裡照實說
    const lying = {
        ...dc,
        send: (item) =>
            item.kind === 'apply' && String(item.case_no) === caseNo
                ? Promise.resolve(dc.reply(item, 200, { status: 'applied', dc_ref: 'DC-x', environment: 'prod' }))
                : dc.send(item),
    };
    await deliverChannel(delivery, CHANNEL, lying);
    await drain(delivery, dc);
    const v = await view(caseId);
    assert.notEqual(v.state, 'verifying');
    assert.notEqual(v.state, 'active');
    const x = (await exceptions(caseId)).find((e) => e.rule_code === 'DA-ENV-MISMATCH');
    assert.ok(x, '開例外 DA-ENV-MISMATCH');
    assert.equal(x.detail.check.expected_environment, 'test');
    assert.equal(x.detail.check.reported_environment, 'prod');
    assert.ok(
        (await ops(admin, caseId)).some((o) => o.kind === 'withdraw'),
        '撤回已送出的部分',
    );
    // 沒有回報區也不接受
    const no = await one(admin, `select pack_data_access.check_delivery_zoned($1, $2) as r`, [
        caseId,
        { kind: 'apply', channel: CHANNEL, rule_set: { environment: 'test' }, result: { status: 'applied' } },
    ]);
    assert.equal(no.r.rule_code, 'DA-ENV-MISMATCH');
});

test('DA-ENV-VERIFY 驗證的每個查詢帶這張單的區；另加反例「同一份規則在另一區查不到」，外部系統（模擬）判定拒絕', async () => {
    const caseId = await active(sales(2321, 'test'));
    const [run] = (await view(caseId)).delivery.verifications;
    assert.equal(run.status, 'passed');
    const other = run.cases.find((c) => c.code === 'request:other_environment');
    assert.deepEqual([other.expected, other.actual], ['deny', 'deny']);
    assert.match(other.description, /另一區：正式區/);
    const stored = await one(admin, 'select cases from sgn.verification_run where id = $1', [run.run_id]);
    assert.ok(stored.cases.filter((c) => c.code !== 'request:other_environment').every((c) => c.query.environment === 'test'));
    assert.equal(stored.cases.find((c) => c.code === 'request:other_environment').query.environment, 'prod');
});

test('DA-ENV-OVERLAP 重疊與完全涵蓋只和同一區的有效授權比；對帳的限制條件帶區，回報在另一區就是範圍不同', async () => {
    const testCase = await active(sales(2322, 'test'));
    // 同一被授權者、同一份範圍：在測試區是完全涵蓋（擋下），在正式區沒有重疊
    const sameZone = await draft(sales(2322, 'test'));
    assert.equal(sameZone.overlap.level, 'covered');
    const otherZone = await draft(prodSales(2322));
    assert.equal(otherZone.overlap.level, 'none');
    const caseNo = String((await view(testCase)).case_no);
    const { rows } = await admin.query(
        `select item from sgn_internal.reconciliation_expected($1, 'data_access') where standing = 'expected'`,
        [CHANNEL],
    );
    const item = (x, environment) => ({
        item_key: `${x.subject}|${x.resource}|${x.action}|${x.rule_id}`,
        subject: { type: 'principal', id: x.subject, properties: { provider: 'sgn' } },
        resource: { type: 'data_field', id: x.resource },
        action: { name: x.action },
        entitlement_id: null,
        constraints: { row_filter: x.constraints.row_filter, data_period: x.constraints.data_period, environment },
        properties: { rule_id: x.rule_id, case_no: x.case_no, valid: x.valid },
    });
    assert.ok(rows.filter((r) => r.item.case_no === caseNo).every((r) => r.item.constraints.environment === 'test'));
    const items = rows.map((r) => item(r.item, r.item.case_no === caseNo ? 'prod' : r.item.constraints.environment));
    const report = { format: 'dc_reconciliation_report/1', observed_at: new Date().toISOString(), process_type: 'data_access', items };
    await one(reconciler, 'select api_job.reconciliation_submit($1, $2) as r', [CHANNEL, dc.reconciliation(report)]);
    const recon = (await exceptions(testCase)).map((e) => e.rule_code).filter((c) => c.startsWith('K-RECON'));
    assert.ok(recon.length > 0 && recon.every((c) => c === 'K-RECON-DIFFERENT'), JSON.stringify(recon));
});

test('DA-ENV-TEST-BASIS 正式區要引用一張涵蓋它的測試區單（同申請人或同被授權者、主題包與欄位涵蓋、列條件不比它窄、曾經生效）；沒有就不能送審', async () => {
    const basis = await active(sales(2330, 'test'));
    const basisNo = String((await view(basis)).case_no);
    const narrower = await active(sales(2331, 'test', { scope: [{ ...salesOrderContent(2331).scope[0], fields: ['amount'] }] }));
    const neverActive = await submitted(sales(2332, 'test'));
    const prodCase = await submitted(prodSales(2333));
    const none = await draft(sales(2334, 'prod'));
    assert.deepEqual(await submitErrors(none.case_id), [['test_basis', 'DA-E-TEST-BASIS-REQUIRED']]);
    const tryBasis = async (id, extra = {}) => {
        const d = await draft(sales(2334, 'prod', { test_basis: { case_id: id }, ...extra }));
        return { d, errors: await submitErrors(d.case_id) };
    };
    const problem = async (id) => {
        const d = await draft(sales(2334, 'prod', { test_basis: { case_id: id } }));
        const r = await one(admin, 'select pack_data_access.review_submission($1, $2) as r', [d.case_id, d.content]);
        return r.r.errors.map((e) => e.message);
    };
    assert.match((await problem(narrower))[0], /沒有涵蓋/);
    assert.match((await problem(neverActive))[0], /還沒有生效過/);
    assert.match((await problem(prodCase))[0], /不是測試區/);
    assert.match((await problem('00000000-0000-0000-0000-000000000000'))[0], /找不到/);
    // 別人申請、別的被授權者的測試區單不能引用
    const stranger = await one(admin, `select pack_data_access.test_basis_problem($1::jsonb, $2, $3) as p`, [
        { case_id: '00000000-0000-0000-0000-000000000001', applicant_id: users.p05.personId, principal: { principal_id: P['業務分析部'] } },
        sales(2330, 'prod'),
        basis,
    ]);
    assert.equal(stranger.p, 'DA-T-BASIS-UNRELATED');
    // 合格的依據：送審成功，顯示摘要寫出引用的單（簽核人簽的內容包含它），換依據算擴大
    const ok = await tryBasis(basis);
    assert.deepEqual(ok.errors, []);
    const v = await view(ok.d.case_id);
    assert.equal(v.state, 'in_approval');
    assert.deepEqual(v.content.test_basis, { case_id: basis, case_no: basisNo });
    assert.equal(v.display.content.test_basis.text, `測試依據：測試區單 ${basisNo}`);
    assert.equal(v.content.test_exception, null, '引用了單就不留理由');
    const k = await one(admin, 'select pack_data_access.compare_environment($1, $2) as k', [v.content, { ...v.content, test_basis: null }]);
    assert.equal(k.k, 'expand');
    // 可以引用的清單（新申請畫面）：看的人申請的或同一個被授權者的、曾經生效過的測試區單
    const list = await call(app, 'data_access_test_bases', users.p04.session, P['sales-report-bot']);
    assert.ok(list.some((b) => b.case_id === basis));
    assert.ok(!list.some((b) => b.case_id === neverActive || b.case_id === prodCase));
});

test('DA-TEST-EXCEPTION 正式區沒有測試紀錄：理由必填；送審後開例外帶理由（簽核人看得到），顯示摘要寫出理由；退回後重送不重開', async () => {
    const empty = await draft(sales(2340, 'prod', { test_exception: { reason: '   ' } }));
    assert.equal(empty.content.test_exception, null);
    assert.deepEqual(await submitErrors(empty.case_id), [['test_basis', 'DA-E-TEST-BASIS-REQUIRED']]);
    const caseId = await submitted(prodSales(2341));
    const [x] = (await exceptions(caseId)).filter((e) => e.rule_code === 'DA-TEST-EXCEPTION');
    assert.equal(x.detail.reason, '新系統上線，測試區沒有這張表');
    const shown = await view(caseId, 'p03');
    assert.ok(
        shown.exceptions.some((e) => e.rule_code === 'DA-TEST-EXCEPTION'),
        '簽核人看得到',
    );
    assert.equal(shown.display.content.test_exception.text, '沒有測試紀錄的理由：新系統上線，測試區沒有這張表');
    assert.equal(await decide(app, users.p03, caseId, 'return', { reason: '請補測試' }), 'returned');
    await call(app, 'case_submit', users.p04.session, caseId, null);
    assert.equal((await exceptions(caseId)).filter((e) => e.rule_code === 'DA-TEST-EXCEPTION').length, 1);
});

test('DA-ENV-VALIDITY 授權期間的上限依環境（參數，適用範圍 environment）：測試區 3 個月，正式區照級別', async () => {
    const value = async (env) =>
        (
            await one(
                admin,
                `select sgn_sdk.setting('data_access.environment_validity_max_months', array['environment:data_access:' || $1]) as v`,
                [env],
            )
        ).v;
    assert.equal(await value('test'), 3);
    assert.equal(await value('prod'), 12);
    const long = { principal_id: P['sales-report-bot'], valid_from: today(), valid_to: addMonths(today(), 3) };
    const t = await draft(sales(2350, 'test'), long);
    assert.deepEqual(await submitErrors(t.case_id), [['terms.valid_to', 'DA-E-ENV-VALIDITY']]);
    const p = await draft(prodSales(2351), long);
    assert.deepEqual(await submitErrors(p.case_id), []);
    const ok = await draft(sales(2352, 'test'), { ...long, valid_to: addMonths(today(), 3, -1) });
    assert.deepEqual(await submitErrors(ok.case_id), []);
});

test('K-SUBMIT-REVIEW 送審的那一刻由流程包複核：有錯就擋下（CONTENT_INVALID 帶錯誤清單）；複核用到的參數與要求的例外記進送審的稽核事件', async () => {
    const caseId = await submitted(prodSales(2360));
    const [ev] = await events(caseId, 'case.submitted');
    assert.ok(ev.rules.includes('K-SUBMIT-REVIEW'));
    assert.equal(ev.settings['data_access.environment_validity_max_months'], 12);
    assert.deepEqual(
        ev.review.exceptions.map((e) => e.rule_code),
        ['DA-TEST-EXCEPTION'],
    );
    const blocked = await draft(sales(2361, 'prod'));
    assert.deepEqual(await submitErrors(blocked.case_id), [['test_basis', 'DA-E-TEST-BASIS-REQUIRED']]);
    assert.equal((await view(blocked.case_id)).state, 'draft');
});

test('K-USAGE-DETAIL 使用摘要每一筆帶區、逐欄的次數與使用方系統的版本識別；區和平台送出的規則不同、逐欄的格式不對：整批不收', async () => {
    const caseId = await active(sales(2370, 'test'));
    const no = String((await view(caseId)).case_no);
    const HOUR = 3600000;
    const from = new Date(Math.floor((Date.now() - 2 * HOUR) / HOUR) * HOUR);
    const period = { from: from.toISOString(), to: new Date(from.getTime() + HOUR).toISOString() };
    const at = new Date(from.getTime() + 60000).toISOString();
    const item = (extra = {}) => ({
        case_no: no,
        actor: { provider: 'sim-ldap', external_id: 'p04' },
        period,
        queries: 2,
        exports: 0,
        blocked: 1,
        last_used_at: at,
        environment: 'test',
        fields: [
            { package: 'sales_order', field: 'amount', queries: 2, exports: 0, blocked: 0, last_used_at: at },
            { package: 'sales_order', field: 'gross_margin', queries: 0, exports: 0, blocked: 1, last_used_at: at },
        ],
        client_versions: ['report-a@1.2.0'],
        ...extra,
    });
    const batch = (items) => ({ format: 'usage_summary_batch/2', database: 'mock', period_seconds: 3600, items });
    const submit = async (items) =>
        (await one(reconciler, 'select api_job.usage_submit($1, $2) as r', [CHANNEL, dc.usage(batch(items))])).r;
    const wrongZone = await submit([item({ environment: 'prod' })]);
    assert.deepEqual([wrongZone.status, wrongZone.reason], ['rejected', 'item_invalid']);
    const badField = await submit([item({ fields: [{ package: 'sales_order', field: 'amount', queries: -1, exports: 0, blocked: 0 }] })]);
    assert.equal(badField.status, 'rejected');
    const badVersion = await submit([item({ client_versions: [''] })]);
    assert.equal(badVersion.status, 'rejected');
    assert.deepEqual([badField.reason, badVersion.reason], ['item_invalid', 'item_invalid']);
    const ok = await submit([item()]);
    assert.equal(ok.status, 'accepted');
    const u = (await one(admin, 'select sgn_sdk.case_usage_detail($1) as u', [caseId])).u;
    assert.equal(u.reported, true);
    assert.equal(u.items.length, 1);
    assert.equal(u.items[0].environment, 'test');
    assert.deepEqual(u.items[0].client_versions, ['report-a@1.2.0']);
    assert.deepEqual(
        u.items[0].fields.map((f) => [f.field, f.queries, f.blocked]),
        [
            ['amount', 2, 0],
            ['gross_margin', 0, 1],
        ],
    );
});
