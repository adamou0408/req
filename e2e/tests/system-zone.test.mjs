// 端對端：測試區與正式區、測試報告（裁決 D93、D94；docs/handoff/closed-loop-2.md），對著真的 sim/dc 與背景程式、手機寬度（390px）。
//   申請人先申請測試區（畫面預設）並生效，實際操作的人經 sim/dc 查詢；再申請正式區時從清單選這張測試區的單當依據、寫應用面
//   （新動作的步數）。簽核人在決定畫面上看到環境、測試依據與系統算出的測試報告（警示在最上面）。
//   沒有測試紀錄時選「沒有測試紀錄」並填理由；簽核人看到理由與例外；生效後申請人在首頁產生上線後的使用報告（步數）。
// 排在 system-loop.test.mjs 之後（檔名排序）；資料中心已是系統對系統。
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { pool as dbPool, setSetting } from '../../db/tests/kernel/lib/harness.mjs';
import { loadConfig } from '../../db/tools/lib/env.mjs';
import {
    apply,
    callApi,
    caseByNo,
    checkSettled,
    day,
    decide,
    fillApplication,
    home,
    layoutProblems,
    loggedIn,
    openNew,
    signer,
    startBrowser,
    stopBrowser,
    submitForm,
} from './lib/ui.mjs';

const admin = dbPool('ADMIN');
const config = loadConfig();
const dcBase = `http://${config.dc.SIM_DC_HOST}:${config.dc.SIM_DC_PORT}/v1`;
const dcAdmin = { authorization: `Bearer ${config.dc.SIM_DC_KEY_ADMIN}`, 'content-type': 'application/json' };
const app = { program: '月報', version: 'monthly@1.0.0', audience: '業務主管' };

before(async () => {
    await startBrowser();
    await setSetting(admin, 'delivery.mode', 'system', 'system:dc');
    await setSetting(admin, 'delivery.retry_base_seconds', 1, 'channel:dc');
});
after(stopBrowser);

const spec = (year, extra = {}) => ({
    principal: 'sales-report-bot',
    from: day(),
    to: day(2),
    packages: { sales_order: { fields: ['order_no', 'amount', 'order_date'], filters: { region: ['north'] } } },
    period: { from: `${year}-01-01`, to: `${year}-12-31` },
    purpose: 'reporting',
    description: `測試區與正式區 ${year}`,
    ...extra,
});

async function waitCase(p, caseNo, until, label, ms = 90000) {
    let c;
    for (const started = performance.now(); performance.now() - started < ms; ) {
        c = await caseByNo(p, caseNo);
        if (until(c)) return c;
        await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`${label}：等不到（state=${c?.state}）`);
}

/** 主管看到的決定畫面：環境、測試依據或理由。 */
async function decisionScreen(caseNo) {
    const manager = await loggedIn('p03');
    await home(manager);
    await manager.page.click(`[data-case-no="${caseNo}"]`);
    await manager.page.waitForSelector('[data-testid=environment-line]');
    return manager;
}

let basisCaseId;

test('DA-ENV-FIELD DA-ENV-VERIFY 端對端：新申請畫面預設測試區；sim/dc 套用在測試區（已簽的回應帶區），驗證含「另一區查不到」，生效', async () => {
    const { caseNo } = await apply('p04', spec(2041));
    for (const uid of ['p03', 'p11', 'p18']) {
        await signer(uid);
        await decide(uid, caseNo);
    }
    const applicant = await loggedIn('p04');
    const c = await waitCase(applicant, caseNo, (x) => x.state === 'verifying' && x.confirmation?.status === 'pending', '等申請人確認');
    assert.equal(c.content.environment, 'test');
    const applied = await admin.query(`select result from sgn.delivery_op where case_id = $1 and kind = 'apply' and status = 'done'`, [
        c.case_id,
    ]);
    assert.equal(applied.rows[0].result.environment, 'test', 'sim/dc 在已簽的結果裡回報套用到測試區');
    const [run] = c.delivery.verifications;
    assert.deepEqual(
        run.cases.filter((x) => x.code === 'request:other_environment').map((x) => [x.expected, x.actual]),
        [['deny', 'deny']],
    );
    assert.equal((await callApi(applicant.page, '/api/case_confirm_verification', { case_id: c.case_id })).result.state, 'active');
    // 實際操作的人經使用方系統在測試區查一次（帶程式的版本識別）；對帳程式拉回的摘要到欄位層級
    const r = await fetch(`${dcBase}/use`, {
        method: 'POST',
        headers: dcAdmin,
        body: JSON.stringify({
            principal_id: c.terms.principal.principal_id,
            actor: { provider: 'sim-ldap', external_id: 'p04' },
            client_version: 'monthly@1.0.0',
            query: {
                package: 'sales_order',
                fields: ['amount', 'order_no'],
                row: { region: 'north' },
                data_date: '2041-03-01',
                action: 'query',
                as_of: day(),
                environment: 'test',
            },
        }),
    });
    assert.equal(r.status, 200);
    await waitCase(applicant, caseNo, (x) => x.usage?.queries === 1, '對帳程式拉回使用摘要');
    basisCaseId = c.case_id;
});

test('DA-ENV-TEST-BASIS 端對端：申請正式區時從清單選測試區的單當依據（390px，步數）；簽核人在決定畫面看到環境與依據', async () => {
    assert.ok(basisCaseId, '前一個測試產生的測試區單');
    const p = await loggedIn('p04');
    await openNew(p);
    const steps = [];
    // 「給誰・多久」「哪些資料」「用途」照原本的填法；新的動作只有兩步：選正式區、選依據
    await fillApplication(p, spec(2041, { environment: 'prod', basis: basisCaseId, application: app }));
    steps.push('在「哪些資料」選「正式區」', '從清單選測試區的單', '填「用在哪支程式或報表」', '填版本識別', '填「結果給誰看」');
    console.log(`申請正式區並引用測試區的單：比原本多 ${steps.length} 步（${steps.join(' → ')}）`);
    assert.ok(steps.length <= 5);
    const { caseNo } = await submitForm(p);
    const manager = await decisionScreen(caseNo);
    assert.equal(await manager.page.getAttribute('[data-testid=environment-line]', 'data-environment'), 'prod');
    assert.match(await manager.page.textContent('[data-testid=test-basis-line]'), /測試依據：測試區單 \d+/);
    // 系統算出的測試報告：實際用了訂單金額與訂單編號，訂單日期沒用到（警示在最上面，建議從申請拿掉）
    const report = await manager.page.textContent('[data-testid=test-report]');
    assert.match(report, /訂單金額：查詢 1 次/);
    assert.match(await manager.page.textContent('[data-testid=report-warnings]'), /訂單日期.*建議從這次申請拿掉/);
    assert.deepEqual(await layoutProblems(manager.page, '決定畫面（正式區、測試依據、測試報告）'), []);
});

test('DA-TEST-EXCEPTION 端對端：沒有測試紀錄時選「沒有測試紀錄」並填理由（390px）；送出後開例外，簽核人在決定畫面看到理由與例外', async () => {
    const p = await loggedIn('p04');
    await openNew(p);
    await fillApplication(p, spec(2042, { environment: 'prod', basisReason: '新報表第一次上線', application: app }));
    assert.deepEqual(await layoutProblems(p.page, '新申請（沒有測試紀錄）'), []);
    await checkSettled(p.page);
    const { caseNo } = await submitForm(p);
    const manager = await decisionScreen(caseNo);
    assert.match(await manager.page.textContent('[data-testid=test-exception-line]'), /新報表第一次上線/);
    assert.match(await manager.page.textContent('main'), /測試例外/);
    assert.deepEqual(await layoutProblems(manager.page, '決定畫面（沒有測試紀錄）'), []);
    // 核准生效之後：申請人在首頁看到要補的上線後使用報告，按一下產生（步數）
    for (const uid of ['p03', 'p11', 'p18']) {
        await signer(uid);
        await decide(uid, caseNo);
    }
    const applicant = await loggedIn('p04');
    const c = await waitCase(applicant, caseNo, (x) => x.state === 'verifying' && x.confirmation?.status === 'pending', '等申請人確認');
    assert.equal((await callApi(applicant.page, '/api/case_confirm_verification', { case_id: c.case_id })).result.state, 'active');
    const steps = [];
    await home(applicant);
    steps.push('打開首頁');
    await applicant.page.waitForSelector(`[data-testid=report-followup][data-case-no="${caseNo}"]`);
    assert.deepEqual(await layoutProblems(applicant.page, '首頁（等你補的使用報告）'), []);
    await applicant.page.click(`[data-testid=report-followup][data-case-no="${caseNo}"] [data-testid=report-make]`);
    steps.push('按「產生使用報告」');
    await applicant.page.waitForSelector('[data-testid=report-followups] [data-testid=test-report]');
    console.log(`申請人補上線後使用報告：${steps.length} 步（${steps.join(' → ')}）`);
    assert.deepEqual(await layoutProblems(applicant.page, '上線後使用報告'), []);
    const open = await admin.query(
        `select count(*)::int as n from sgn.exception_record where case_id = $1 and rule_code = 'DA-TEST-REPORT-FOLLOWUP' and closed_at is null`,
        [c.case_id],
    );
    assert.equal(open.rows[0].n, 0, '產生報告後結案');
});
