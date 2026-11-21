// 端對端：閉環第三批（docs/handoff/closed-loop-3.md）——六個畫面問題與匯出需求調查，在 390px 寬的真實畫面上。
//   稽核證據頁沒有「null」；稽核首頁重點在上、例外去重分組；原因欄位的說明依操作者；捨棄草稿；重疊提示寫出欄位；
//   匯出需求調查（目的、頻率簽進去；方法是調查紀錄，不出現在簽核畫面）；稽核的彙總。
// 排在 system-delivery、system-loop 之後（檔名排序）：前面的檔案留下了林怡君（p04）生效中的單。
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { pool as dbPool } from '../../db/tests/kernel/lib/harness.mjs';
import {
    ORIGIN,
    callApi,
    checkSettled,
    day,
    fillApplication,
    flashAfter,
    home,
    layoutProblems,
    loggedIn,
    openNew,
    openSegment,
    signer,
    startBrowser,
    stopBrowser,
    submitForm,
    waitPage,
} from './lib/ui.mjs';

const admin = dbPool('ADMIN');
const results = {};

before(startBrowser);
after(async () => {
    console.log(JSON.stringify({ screens: results }));
    await stopBrowser();
});

const spec = (year, extra = {}) => ({
    principal: 'sales-report-bot',
    from: day(),
    to: day(2),
    packages: { sales_order: { fields: ['order_no', 'amount', 'order_date'], filters: { region: ['north'] } } },
    period: { from: `${year}-01-01`, to: `${year}-12-31` },
    purpose: 'reporting',
    description: `畫面問題端對端 ${year}`,
    ...extra,
});

/** 頁面上看得到的文字裡不該有程式的空值。 */
async function noNullText(page, label) {
    const text = await page.locator('main').innerText();
    assert.ok(!/null|undefined|NaN/.test(text), `${label} 出現空值：${/.{0,30}(null|undefined|NaN).{0,30}/.exec(text)?.[0]}`);
}

async function auditPage(auditor, caseNo) {
    await auditor.page.goto(`${ORIGIN}/#audit/${caseNo}`);
    await auditor.page.reload();
    await auditor.page.waitForSelector('[data-testid=audit-result]:not([data-status=pending])');
}

const mineCases = async (p) => (await callApi(p.page, '/api/case_list_mine')).result;

test('K-CASE-DISCARD 捨棄草稿：新申請畫面按「捨棄草稿」→ 確認（2 步），草稿不在我的申請；稽核證據頁（草稿、捨棄、簽核中）沒有「null」', async () => {
    const applicant = await loggedIn('p04');
    await openNew(applicant);
    await fillApplication(applicant, spec(2091));
    const before = await mineCases(applicant);
    const draft = before.find((c) => c.state === 'draft' && c.content.data_period?.from === '2091-01-01');
    assert.ok(draft, '填寫時存成了草稿');
    assert.ok(draft.actions.includes('discard'));
    await openSegment(applicant.page, 'review');
    const steps = [];
    await applicant.page.click('[data-action=discard]');
    steps.push('按「捨棄草稿」');
    const { ok } = await flashAfter(applicant.page, () => applicant.page.click('[data-testid=discard-submit]'));
    steps.push('確認捨棄');
    assert.ok(ok);
    await waitPage(applicant.page);
    assert.ok(!(await mineCases(applicant)).some((c) => c.case_id === draft.case_id), '捨棄的草稿不列');
    results.discard = { steps: steps.length, detail: steps, draft_no: draft.case_no };
    assert.ok(steps.length <= 2);

    // 證據頁：捨棄的草稿、簽核中的單（沒有逾期、沒有例外時原本會出現「nullnull」）
    const sent = await submitAfterFill(applicant, spec(2092));
    const auditor = await loggedIn('p22');
    for (const [label, no] of [
        ['捨棄的草稿', draft.case_no],
        ['簽核中', sent],
    ]) {
        await auditPage(auditor, no);
        await noNullText(auditor.page, `稽核證據頁（${label}）`);
        assert.deepEqual(await layoutProblems(auditor.page, `稽核證據頁（${label}）`), []);
    }
    const types = await auditor.page.locator('[data-testid=audit-events] li').evaluateAll((lis) => lis.map((li) => li.textContent));
    assert.ok(!types.some((x) => x.startsWith('例外：請查看')), '每個事件都有名稱');
});

/** 送出；和前面的測試留下的授權部分重疊時附理由（理由欄只在部分重疊時出現）。 */
async function send(p) {
    await openSegment(p.page, 'review');
    await checkSettled(p.page);
    return submitForm(p, (await p.page.isVisible('#f-overlap-reason')) ? '端對端：和前面的授權重疊' : null);
}

async function submitAfterFill(p, s) {
    await openNew(p);
    await fillApplication(p, s);
    return (await send(p)).caseNo;
}

test('K-HOME-ORDER 稽核人員首頁：背景程式、查單、例外在「我的申請」之前；例外同規則同單只列一次，已結案的預設收起來', async () => {
    const auditor = await loggedIn('p22');
    await home(auditor);
    const order = await auditor.page.locator('main > section').evaluateAll((s) => s.map((x) => x.dataset.testid));
    assert.ok(order.indexOf('section-exceptions') >= 0);
    if (order.includes('section-mine')) assert.ok(order.indexOf('section-exceptions') < order.indexOf('section-mine'), order.join(','));
    const health = await auditor.page.locator('main > *').evaluateAll((s) => s.findIndex((x) => x.dataset.testid === 'program-health'));
    assert.equal(health, 0, '最上面是背景程式的狀態');
    const rows = await auditor.page
        .locator('[data-testid=audit-exceptions] > li')
        .evaluateAll((lis) => lis.map((li) => `${li.dataset.rule}|${li.querySelector('a')?.textContent ?? li.firstChild.textContent}`));
    assert.equal(new Set(rows).size, rows.length, '沒有重複的列');
    assert.equal(
        await auditor.page.locator('[data-testid=audit-exceptions] [data-testid=exception-closed]').count(),
        0,
        '未結案清單裡沒有已結案的',
    );
    const closed = auditor.page.locator('[data-testid=audit-exceptions-closed]');
    if ((await closed.count()) > 0) assert.equal(await closed.evaluate((d) => d.open), false, '已結案的預設收起來');
    await noNullText(auditor.page, '稽核首頁');
    assert.deepEqual(await layoutProblems(auditor.page, '稽核首頁'), []);
});

test('K-REASON-AUDIENCE 申請人自己撤銷生效中的單：原因欄位說明「記在紀錄裡」，不寫「申請人會看到」', async () => {
    const applicant = await loggedIn('p04');
    const target = (await mineCases(applicant)).find((c) => c.actions.includes('revoke'));
    assert.ok(target, '前面的測試檔留下了可以撤銷的單');
    await applicant.page.goto(`${ORIGIN}/#case/${target.case_id}`);
    await applicant.page.reload();
    await applicant.page.waitForSelector('[data-testid=decision-facts]');
    await applicant.page.click('[data-action=revoke]');
    const label = await applicant.page.textContent('label[for=revoke-reason]');
    assert.ok(!label.includes('申請人會看到'), label);
    assert.match(label, /紀錄|負責人/);
    assert.deepEqual(await layoutProblems(applicant.page, '撤銷面板'), []);
    await applicant.page.click('.sheet button:not(.primary)');
});

test('K-OVERLAP-SHOWN 重疊提示寫出重疊的主題包、欄位與對方的單號（自己的單）', async () => {
    const applicant = await loggedIn('p04');
    const active = (await mineCases(applicant)).find((c) => c.state === 'active' && c.terms.principal?.name === 'sales-report-bot');
    assert.ok(active);
    const created = (
        await callApi(applicant.page, '/api/case_create', {
            process_type: 'data_access',
            content: active.content,
            terms: { principal_id: active.terms.principal.principal_id, valid_from: day(), valid_to: day(1) },
        })
    ).result;
    await applicant.page.goto(`${ORIGIN}/#edit/${created.case_id}`);
    await applicant.page.reload();
    await applicant.page.waitForSelector('[data-testid=apply-form]');
    await openSegment(applicant.page, 'review');
    await checkSettled(applicant.page);
    const item = applicant.page.locator(`[data-testid=overlap-item][data-case-no="${active.case_no}"]`);
    assert.equal(await item.count(), 1);
    const text = await item.textContent();
    assert.ok(text.includes(String(active.case_no)) && text.includes('銷售訂單'), text);
    assert.match(text, /訂單編號|訂單金額|訂單日期/);
    assert.deepEqual(await layoutProblems(applicant.page, '重疊提示'), []);
    await callApi(applicant.page, '/api/case_discard', { case_id: created.case_id });
});

test('DA-EXPORT-SURVEY 端對端：要匯出時填目的、頻率、方法；簽核人看得到目的與頻率（簽進去），看不到方法；方法是介面串接時畫面取消匯出；稽核看得到彙總', async () => {
    const applicant = await loggedIn('p04');
    await openNew(applicant);
    await fillApplication(applicant, spec(2093, { exportAllowed: true }));
    await openSegment(applicant.page, 'purpose');
    assert.equal(await applicant.page.isVisible('[data-testid=export-survey]'), true);
    const steps = [];
    await applicant.page.selectOption('#f-exp-purpose', 'offline_analysis');
    steps.push('選目的');
    assert.match(await applicant.page.textContent('[data-testid=f-exp-purpose-guidance]'), /分析環境/);
    await applicant.page.selectOption('#f-exp-frequency', 'monthly');
    steps.push('選頻率');
    await applicant.page.selectOption('#f-exp-method', 'manual_download');
    steps.push('選方法');
    await applicant.page.waitForSelector('[data-testid=export-method-result][data-method=manual_download]');
    assert.deepEqual(await layoutProblems(applicant.page, '匯出需求調查'), []);
    const { caseNo } = await send(applicant);
    results.export_survey = { extra_steps: steps.length, detail: steps };

    // 簽核人：目的、頻率在決定畫面；方法不在
    const manager = await signer('p03');
    await home(manager);
    await manager.page.click(`[data-case-no="${caseNo}"]`);
    await manager.page.waitForSelector('[data-testid=decision-facts]');
    const line = await manager.page.textContent('[data-testid=export-survey-line]');
    assert.match(line, /離線分析/);
    assert.match(line, /每月/);
    assert.ok(!(await manager.page.locator('main').innerText()).includes('人工下載'), '方法不在簽核畫面');

    // 方法是介面串接：資料庫回傳要關閉匯出，畫面取消「需要匯出」
    await openNew(applicant);
    await fillApplication(applicant, spec(2094, { exportAllowed: true }));
    await openSegment(applicant.page, 'purpose');
    await applicant.page.selectOption('#f-exp-purpose', 'external_handover');
    await applicant.page.selectOption('#f-exp-frequency', 'daily');
    await applicant.page.selectOption('#f-exp-method', 'system_integration');
    await applicant.page.waitForSelector('[data-testid=export-method-result][data-method=system_integration]');
    assert.equal(await applicant.page.isChecked('#f-export'), false);
    assert.match(await applicant.page.textContent('[data-testid=f-exp-method-guidance]'), /那個系統自己/);
    await openSegment(applicant.page, 'review');
    await checkSettled(applicant.page);

    // 稽核：彙總
    const auditor = await loggedIn('p22');
    await home(auditor);
    await auditor.page.waitForSelector('[data-testid=export-survey-summary]');
    const offline = await auditor.page.getAttribute(
        '[data-testid=export-survey-summary] [data-group=by_purpose] li[data-code=offline_analysis]',
        'data-cases',
    );
    assert.ok(Number(offline) >= 1);
    assert.deepEqual(await layoutProblems(auditor.page, '匯出需求彙總'), []);
    const recorded = await admin.query(
        `select count(*)::int as n from pack_data_access.export_method_record where method_code = 'system_integration'`,
    );
    assert.ok(recorded.rows[0].n >= 1);
});
