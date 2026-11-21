// 端對端：核准之後的系統對系統交付（裁決 D63），對著真的 sim/dc（把規則套用成真正資料庫權限的 DC 模擬器）。
// 申請 → 各關核准（畫面、通行金鑰）→ 交付程式（api/src/delivery.ts，背景每秒一輪）自動套用 → 自動驗證 → 申請人確認（K-CONFIRM）
// → 生效，沒有人工執行；撤銷 → 外部系統裡的權限消失；後門多給權限 → 對帳（api/src/reconciler.ts）開例外；外部系統停掉 → 重送，
// 恢復後送達；交付內容被竄改 → 外部系統拒絕、平台開例外；逾期沒確認 → 自動撤銷、權限消失；回報不對 → 撤回；生效後在畫面上縮小。
// 前提：tools/run-all.sh 啟動的後端、頁面、交付程式（.run/delivery.pid）、sim/dc（db/build.sh 啟動並信任這個資料庫的公鑰）。
// 排在 path.test.mjs 之後（檔名排序）：那個檔案把資料中心設定為人工（測人工退路），這裡設回系統對系統。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { dcHttpDelivery } from '../../api/src/dcHttp.ts';
import { pool as dbPool, setSetting } from '../../db/tests/kernel/lib/harness.mjs';
import { REPO_DIR, RUN_DIR, loadConfig, roleUrl } from '../../db/tools/lib/env.mjs';
import {
    ORIGIN,
    apply,
    callApi,
    caseByNo,
    day,
    decide,
    home,
    layoutProblems,
    loggedIn,
    signer,
    startBrowser,
    stopBrowser,
} from './lib/ui.mjs';

const config = loadConfig();
const admin = dbPool('ADMIN');
const dcBase = `http://${config.dc.SIM_DC_HOST}:${config.dc.SIM_DC_PORT}/v1`;
const dcAdmin = { authorization: `Bearer ${config.dc.SIM_DC_KEY_ADMIN}`, 'content-type': 'application/json' };
const deliveryPid = () => Number(readFileSync(join(RUN_DIR, 'delivery.pid'), 'utf8'));
const env = { ...process.env, SGN_DATABASE: config.database };

before(async () => {
    await startBrowser();
    await setSetting(admin, 'delivery.mode', 'system', 'system:dc');
    await setSetting(admin, 'delivery.retry_base_seconds', 1, 'channel:dc');
    await setSetting(admin, 'delivery.retry_max_seconds', 3, 'channel:dc');
    await setSetting(admin, 'delivery.stuck_alert_seconds', 3600, 'channel:dc');
});
after(stopBrowser);

/** 林怡君替自己負責的 sales-report-bot 申請銷售訂單（北區）；每個測試用不同的資料期間年份，彼此不重疊。 */
const spec = (year) => ({
    principal: 'sales-report-bot',
    from: day(),
    to: day(2),
    packages: { sales_order: { fields: ['order_no', 'amount', 'order_date'], filters: { region: ['north'] } } },
    period: { from: `${year}-01-01`, to: `${year}-12-31` },
    purpose: 'reporting',
    description: `交付端對端 ${year}`,
});

/** 主管、資料擁有者、資安合規檢查（認領）都在畫面上用通行金鑰核准。 */
async function approve(uid, caseNo) {
    await signer(uid);
    await decide(uid, caseNo);
}
async function approveAll(caseNo) {
    await approve('p03', caseNo);
    await approve('p11', caseNo);
    await approve('p18', caseNo);
}

async function waitCase(p, caseNo, until, label, ms = 60000) {
    let c;
    for (const started = performance.now(); performance.now() - started < ms; ) {
        c = await caseByNo(p, caseNo);
        if (until(c)) return c;
        await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(
        `${label}：等不到（state=${c?.state}，ops=${JSON.stringify(c?.delivery.ops.map((o) => [o.kind, o.status, o.attempts]))}）`,
    );
}

async function dcQuery(principalId, query) {
    const res = await fetch(`${dcBase}/test-query`, {
        method: 'POST',
        headers: dcAdmin,
        body: JSON.stringify({ principal_id: principalId, query, probe_missing_row: true }),
    });
    return (await res.json()).decision;
}
// 新申請畫面沒有改環境時是測試區（DA-ENV-FIELD）：查測試區那一份
const inScope = (year) => ({
    package: 'sales_order',
    fields: ['amount', 'order_date', 'order_no'],
    row: { region: 'north' },
    data_date: `${year}-03-01`,
    action: 'query',
    as_of: day(),
    environment: 'test',
});

let revokeCaseNo;

const pendingConfirmation = (x) => x.state === 'verifying' && x.confirmation?.status === 'pending';
/** 申請人確認驗證結果（K-CONFIRM）：不是這個測試要看的步驟時，直接打後端（同一個工作階段）。 */
async function confirmByApi(p, caseNo) {
    const c = await waitCase(p, caseNo, pendingConfirmation, '等申請人確認');
    const r = await callApi(p.page, '/api/case_confirm_verification', { case_id: c.case_id });
    assert.equal(r.result?.state, 'active', JSON.stringify(r));
    return r.result;
}

test('K-DELIVERY-AUTO K-CONFIRM 端對端（真的 sim/dc）：申請 → 各關核准 → 自動交付 → 自動驗證 → 申請人在手機上確認（T7 步數）→ 生效，全程沒有人工執行步驟；外部系統上範圍內查得到、範圍外查不到', async () => {
    const { caseNo } = await apply('p04', spec(2024));
    revokeCaseNo = caseNo;
    await approveAll(caseNo);
    const applicant = await loggedIn('p04');
    const waiting = await waitCase(applicant, caseNo, pendingConfirmation, '等申請人確認');
    assert.equal(waiting.grant, null, '確認前沒有授權');
    // 申請人：從首頁開始數步數（T7 上限 3）；第一個畫面就看到每項測試的結果與剩餘天數
    const steps = [];
    await home(applicant);
    await applicant.page.click(`[data-testid=confirm-item][data-case-no="${caseNo}"]`);
    steps.push('打開等你確認的單');
    await applicant.page.waitForSelector('[data-testid=confirmation][data-status=pending]');
    const shown = waiting.delivery.verifications.flatMap((r) => r.cases);
    assert.equal(await applicant.page.locator('[data-testid=confirmation-cases] li[data-match=true]').count(), shown.length);
    assert.match(await applicant.page.textContent('[data-testid=confirmation-due]'), /還有 5 個工作天/);
    for (const x of shown) assert.match(await applicant.page.textContent('[data-testid=confirmation-cases]'), new RegExp(x.description));
    const panelBox = await applicant.page.locator('[data-testid=confirmation-cases]').boundingBox();
    const barBox = await applicant.page.locator('[data-testid=action-bar]').boundingBox();
    assert.ok(panelBox.y + panelBox.height <= barBox.y, '結果不用捲動就看得到，確認按鈕固定在底部');
    assert.deepEqual(await layoutProblems(applicant.page, '確認驗證結果'), []);
    await applicant.page.click('[data-action=confirm_verification]');
    steps.push('結果正確，確認生效');
    assert.deepEqual(await layoutProblems(applicant.page, '確認面板'), []);
    await applicant.page.click('[data-testid=confirm-verification-submit]');
    steps.push('確認生效');
    await applicant.page.waitForSelector('#flash.ok:not([hidden])');
    assert.ok(steps.length <= 3, `步數 ${steps.length} 超過 T7 上限 3`);
    console.log(`T7 確認驗證結果：${steps.length} 步（${steps.join(' → ')}）`);
    const c = await waitCase(applicant, caseNo, (x) => x.state === 'active', '生效');
    assert.equal(c.confirmation.status, 'confirmed');
    assert.deepEqual(c.stages.find((s) => s.code === 'fulfil').tasks, [], '執行關沒有人工工作');
    assert.deepEqual(
        c.delivery.ops.map((o) => [o.kind, o.status]),
        [
            ['apply', 'done'],
            ['verify', 'done'],
        ],
    );
    assert.equal(c.delivery.verifications[0].status, 'passed');
    assert.ok(c.delivery.verifications[0].cases.every((x) => x.match === true));
    const events = await admin.query('select event_type from sgn.audit_event where case_id = $1 order by seq', [c.case_id]);
    assert.ok(!events.rows.some((r) => r.event_type === 'case.fulfil'), '沒有人標記已套用');
    // 畫面：申請單詳情顯示交付與驗證的進度與結果（390px），沒有「標記已套用」
    await applicant.page.goto(`${ORIGIN}/#case/${c.case_id}`);
    await applicant.page.reload();
    await applicant.page.waitForSelector('[data-testid=delivery]');
    assert.equal(await applicant.page.getAttribute('[data-testid=verification]', 'data-status'), 'passed');
    assert.equal(
        await applicant.page.locator('[data-testid=verification] li[data-match=true]').count(),
        c.delivery.verifications[0].cases.length,
    );
    assert.equal(await applicant.page.locator('[data-action=fulfil]').count(), 0);
    assert.deepEqual(await layoutProblems(applicant.page, '交付與驗證'), []);
    // 系統管理人（李志偉，dc 的管理人）的待執行清單裡沒有這張單
    const custodian = await loggedIn('p17');
    await home(custodian);
    assert.equal(await custodian.page.locator(`[data-testid=fulfil-item][data-case-no="${caseNo}"]`).count(), 0);
    // 外部系統上是真的權限
    const principalId = c.terms.principal.principal_id;
    assert.equal(await dcQuery(principalId, inScope(2024)), 'allow');
    assert.equal(await dcQuery(principalId, { ...inScope(2024), row: { region: 'south' } }), 'deny');
    assert.equal(await dcQuery(principalId, { ...inScope(2024), fields: ['gross_margin'] }), 'deny');
});

test('K-GRANT-REVOKE 端對端：申請人在畫面上撤銷（不用簽核，要原因）→ 平台自動撤回 → 外部系統裡的權限消失', async () => {
    const applicant = await loggedIn('p04');
    const c = await caseByNo(applicant, revokeCaseNo);
    await applicant.page.goto(`${ORIGIN}/#case/${c.case_id}`);
    await applicant.page.reload();
    await applicant.page.click('[data-action=revoke]');
    assert.deepEqual(await layoutProblems(applicant.page, '撤銷'), []);
    await applicant.page.fill('[data-testid=revoke-reason]', '報表改用別的資料來源');
    await applicant.page.click('[data-testid=revoke-submit]');
    await applicant.page.waitForSelector('#flash.ok:not([hidden])');
    const done = await waitCase(
        applicant,
        revokeCaseNo,
        (x) => x.delivery.ops.at(-1).kind === 'withdraw' && x.delivery.ops.at(-1).status === 'done',
        '撤回',
    );
    assert.equal(done.state, 'revoked');
    assert.equal(await dcQuery(c.terms.principal.principal_id, inScope(2024)), 'deny');
    const rules = await fetch(`${dcBase}/rule-sets/${revokeCaseNo}`, { headers: dcAdmin });
    assert.equal((await rules.json()).status, 'withdrawn');
});

test('K-RECON-EXTRA 端對端：用 sim/dc 的後門多給一個欄位 → 對帳程式（獨立帳號、唯讀金鑰）拉回報 → 開例外，稽核的例外清單看得到', async () => {
    const { caseNo } = await apply('p04', spec(2025));
    await approveAll(caseNo);
    const applicant = await loggedIn('p04');
    const c = await confirmByApi(applicant, caseNo);
    const res = await fetch(`${dcBase}/admin/grant_column`, {
        method: 'POST',
        headers: dcAdmin,
        body: JSON.stringify({
            principal_id: c.terms.principal.principal_id,
            package: 'sales_order',
            field: 'gross_margin',
            action: 'read',
        }),
    });
    assert.equal(res.status, 200);
    execFileSync('node', [join(REPO_DIR, 'api/src/reconciler.ts')], { env, stdio: 'pipe' });
    const ex = await admin.query(`select rule_code, detail from sgn.exception_record where case_id = $1 and rule_code like 'K-RECON-%'`, [
        c.case_id,
    ]);
    assert.deepEqual(
        ex.rows.map((r) => [r.rule_code, r.detail.observed.resource]),
        [['K-RECON-EXTRA', 'sales_order.gross_margin']],
    );
    const auditor = await loggedIn('p22');
    await home(auditor);
    const item = auditor.page.locator(`[data-testid=audit-exceptions] li[data-rule=K-RECON-EXTRA]`, { hasText: String(caseNo) });
    assert.equal(await item.count(), 1);
    assert.match(await item.textContent(), /外部系統上有平台沒有核准的權限/);
    assert.deepEqual(await layoutProblems(auditor.page, '例外清單'), []);
});

test('K-DELIVERY-RETRY 端對端：外部系統停掉 → 交付以退避重送（畫面看得到下次重送）；外部系統恢復後送達、驗證、生效', async () => {
    const { caseNo } = await apply('p04', spec(2026));
    await approve('p03', caseNo);
    await approve('p11', caseNo);
    execFileSync(join(REPO_DIR, 'sim/dc/stop.sh'), { stdio: 'pipe' });
    try {
        await approve('p18', caseNo);
        const applicant = await loggedIn('p04');
        const c = await waitCase(applicant, caseNo, (x) => x.delivery.ops[0]?.attempts >= 2, '重送');
        assert.equal(c.state, 'pending_fulfilment');
        assert.equal(c.delivery.ops[0].status === 'queued' || c.delivery.ops[0].status === 'sending', true);
        assert.equal(c.delivery.ops[0].last_http_status, null);
        assert.ok(c.delivery.ops[0].last_error);
        await applicant.page.goto(`${ORIGIN}/#case/${c.case_id}`);
        await applicant.page.reload();
        await applicant.page.waitForSelector('[data-testid=delivery] li[data-kind=apply]');
        assert.match(await applicant.page.textContent('[data-testid=progress]'), /系統自動送到外部系統中/);
    } finally {
        execFileSync(join(REPO_DIR, 'sim/dc/start.sh'), { stdio: 'pipe' });
    }
    const applicant = await loggedIn('p04');
    const c = await confirmByApi(applicant, caseNo);
    assert.ok(c.delivery.ops[0].attempts >= 2);
    assert.equal(await dcQuery(c.terms.principal.principal_id, inScope(2026)), 'allow');
});

test('K-DELIVERY-REJECTED 端對端：被拿走的交付程式竄改交付內容（擴大列條件）→ 外部系統以簽章拒絕，平台開例外、不生效', async () => {
    const pid = deliveryPid();
    process.kill(pid, 'SIGSTOP');
    const compromised = new pg.Pool({ connectionString: roleUrl(config, 'DELIVERY'), max: 1 });
    let caseNo;
    try {
        ({ caseNo } = await apply('p04', spec(2027)));
        await approveAll(caseNo);
        const claimed = (await compromised.query(`select api_delivery.delivery_claim('dc', 10) as r`)).rows[0].r;
        const item = claimed.find((x) => x.case_no === String(caseNo));
        const tampered = { ...item, body: item.body.replace('"values": ["north"]', '"values": ["north", "south"]') };
        assert.notEqual(tampered.body, item.body);
        const outcome = await dcHttpDelivery({ base: dcBase, key: config.dc.SIM_DC_KEY_PLATFORM, timeoutMs: 10000 }).send(tampered);
        assert.equal(outcome.http_status, 401);
        await compromised.query('select api_delivery.delivery_report($1, $2, $3)', [item.op_id, item.lease_token, outcome]);
    } finally {
        process.kill(pid, 'SIGCONT');
        await compromised.end();
    }
    const applicant = await loggedIn('p04');
    const c = await waitCase(
        applicant,
        caseNo,
        (x) => x.state === 'fulfilment_failed' && x.delivery.ops.at(-1).status === 'done',
        '拒絕之後撤回',
    );
    assert.ok(c.exceptions.some((x) => x.rule_code === 'K-DELIVERY-REJECTED'));
    assert.equal((await fetch(`${dcBase}/rule-sets/${caseNo}`, { headers: dcAdmin })).status, 404, '外部系統沒有套用竄改的規則');
    await applicant.page.goto(`${ORIGIN}/#case/${c.case_id}`);
    await applicant.page.reload();
    await applicant.page.waitForSelector('[data-testid=delivery] li[data-kind=apply][data-status=rejected]');
    assert.match(await applicant.page.textContent('[data-testid=case-exceptions]'), /外部系統拒絕了交付/);
    assert.equal(await applicant.page.getAttribute('[data-testid=state]', 'data-state'), 'fulfilment_failed');
});

/** 讀稽核事件（管理者連線，不是測試的步驟）。 */
const caseEvent = async (caseId, type) =>
    (
        await admin.query(
            `select convert_from(body, 'UTF8')::jsonb -> 'data' as data from sgn.audit_event where case_id = $1 and event_type = $2`,
            [caseId, type],
        )
    ).rows[0]?.data;

test('K-CONFIRM-TIMEOUT 端對端：等確認的期間外部系統上已經查得到；逾期沒確認 → 系統自動撤銷 → 外部系統上的權限消失，事件寫明規則與參數值', async () => {
    const { caseNo } = await apply('p04', spec(2028));
    await approveAll(caseNo);
    const applicant = await loggedIn('p04');
    const c = await waitCase(applicant, caseNo, pendingConfirmation, '等申請人確認');
    const principalId = c.terms.principal.principal_id;
    assert.equal(await dcQuery(principalId, inScope(2028)), 'allow', '自動驗證要對真的權限查：等確認時規則已在外部系統上');
    // 模擬時間過去（資料庫擁有者，不是攻擊步驟）：確認期限改到現在之前；排程或交付程式（背景每秒）自動撤銷
    await admin.query(`update sgn.case_confirmation set due_at = clock_timestamp() - interval '1 second' where case_id = $1`, [c.case_id]);
    const done = await waitCase(
        applicant,
        caseNo,
        (x) => x.state === 'revoked' && x.delivery.ops.at(-1).kind === 'withdraw' && x.delivery.ops.at(-1).status === 'done',
        '逾期撤銷並撤回',
    );
    assert.equal(done.confirmation.status, 'expired');
    assert.equal(done.grant, null);
    assert.equal(await dcQuery(principalId, inScope(2028)), 'deny');
    assert.equal((await (await fetch(`${dcBase}/rule-sets/${caseNo}`, { headers: dcAdmin })).json()).status, 'withdrawn');
    const ev = await caseEvent(c.case_id, 'case.confirmation_expired');
    assert.deepEqual(ev.rules, ['K-CONFIRM-TIMEOUT', 'K-DELIVERY-AUTO']);
    assert.deepEqual(ev.settings, { 'confirmation.due_workdays': 5 });
    await applicant.page.goto(`${ORIGIN}/#case/${c.case_id}`);
    await applicant.page.reload();
    await applicant.page.waitForSelector('[data-testid=confirmation][data-status=expired]');
    assert.equal(await applicant.page.locator('[data-action=confirm_verification]').count(), 0);
});

test('K-CONFIRM-DISPUTE 端對端：申請人在畫面上按「結果不對」並寫原因 → 不生效、自動撤回 → 外部系統上的權限消失；例外看得到', async () => {
    const { caseNo } = await apply('p04', spec(2029));
    await approveAll(caseNo);
    const applicant = await loggedIn('p04');
    const c = await waitCase(applicant, caseNo, pendingConfirmation, '等申請人確認');
    await applicant.page.goto(`${ORIGIN}/#case/${c.case_id}`);
    await applicant.page.reload();
    await applicant.page.click('[data-action=dispute_verification]');
    assert.deepEqual(await layoutProblems(applicant.page, '結果不對'), []);
    await applicant.page.fill('[data-testid=dispute-reason]', '查得到的欄位比我要的多');
    await applicant.page.click('[data-testid=dispute-submit]');
    await applicant.page.waitForSelector('#flash.ok:not([hidden])');
    const done = await waitCase(
        applicant,
        caseNo,
        (x) => x.state === 'fulfilment_failed' && x.delivery.ops.at(-1).kind === 'withdraw' && x.delivery.ops.at(-1).status === 'done',
        '回報不對之後撤回',
    );
    assert.equal(done.grant, null);
    assert.ok(done.exceptions.some((x) => x.rule_code === 'K-CONFIRM-DISPUTE'));
    assert.equal(await dcQuery(c.terms.principal.principal_id, inScope(2029)), 'deny');
    await applicant.page.reload();
    await applicant.page.waitForSelector('[data-testid=case-exceptions]');
    assert.match(await applicant.page.textContent('[data-testid=case-exceptions]'), /申請人回報外部系統上的實際權限和申請的不一樣/);
    assert.match(await applicant.page.textContent('[data-testid=confirmation]'), /查得到的欄位比我要的多/);
});

test('K-GRANT-REDUCE 端對端：申請人在詳情頁縮小（拿掉一個欄位，不用簽核）→ 新的一版自動送出並重新驗證 → 外部系統上那個欄位查不到；擴大被資料庫擋下', async () => {
    const { caseNo } = await apply('p04', spec(2030));
    await approveAll(caseNo);
    const applicant = await loggedIn('p04');
    const c = await confirmByApi(applicant, caseNo);
    const principalId = c.terms.principal.principal_id;
    assert.equal(await dcQuery(principalId, { ...inScope(2030), fields: ['amount'] }), 'allow');
    await applicant.page.goto(`${ORIGIN}/#case/${c.case_id}`);
    await applicant.page.reload();
    await applicant.page.click('[data-action=reduce]');
    await applicant.page.waitForSelector('[data-testid=r-editor] fieldset.package[data-package=sales_order]');
    assert.deepEqual(await layoutProblems(applicant.page, '縮小'), []);
    await applicant.page.locator('label[for=r-sales_order-f-amount]').click();
    await applicant.page.fill('[data-testid=reduce-reason]', '報表不再需要金額');
    await applicant.page.click('[data-testid=reduce-active-submit]');
    await applicant.page.waitForSelector('#flash.ok:not([hidden])');
    const done = await waitCase(
        applicant,
        caseNo,
        (x) => x.version === 2 && x.delivery.verifications.some((r) => r.version === 2 && r.status === 'passed'),
        '縮小後重新驗證',
    );
    assert.equal(done.state, 'active');
    assert.equal(done.versions.at(-1).change_kind, 'reduce');
    assert.deepEqual(done.content.scope[0].fields.map((f) => f.code).toSorted(), ['order_date', 'order_no']);
    assert.equal(await dcQuery(principalId, { ...inScope(2030), fields: ['amount'] }), 'deny');
    assert.equal(await dcQuery(principalId, { ...inScope(2030), fields: ['order_no'] }), 'allow');
    // 繞過畫面「縮小」時加回欄位：資料庫判斷這不是縮小
    const expand = await callApi(applicant.page, '/api/case_reduce', {
        case_id: c.case_id,
        content: { ...done.content, scope: [{ ...done.content.scope[0], fields: ['amount', 'gross_margin', 'order_date', 'order_no'] }] },
        terms: null,
        reason: '多要',
    });
    assert.equal(expand.error?.code, 'CHANGE_NOT_REDUCE', JSON.stringify(expand));
});
