// 端對端：資料授權的完整簽核流程。真的 Dex 登入頁、真的 WebAuthn（Chromium + CDP 虛擬驗證器）、390px 寬。
// 前提：sim（ldap、idp）、端對端用的資料庫（SGN_DATABASE）、錨定程式（每 2 秒）、後端都在跑 —— 由 tools/run-all.sh 啟動。
// 測試依序執行、共用同一個資料庫：前面的測試產生的有效授權，後面的重疊測試會用到。竄改測試必須放在最後。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { RUN_DIR, adminUrl, loadConfig } from '../../db/tools/lib/env.mjs';
import { decisionChallenge, pool as dbPool, setSetting } from '../../db/tests/kernel/lib/harness.mjs';
import { fingerprintFromPayload, fingerprintPayload } from '../../web/lib/qr.js';
import {
    API,
    ORIGIN,
    apply,
    callApi,
    caseByNo,
    checkSettled,
    day,
    decide,
    decideHere,
    ensurePasskey,
    fakeBarcodeDetector,
    fillApplication,
    flashAfter,
    home,
    layoutProblems,
    loggedIn,
    openFromHome,
    openNew,
    openPackage,
    openSegment,
    person,
    readDeviceQr,
    login,
    requestPasskeyInUi,
    sessionOf,
    startBrowser,
    stopBrowser,
    submitForm,
    theBrowser,
    useInstalledRegistrarKey,
    waitPage,
} from './lib/ui.mjs';

const config = loadConfig();
const results = { measured_at: new Date().toISOString(), viewport: '390x844', tests: {} };

before(async () => {
    await startBrowser();
    // 這個檔案測人工執行的退路（系統管理人認領、看規則、以通行金鑰標記已套用）：資料中心在這裡設定為人工。
    // 系統對系統的交付（種子的預設，D63）在 system-delivery.test.mjs，排在這個檔案之後。
    await setSetting(dbPool('ADMIN'), 'delivery.mode', 'manual', 'system:dc');
});
after(async () => {
    await stopBrowser();
    mkdirSync(RUN_DIR, { recursive: true });
    writeFileSync(join(RUN_DIR, 'e2e-results.json'), `${JSON.stringify(results, null, 2)}\n`);
});

/** 林怡君的 L3 申請：客戶主檔（北、中區）＋銷售訂單（北區、2025 年）。 */
const l3 = (overrides = {}) => ({
    principal: '北區客戶流失分析',
    from: day(),
    // 新申請畫面預設測試區（DA-ENV-FIELD），測試區的授權期間上限較短（DA-ENV-VALIDITY，初始 3 個月）
    to: day(2),
    packages: {
        customer_master: { fields: ['customer_id', 'customer_name'], filters: { region: ['north', 'central'] } },
        sales_order: { fields: ['order_no', 'amount', 'order_date'], filters: { region: ['north'] } },
    },
    period: { from: '2025-01-01', to: '2025-12-31' },
    purpose: 'reporting',
    description: '北區客戶流失分析',
    ...overrides,
});

const stageCodes = (page) => page.locator('[data-testid=path] li').evaluateAll((lis) => lis.map((li) => li.dataset.stage));

async function auditUntilAnchored(auditor, caseNo) {
    let status;
    for (const started = performance.now(); performance.now() - started < 30000; ) {
        await auditor.page.goto(`${ORIGIN}/#audit/${caseNo}`);
        await auditor.page.reload();
        await auditor.page.waitForSelector('[data-testid=audit-result]:not([data-status=pending])');
        status = await auditor.page.getAttribute('[data-testid=audit-result]', 'data-status');
        if (status !== 'warn') break;
    }
    return status;
}

let mainCaseNo;

test('DA-PATH-L3 L3 走完：林怡君申請 → 陳建宏核准 → 周文傑與張美玲並行 → 資安合規檢查認領核准 → 系統管理人標記已套用 → 生效 → 黃淑芬驗證', async () => {
    const layout = [];
    const applicant = await loggedIn('p04');
    layout.push(...(await layoutProblems(applicant.page, '申請人首頁')));
    await openNew(applicant);
    await fillApplication(applicant, l3());
    // 即時檢查：資料庫判定的級別、路徑（並行的資料擁有者）、沒有重疊
    assert.equal(await applicant.page.textContent('[data-testid=check] [data-testid=tier]'), 'L3');
    assert.deepEqual(await stageCodes(applicant.page), ['manager', 'data_owner', 'mis', 'fulfil']);
    assert.equal(await applicant.page.getAttribute('[data-testid=check] [data-testid=overlap]', 'data-level'), 'none');
    layout.push(...(await layoutProblems(applicant.page, '新申請（填好）')));
    const submitted = await submitForm(applicant);
    mainCaseNo = submitted.caseNo;
    assert.match(submitted.text, /陳建宏/);
    layout.push(...(await layoutProblems(applicant.page, '申請單詳情（申請人）')));

    // 陳建宏（p03）：第一次要先登記通行金鑰；從待簽清單開始數步數（T2）
    const manager = await loggedIn('p03');
    await manager.page.waitForSelector('[data-testid=passkey-missing]');
    assert.equal(await ensurePasskey(manager), true);
    assert.equal(await manager.page.locator('[data-testid=passkey-missing]').count(), 0);
    layout.push(...(await layoutProblems(manager.page, '簽核人首頁（待簽清單）')));
    const steps = [];
    await manager.page.click(`[data-testid=inbox-item][data-case-no="${mainCaseNo}"]`);
    steps.push('點待簽清單裡的單');
    await manager.page.waitForSelector('[data-testid=decision-facts]');
    // 第一個畫面就要看到：誰申請、給誰、哪些資料、多久、與前案差異、重疊警示（不用捲動）
    const facts = manager.page.locator('[data-testid=decision-facts]');
    for (const text of ['林怡君', '北區客戶流失分析', '客戶主檔', '銷售訂單', day(2), '沒有前一版', '沒有和有效授權重疊'])
        assert.match(await facts.textContent(), new RegExp(text));
    const factsBox = await facts.boundingBox();
    const barBox = await manager.page.locator('[data-testid=action-bar]').boundingBox();
    layout.push(...(await layoutProblems(manager.page, '簽核詳情')));
    await manager.page.click('[data-action=approve]');
    steps.push('按「核准」');
    layout.push(...(await layoutProblems(manager.page, '核准確認')));
    const t0 = performance.now();
    await manager.page.click('[data-testid=confirm-passkey]');
    steps.push('按「用通行金鑰確認」');
    steps.push('裝置上的使用者驗證（指紋／臉部／PIN；虛擬驗證器自動通過）');
    await manager.page.waitForSelector('#flash.ok:not([hidden])');
    const decideMs = performance.now() - t0;
    assert.match(await manager.page.textContent('#flash'), /已核准/);

    // 兩位資料擁有者並行：一位核准後仍停在資料擁有者關
    await decide('p09', mainCaseNo);
    let c = await caseByNo(applicant, mainCaseNo);
    assert.equal(c.current_stage.code, 'data_owner');
    assert.deepEqual(c.waiting_on, ['張美玲']);
    await decide('p11', mainCaseNo);
    c = await caseByNo(applicant, mainCaseNo);
    assert.equal(c.current_stage.code, 'mis');

    // 資安合規檢查：MIS 群組認領（謝明哲）後核准
    const mis = await loggedIn('p16');
    await openFromHome(mis, mainCaseNo);
    assert.deepEqual(await mis.page.locator('[data-testid=action-bar] [data-action]').evaluateAll((b) => b.map((x) => x.dataset.action)), [
        'claim',
    ]);
    layout.push(...(await layoutProblems(mis.page, '資安合規檢查（認領前）')));
    await decide('p16', mainCaseNo);

    // 系統管理人（李志偉，dc 的管理人）：待執行清單 → 認領 → 看要套用的規則 → 標記已套用
    const custodian = await loggedIn('p17');
    await home(custodian);
    await ensurePasskey(custodian);
    await custodian.page.click(`[data-testid=fulfil-item][data-case-no="${mainCaseNo}"]`);
    await custodian.page.waitForSelector('[data-testid=fulfilment-rules]');
    const rules = await custodian.page.locator('[data-testid=fulfilment-rules] [data-rule-id]').count();
    assert.equal(rules, 2);
    await custodian.page.click('[data-action=claim]');
    await custodian.page.waitForSelector('[data-action=fulfil]');
    layout.push(...(await layoutProblems(custodian.page, '執行內容')));
    assert.match(await decideHere(custodian, 'fulfil'), /等申請人確認後生效/);
    c = await caseByNo(applicant, mainCaseNo);
    assert.equal(c.state, 'verifying', '人工執行的單也要申請人確認（K-CONFIRM-MANUAL，裁決 D84 (8)）');
    assert.equal(c.grant, null);

    // 申請人在手機上確認（從首頁數步數；人工執行沒有自動驗證，畫面寫明是系統管理人標記的）
    const confirmSteps = [];
    await home(applicant);
    assert.match(
        await applicant.page.textContent(`[data-testid=confirm-item][data-case-no="${mainCaseNo}"] [data-testid=confirm-due]`),
        /還有 5 個工作天/,
        '首頁的站內待辦：剩幾個工作天（K-CONFIRM-REMIND）',
    );
    await applicant.page.click(`[data-testid=confirm-item][data-case-no="${mainCaseNo}"]`);
    confirmSteps.push('打開等你確認的單');
    await applicant.page.waitForSelector('[data-testid=confirmation][data-status=pending] [data-testid=confirmation-manual]');
    layout.push(...(await layoutProblems(applicant.page, '確認人工執行的結果')));
    await applicant.page.click('[data-action=confirm_verification]');
    confirmSteps.push('結果正確，確認生效');
    await applicant.page.click('[data-testid=confirm-verification-submit]');
    confirmSteps.push('確認生效');
    await applicant.page.waitForSelector('#flash.ok:not([hidden])');
    assert.ok(confirmSteps.length <= 3, `步數 ${confirmSteps.length} 超過 T7 上限 3`);
    console.log(`K-CONFIRM-MANUAL 確認人工執行的結果：${confirmSteps.length} 步（${confirmSteps.join(' → ')}）`);
    results.tests.confirm_manual = { steps: confirmSteps.length };
    c = await caseByNo(applicant, mainCaseNo);
    assert.equal(c.state, 'active');
    assert.equal(c.grant.status, 'active');

    // 申請人看到生效
    await home(applicant);
    assert.equal(
        await applicant.page.getAttribute(`[data-testid=mine-item][data-case-no="${mainCaseNo}"] [data-testid=state]`, 'data-state'),
        'active',
    );

    // 黃淑芬（p22）：驗證整條鏈、外部錨點與每個決定的簽章；看得到完整的多關卡紀錄
    const auditor = await loggedIn('p22');
    const tAnchor = performance.now();
    const status = await auditUntilAnchored(auditor, mainCaseNo);
    const anchorWaitMs = performance.now() - tAnchor;
    assert.equal(status, 'ok', await auditor.page.textContent('[data-testid=audit-result]'));
    const tVerify = performance.now();
    await auditor.page.click('text=重新驗證');
    await auditor.page.waitForSelector('[data-testid=audit-result][data-status=ok]');
    const verifyMs = performance.now() - tVerify;
    const types = await auditor.page.locator('[data-testid=audit-events] li').evaluateAll((lis) => lis.map((li) => li.dataset.type));
    for (const type of [
        'case.created',
        'case.submitted',
        'case.stage_opened',
        'case.approve',
        'case.claimed',
        'case.fulfil',
        'grant.activated',
    ])
        assert.ok(types.includes(type), type);
    assert.equal(types.filter((x) => x === 'case.approve').length, 4, '主管、兩位資料擁有者、資安合規檢查');
    const approvals = await auditor.page.locator('[data-testid=audit-events] li[data-type="case.approve"]').allTextContents();
    for (const name of ['陳建宏', '周文傑', '張美玲', '謝明哲'])
        assert.ok(
            approvals.some((x) => x.includes(name) && x.includes('通行金鑰簽章')),
            name,
        );
    layout.push(...(await layoutProblems(auditor.page, '稽核證據頁')));

    results.tests.l3 = {
        case_no: mainCaseNo,
        approver_steps_from_inbox: steps.length,
        approver_steps: steps,
        decision_facts_visible_without_scroll: factsBox.y + factsBox.height <= barBox.y,
        decide_ms: Math.round(decideMs),
        anchor_wait_ms: Math.round(anchorWaitMs),
        auditor_verify_ms: Math.round(verifyMs),
        layout_problems: layout,
    };
    assert.ok(steps.length <= 4, `步數 ${steps.length} 超過 T2 上限 4`);
    assert.deepEqual(layout, []);
});

test('K-SOD-APPLICANT 林怡君不能核准自己的單：畫面沒有決定按鈕，繞過畫面直接打後端也被擋', async () => {
    const applicant = await loggedIn('p04');
    const own = await apply('p04', l3({ principal: '業務分析部', description: '測試自己核准' }));
    await home(applicant);
    assert.equal(await applicant.page.locator('[data-testid=section-inbox]').count(), 0);
    await applicant.page.click(`[data-testid=mine-item][data-case-no="${own.caseNo}"]`);
    await applicant.page.waitForSelector('[data-testid=decision-facts]');
    const shown = await applicant.page.locator('[data-action]').evaluateAll((b) => b.map((x) => x.dataset.action));
    assert.deepEqual(shown, ['recall'], '申請人在簽核中只能撤回');
    const c = await caseByNo(applicant, own.caseNo);
    const res = await callApi(applicant.page, '/api/challenge_issue', { case_id: c.case_id, decision: 'approve', input: {} });
    assert.equal(res.status, 403);
    assert.ok(['SELF_APPROVAL', 'NOT_APPROVER'].includes(res.error.code), res.error.code);
    const audit = await callApi(applicant.page, '/api/audit_case', { case_no: own.caseNo });
    assert.equal(audit.error.code, 'AUDITOR_REQUIRED');
    results.tests.self_approval = { case_no: own.caseNo, response: res };
});

test('K-DECISION-PROOF 沒有通行金鑰的證明就核准不了', async () => {
    const applicant = await loggedIn('p04');
    const manager = await loggedIn('p03');
    const pending = await apply('p04', l3({ principal: '季度業績看板', description: '測試沒有證明' }));
    // 代填（季度業績看板的負責人是蔡佩珊）：第一關負責人確認先過，主管關才開（D79 (2)）
    await decide('p06', pending.caseNo);
    const caseId = (await caseByNo(applicant, pending.caseNo)).case_id;
    const outcomes = {};

    // 1. 沒有任何「只憑登入就核准」的路由
    outcomes.no_route = (await callApi(manager.page, '/api/case_decide_idp', { case_id: caseId })).status;
    assert.equal(outcomes.no_route, 404);

    // 2. 有挑戰值、但證明是空的
    const ch = (await callApi(manager.page, '/api/challenge_issue', { case_id: caseId, decision: 'approve', input: {} })).result;
    assert.equal(ch.challenge, undefined, '後端不給可以直接簽的值（D68）');
    // 偽造的 assertion 用「正確算出的」挑戰值，才能測到簽章本身（測試在資料庫那一側扮演主管的瀏覽器算）
    const computed = await decisionChallenge(dbPool('APP'), await sessionOf(manager), caseId, 'approve', {}, ch);
    const empty = await callApi(manager.page, '/api/case_decide_passkey', { challenge_id: ch.challenge_id, decision: 'approve' });
    outcomes.empty_proof = empty.error.code;
    assert.notEqual(empty.status, 200);

    // 3. 用一把沒登記的金鑰對挑戰值簽章（格式完全正確的 WebAuthn assertion）
    // 4. 用主管登記過的憑證 id，配上別的金鑰的簽章
    const { credentials } = await manager.cdp.send('WebAuthn.getCredentials', { authenticatorId: manager.authenticatorId });
    const registeredId = Buffer.from(credentials[0].credentialId, 'base64').toString('base64url');
    const forged = await manager.page.evaluate(
        async ({ challenge, registeredId }) => {
            const b64 = (buf) =>
                btoa(String.fromCharCode(...new Uint8Array(buf)))
                    .replaceAll('+', '-')
                    .replaceAll('/', '_')
                    .replace(/=+$/, '');
            const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
            const clientData = new TextEncoder().encode(JSON.stringify({ type: 'webauthn.get', challenge, origin: location.origin }));
            const rpHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(location.hostname)));
            const authData = new Uint8Array([...rpHash, 0x05, 0, 0, 0, 9]);
            const clientHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientData));
            const raw = new Uint8Array(
                await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, new Uint8Array([...authData, ...clientHash])),
            );
            const int = (b) => {
                let x = [...b];
                while (x.length > 1 && x[0] === 0 && x[1] < 0x80) x = x.slice(1);
                if (x[0] >= 0x80) x = [0, ...x];
                return [0x02, x.length, ...x];
            };
            const seq = [...int(raw.slice(0, 32)), ...int(raw.slice(32))];
            const der = new Uint8Array([0x30, seq.length, ...seq]);
            const proof = { authenticatorData: b64(authData), clientDataJSON: b64(clientData), signature: b64(der) };
            return {
                unregistered: { ...proof, credentialId: b64(crypto.getRandomValues(new Uint8Array(16))) },
                stolenId: { ...proof, credentialId: registeredId },
            };
        },
        { challenge: computed, registeredId },
    );
    for (const [name, a] of Object.entries(forged)) {
        const res = await callApi(manager.page, '/api/case_decide_passkey', {
            challenge_id: ch.challenge_id,
            decision: 'approve',
            credential_id: a.credentialId,
            authenticator_data: a.authenticatorData,
            client_data_json: a.clientDataJSON,
            signature: a.signature,
        });
        outcomes[name] = res.error?.code ?? `HTTP ${res.status}`;
    }
    assert.equal(outcomes.unregistered, 'PASSKEY_UNKNOWN');
    assert.equal(outcomes.stolenId, 'PASSKEY_INVALID');

    // 5. 畫面上按了核准，但裝置上的使用者驗證沒有通過（例如指紋失敗、使用者取消）
    await manager.cdp.send('WebAuthn.setUserVerified', { authenticatorId: manager.authenticatorId, isUserVerified: false });
    await openFromHome(manager, pending.caseNo);
    await manager.page.click('[data-action=approve]');
    await manager.page.click('[data-testid=confirm-passkey]');
    await manager.page.waitForSelector('[data-testid=decision-error]:not([hidden])', { timeout: 70000 });
    outcomes.ui_without_user_verification = await manager.page.textContent('[data-testid=decision-error]');
    await manager.cdp.send('WebAuthn.setUserVerified', { authenticatorId: manager.authenticatorId, isUserVerified: true });

    // 單仍然在主管這一關
    const after = await caseByNo(applicant, pending.caseNo);
    assert.equal(after.state, 'in_approval');
    assert.equal(after.current_stage.code, 'manager');
    results.tests.no_proof = { case_no: pending.caseNo, outcomes };
});

test('DA-PATH-L4 L4 多一關資安長，且不能申請匯出：畫面提示已改為只能查看，路徑多出資安長', async () => {
    const applicant = await loggedIn('p04');
    await openNew(applicant);
    await fillApplication(applicant, {
        principal: 'sales-report-bot',
        from: day(),
        to: day(2),
        packages: { payroll: { fields: ['employee_id', 'net_pay', 'pay_date'] } },
        period: { from: '2026-01-01', to: '2026-12-31' },
        purpose: 'operations',
        description: '薪資對帳',
        exportAllowed: true,
    });
    assert.equal(await applicant.page.textContent('[data-testid=check] [data-testid=tier]'), 'L4');
    assert.deepEqual(await stageCodes(applicant.page), ['manager', 'data_owner', 'ciso', 'mis', 'fulfil']);
    const notices = await applicant.page.locator('[data-testid=notices] li').evaluateAll((lis) => lis.map((li) => li.dataset.code));
    assert.ok(notices.includes('DA-N-EXPORT-FORCED'), notices.join(','));
    const { caseNo } = await submitForm(applicant);
    let c = await caseByNo(applicant, caseNo);
    assert.equal(c.content.export_allowed, false);
    await decide('p03', caseNo);
    await decide('p15', caseNo);
    c = await caseByNo(applicant, caseNo);
    assert.equal(c.current_stage.code, 'ciso');
    assert.deepEqual(c.waiting_on, ['賴政達']);
    await decide('p19', caseNo);
    c = await caseByNo(applicant, caseNo);
    assert.equal(c.current_stage.code, 'mis');
    results.tests.l4 = { case_no: caseNo, notices, stages: c.stages.map((s) => s.code) };
});

test('K-CHANGE-REDUCE 簽核人縮短授權迄日後核准：不用重簽，申請人看得到「已縮小」的標示（T3 步數）', async () => {
    const applicant = await loggedIn('p04');
    const { caseNo } = await apply('p04', l3({ principal: '業務分析部', to: day(2), description: '縮小測試' }));
    // 業務分析部的負責人陳建宏是林怡君的主管：他先簽負責人確認，主管關因此往上給方國華（D79 (2)、K-SOD-DISTINCT）
    await decide('p03', caseNo);
    await decide('p02', caseNo);
    const owner = await loggedIn('p11');
    await home(owner);
    const steps = [];
    const layout = [];
    await owner.page.click(`[data-testid=inbox-item][data-case-no="${caseNo}"]`);
    steps.push('點待簽清單裡的單');
    await owner.page.waitForSelector('[data-testid=decision-facts]');
    assert.match(await owner.page.textContent('[data-testid=validity]'), new RegExp(day(2)));
    await owner.page.click('[data-action=approve_reduced]');
    steps.push('按「縮小後核准」');
    layout.push(...(await layoutProblems(owner.page, '縮小後核准')));
    await owner.page.fill('[data-testid=reduce-valid-to]', day(1));
    steps.push('改授權迄日');
    await owner.page.click('[data-testid=reduce-submit]');
    steps.push('按「縮小後核准」（送出縮小內容）');
    await owner.page.click('[data-testid=confirm-passkey]');
    steps.push('按「用通行金鑰確認」');
    steps.push('裝置上的使用者驗證');
    await owner.page.waitForSelector('#flash.ok:not([hidden])');
    const c = await caseByNo(applicant, caseNo);
    assert.equal(c.terms.valid_to, day(1));
    assert.deepEqual(c.versions.map((v) => [v.change_kind, v.created_by_name]).at(-1), ['reduce', '張美玲']);
    assert.equal(c.stages.find((s) => s.code === 'manager').status, 'done', '主管不用重簽');
    // 申請人：詳情頁看得到誰縮小了什麼
    await openFromHome(applicant, caseNo);
    assert.match(await applicant.page.textContent('[data-testid=reduced-by]'), /張美玲 縮小了申請內容/);
    assert.match(await applicant.page.textContent('[data-testid=diff]'), new RegExp(`授權迄日：${day(2)} → ${day(1)}`));
    // 另一位資料擁有者看到的是縮小後的版本與差異
    const other = await loggedIn('p09');
    await openFromHome(other, caseNo);
    assert.match(await other.page.textContent('[data-testid=diff]'), /張美玲 縮小了申請內容/);
    results.tests.reduce = { case_no: caseNo, steps_from_inbox: steps.length, steps, layout_problems: layout };
    assert.ok(steps.length <= 6, `步數 ${steps.length} 超過 T3 上限 6`);
    assert.deepEqual(layout, []);
});

test('K-RETURN 退回後只做縮小：從退回那關繼續；做其他修改：從第一關重簽（含 T4 步數）', async () => {
    const applicant = await loggedIn('p04');
    const { caseNo } = await apply('p04', l3({ principal: '通路業務組', description: '退回測試' }));
    await decide('p07', caseNo); // 代填：通路業務組的負責人劉俊傑先確認（D79 (2)）
    await decide('p03', caseNo);
    // 張美玲退回並填原因：數步數（T4）。常見原因按一下就用通行金鑰確認（自己寫原因的路線見下面第二次退回）
    const owner = await loggedIn('p11');
    await home(owner);
    const steps = [];
    await owner.page.click(`[data-testid=inbox-item][data-case-no="${caseNo}"]`);
    steps.push('點待簽清單裡的單');
    await owner.page.waitForSelector('[data-testid=decision-facts]');
    await owner.page.click('[data-action=return]');
    steps.push('按「退回」');
    assert.match(await owner.page.textContent('[data-testid=consequence]'), /只做縮小會從你這一關繼續/);
    const quick = owner.page.locator('[data-testid=quick-reason]').first();
    const reasonText = (await quick.textContent()).replace(/^退回：/, '');
    await quick.click();
    steps.push('按一個常見原因（同時是「用通行金鑰確認」）');
    steps.push('裝置上的使用者驗證');
    await owner.page.waitForSelector('#flash.ok:not([hidden])');
    assert.equal((await caseByNo(applicant, caseNo)).state, 'returned');

    // 申請人只做縮小（拿掉客戶主檔）→ 從資料擁有者關繼續，只剩銷售訂單的擁有者
    await openFromHome(applicant, caseNo);
    await applicant.page.click('[data-action=revise]');
    await applicant.page.waitForSelector('[data-testid=returned-note]');
    assert.match(await applicant.page.textContent('[data-testid=returned-note]'), new RegExp(`張美玲.*${reasonText}`));
    await openSegment(applicant.page, 'data');
    await openPackage(applicant.page, 'customer_master');
    for (const f of ['customer_id', 'customer_name']) await applicant.page.uncheck(`#f-customer_master-f-${f}`);
    await openSegment(applicant.page, 'review');
    await checkSettled(applicant.page);
    // 送出前就看得到：這次是縮小、從退回的那一關繼續
    await applicant.page.waitForSelector('[data-testid=resubmit][data-change=reduce][data-mode=resume]');
    assert.match(await applicant.page.textContent('[data-testid=resubmit]'), /縮小.*不用重簽/);
    await submitForm(applicant);
    let c = await caseByNo(applicant, caseNo);
    assert.equal(c.current_stage.code, 'data_owner');
    assert.deepEqual(c.waiting_on, ['張美玲']);
    assert.equal(c.stages.filter((s) => s.code === 'manager' && s.status === 'done').length, 1, '主管關仍然有效');

    // 再退回一次，這次申請人改了使用情境（擴大）→ 從第一關重簽
    await decide('p11', caseNo, 'return', '請補充用途');
    await openFromHome(applicant, caseNo);
    await applicant.page.click('[data-action=revise]');
    await applicant.page.waitForSelector('[data-testid=apply-form]');
    await openSegment(applicant.page, 'purpose');
    await applicant.page.fill('#f-purpose-text', '退回測試（補充用途：每月檢視北區訂單）');
    await openSegment(applicant.page, 'review');
    await checkSettled(applicant.page);
    await applicant.page.waitForSelector('[data-testid=resubmit][data-change=expand][data-mode=restart]');
    assert.match(await applicant.page.textContent('[data-testid=resubmit]'), /擴大.*從第一關重簽/);
    await submitForm(applicant);
    c = await caseByNo(applicant, caseNo);
    // 第一關是負責人確認（D79 (2)）：擴大後負責人要重新確認，之後才是主管
    assert.equal(c.current_stage.code, 'principal_owner');
    assert.deepEqual(c.waiting_on, ['劉俊傑']);
    await decide('p07', caseNo);
    c = await caseByNo(applicant, caseNo);
    assert.equal(c.current_stage.code, 'manager');
    assert.deepEqual(c.waiting_on, ['陳建宏']);
    // 陳建宏看到的「與前一版的差異」是和他上次核准的那一版比較
    const manager = await loggedIn('p03');
    await openFromHome(manager, caseNo);
    const diff = await manager.page.textContent('[data-testid=diff]');
    assert.match(diff, /拿掉主題包「客戶主檔」/);
    assert.match(diff, /使用情境改了/);
    // 稽核：兩次退回都由張美玲以通行金鑰簽章，驗證通過（原本「退回」測試的稽核斷言）
    const auditor = await loggedIn('p22');
    assert.equal(await auditUntilAnchored(auditor, caseNo), 'ok');
    const returns = await auditor.page.locator('[data-testid=audit-events] li[data-type="case.return"]').allTextContents();
    assert.equal(returns.length, 2);
    assert.ok(returns.every((x) => /張美玲.*通行金鑰簽章/.test(x)));
    results.tests.return = { case_no: caseNo, return_steps_from_inbox: steps.length, steps, t4_limit: 4 };
    assert.ok(steps.length <= 4, `步數 ${steps.length} 超過 T4 上限 4`);
});

test('DA-OVERLAP-COVERED 被有效授權完全涵蓋：擋下；DA-OVERLAP-PARTIAL 部分重疊：要填理由', async () => {
    const applicant = await loggedIn('p04');
    // 第一個測試已讓「北區客戶流失分析」取得客戶主檔與銷售訂單的有效授權
    await openNew(applicant);
    await fillApplication(applicant, {
        principal: '北區客戶流失分析',
        from: day(),
        to: day(2),
        packages: { sales_order: { fields: ['order_no'], filters: { region: ['north'] } } },
        period: { from: '2025-03-01', to: '2025-06-30' },
        description: '完全涵蓋',
    });
    assert.equal(await applicant.page.getAttribute('[data-testid=check] [data-testid=overlap]', 'data-level'), 'covered');
    assert.match(await applicant.page.textContent('[data-testid=check] [data-testid=overlap]'), new RegExp(`單號 ${mainCaseNo}`));
    let shown = await flashAfter(applicant.page, () => applicant.page.click('[data-testid=submit]'));
    assert.equal(shown.ok, false);
    assert.match(shown.text, /完全涵蓋/);
    const layout = await layoutProblems(applicant.page, '新申請（完全涵蓋）');

    // 多要一個欄位（客戶編號）→ 部分重疊：沒填理由送不出，填了才送出，簽核人看得到理由
    await openSegment(applicant.page, 'data');
    await applicant.page.check('#f-sales_order-f-customer_id');
    await openSegment(applicant.page, 'review');
    await checkSettled(applicant.page);
    assert.equal(await applicant.page.getAttribute('[data-testid=check] [data-testid=overlap]', 'data-level'), 'partial');
    assert.equal(await applicant.page.isVisible('#f-overlap-reason'), true);
    shown = await flashAfter(applicant.page, () => applicant.page.click('[data-testid=submit]'));
    assert.equal(shown.ok, false);
    assert.match(shown.text, /請填寫理由/);
    const { caseNo } = await submitForm(applicant, '要多看客戶編號做對帳');
    const manager = await loggedIn('p03');
    await openFromHome(manager, caseNo);
    const overlap = manager.page.locator('[data-testid=decision-facts] [data-testid=overlap]');
    assert.equal(await overlap.getAttribute('data-level'), 'partial');
    assert.match(await overlap.textContent(), /要多看客戶編號做對帳/);
    results.tests.overlap = { covered_blocked: true, partial_case_no: caseNo, layout_problems: layout };
    assert.deepEqual(layout, []);
});

test('K-SOD-DISTINCT 主管同時是資料擁有者：吳家豪申請銷售訂單，張美玲簽主管關，資料擁有者關改由上一層主管蘇慧敏簽', async () => {
    const { caseNo } = await apply('p12', {
        principal: 'ap-recon-bot',
        from: day(),
        to: day(2),
        packages: { sales_order: { fields: ['order_no', 'amount'], filters: { region: ['north'] } } },
        period: { from: '2026-01-01', to: '2026-06-30' },
        description: '應付帳款對帳',
    });
    const applicant = await loggedIn('p12');
    let c = await caseByNo(applicant, caseNo);
    assert.deepEqual(c.waiting_on, ['張美玲']);
    await decide('p11', caseNo);
    c = await caseByNo(applicant, caseNo);
    assert.equal(c.current_stage.code, 'data_owner');
    assert.deepEqual(c.waiting_on, ['蘇慧敏']);
    // 張美玲的待簽清單裡不再有這張單
    const owner = await loggedIn('p11');
    await home(owner);
    assert.equal(await owner.page.locator(`[data-testid=inbox-item][data-case-no="${caseNo}"]`).count(), 0);
    await decide('p10', caseNo);
    c = await caseByNo(applicant, caseNo);
    assert.equal(c.current_stage.code, 'mis');
    results.tests.sod_distinct = { case_no: caseNo, data_owner_stage: '蘇慧敏' };
});

test('K-RECALL 申請人在生效前撤回：要填原因並用通行金鑰確認，單回到申請人手上', async () => {
    const applicant = await loggedIn('p04');
    const { caseNo } = await apply('p04', l3({ principal: '日本業務部', description: '撤回測試' }));
    await openFromHome(applicant, caseNo);
    await applicant.page.waitForSelector('[data-testid=passkey-missing]');
    await ensurePasskey(applicant);
    await applicant.page.waitForSelector('[data-action=recall]');
    await decideHere(applicant, 'recall', '用途要重新確認');
    const c = await caseByNo(applicant, caseNo);
    assert.equal(c.state, 'returned');
    assert.ok(c.actions.includes('revise'));
    results.tests.recall = { case_no: caseNo, state: c.state, actions: c.actions };
});

test('K-PROGRAM-STALLED 排程停擺期間授權迄日過了：申請人的首頁與單的頁面顯示警示（資料庫算的 overdue），稽核首頁有背景程式的狀態', async () => {
    const admin = dbPool('ADMIN');
    const { rows } = await admin.query(
        `select g.case_id, c.case_no, g.valid_to::text as valid_to from sgn.grant_record g
         join sgn.request_case c on c.id = g.case_id join sgn.person_identity i on i.person_id = c.applicant_person_id
         where g.status = 'active' and i.external_id = 'p04' order by c.case_no limit 1`,
    );
    assert.equal(rows.length, 1, '前面的測試留下一張生效中的單');
    const [grant] = rows;
    const jobsPid = Number(readFileSync(join(RUN_DIR, 'jobs.pid'), 'utf8'));
    process.kill(jobsPid, 'SIGSTOP');
    try {
        // 測試準備：模擬「排程停擺期間過了迄日」
        await admin.query('update sgn.grant_record set valid_to = sgn_internal.today() - 1 where case_id = $1', [grant.case_id]);
        const applicant = await loggedIn('p04');
        await home(applicant);
        const card = applicant.page.locator(`[data-testid=mine-item][data-case-no="${grant.case_no}"] [data-testid=overdue]`);
        await card.waitFor();
        assert.equal(await card.getAttribute('data-kind'), 'grant_expiry');
        assert.match(await card.textContent(), /警示/);
        await applicant.page.goto(`${ORIGIN}/#case/${grant.case_id}`);
        await applicant.page.reload();
        await applicant.page.waitForSelector('[data-testid=overdue][data-kind=grant_expiry]');
        assert.match(await applicant.page.textContent('main [data-testid=overdue]'), /沒有在執行/);
        const layout = await layoutProblems(applicant.page, '逾期警示');
        const auditor = await loggedIn('p22');
        await home(auditor);
        await auditor.page.waitForSelector('[data-testid=program-health]');
        results.tests.overdue_warning = { case_no: grant.case_no, layout_problems: layout };
        assert.deepEqual(layout, []);
    } finally {
        // 還原迄日再讓排程繼續（後面的重疊測試要用這張生效中的單）
        await admin.query('update sgn.grant_record set valid_to = $2::date where case_id = $1', [grant.case_id, grant.valid_to]);
        process.kill(jobsPid, 'SIGCONT');
    }
});

test('尚未錨定：錨定程式暫停時，稽核畫面明確標示「尚未有外部摘要涵蓋」，不顯示驗證通過；恢復錨定後才通過', async () => {
    const auditor = await loggedIn('p22');
    const anchorPid = Number(readFileSync(join(RUN_DIR, 'anchor.pid'), 'utf8'));
    process.kill(anchorPid, 'SIGSTOP');
    let caseNo;
    try {
        caseNo = (await apply('p04', l3({ principal: '季度業績看板', to: day(2), description: '測試尚未錨定' }))).caseNo;
        await decide('p06', caseNo); // 第一關（代填時是被授權者負責人確認，D79 (2)）的決定

        await auditor.page.goto(`${ORIGIN}/#audit/${caseNo}`);
        await auditor.page.reload();
        await auditor.page.waitForSelector('[data-testid=audit-result]:not([data-status=pending])');
        assert.equal(await auditor.page.getAttribute('[data-testid=audit-result]', 'data-status'), 'warn');
        const headline = await auditor.page.textContent('[data-testid=audit-result]');
        assert.match(headline, /尚未有外部摘要涵蓋/);
        assert.doesNotMatch(headline, /驗證通過/);
        const marked = await auditor.page
            .locator('[data-testid=audit-events] li[data-anchored=false] [data-testid=unanchored]')
            .allTextContents();
        assert.ok(marked.length >= 3, `標示了 ${marked.length} 筆`);
        assert.ok(marked.every((text) => text === '尚未有外部摘要涵蓋'));
        results.tests.unanchored = { case_no: caseNo, marked_events: marked.length, headline };
    } finally {
        process.kill(anchorPid, 'SIGCONT');
    }
    assert.equal(await auditUntilAnchored(auditor, caseNo), 'ok');
    assert.equal(await auditor.page.locator('[data-testid=unanchored]').count(), 0);
});

/** 在角色指派頁提出一張變更（手機畫面）：填表 → 確認面板 → 用通行金鑰確認（提出也要金鑰，D68）。 */
async function proposeRole(p, holderName, role, change, reason) {
    await home(p);
    await p.page.click('[data-testid=open-roles]');
    await p.page.waitForSelector('[data-testid=role-change-form]');
    await ensurePasskey(p);
    await p.page.waitForSelector('[data-testid=role-change-form]');
    await p.page.selectOption('#holder_id', { label: holderName });
    await p.page.selectOption('#role_code', role);
    await p.page.selectOption('#change', change);
    await p.page.fill('#reason', reason);
    await p.page.click('[data-testid=role-change-submit]');
    assert.match(await p.page.textContent('[data-testid=consequence]'), new RegExp(holderName));
    return flashAfter(p.page, () => p.page.click('[data-testid=confirm-passkey]'));
}

/** 在角色指派頁用通行金鑰核准第一張可以核准的變更。 */
async function approveRole(p) {
    await home(p);
    await p.page.click('[data-testid=open-roles]');
    await p.page.waitForSelector('[data-testid=section-role-changes]');
    await ensurePasskey(p);
    await p.page.click('[data-testid=role-change-approve]');
    return flashAfter(p.page, () => p.page.click('[data-testid=confirm-passkey]'));
}

test('K-ROLE-SOURCE 稽核角色只能在平台內指派：鍾國強在手機上提出、白崇德用通行金鑰核准後才生效（K-AUDITOR-INDEPENDENT）', async () => {
    const head = await loggedIn('p21');
    const holder = await loggedIn('p08');
    const canAudit = async () => (await callApi(holder.page, '/api/me')).result.capabilities.includes('audit');
    assert.equal(await canAudit(), false);
    const proposed = await proposeRole(head, '何宗翰', 'auditor', 'grant', '稽核室新進人員');
    assert.equal(proposed.ok, true, proposed.text);
    const problems = await layoutProblems(head.page, '角色指派');
    assert.equal(await canAudit(), false, '提出之後、核准之前不生效');
    // 提出人自己的畫面沒有核准按鈕；直接打後端也被擋
    assert.equal(await head.page.locator('[data-testid=role-change-approve]').count(), 0);
    const [pending] = (await callApi(head.page, '/api/role_change_list')).result;
    const self = await callApi(head.page, '/api/role_change_challenge', { request_id: pending.request_id, decision: 'approve' });
    assert.equal(self.error.code, 'ROLE_CHANGE_SELF');
    const governor = await loggedIn('p28');
    const approved = await approveRole(governor);
    assert.equal(approved.ok, true, approved.text);
    assert.equal(await canAudit(), true);
    // 還原：撤除也走同一個流程
    assert.equal((await proposeRole(head, '何宗翰', 'auditor', 'revoke', '測試結束')).ok, true);
    assert.equal((await approveRole(governor)).ok, true);
    assert.equal(await canAudit(), false);
    assert.deepEqual(problems, []);
});

test('K-PASSKEY-ENROLL 第一把通行金鑰由主管背書：鄭雅文的新裝置顯示 12 位數核對碼，張美玲在自己的手機上輸入、頁面從指紋自己算一次，一樣才用通行金鑰核准；冷卻期內還不能做決定', async () => {
    const owner = await loggedIn('p11');
    const staff = await loggedIn('p13');
    // 鄭雅文沒有待簽的單：從她自己送出的申請單（撤回要通行金鑰）進去，畫面才有登記的提示
    const { caseNo } = await apply('p13', l3({ principal: '季度業績看板', description: '登記金鑰測試' }));
    await home(staff);
    await staff.page.click(`[data-case-no="${caseNo}"]`);
    await staff.page.waitForSelector('[data-testid=passkey-missing]');
    const { code } = await requestPasskeyInUi(staff);
    assert.match(code, /^\d{4} \d{4} \d{4}$/);
    const layout = await layoutProblems(staff.page, '待核准的通行金鑰');
    // 主管的首頁出現「待核准的通行金鑰登記」；從首頁開始數步數
    await home(owner);
    await ensurePasskey(owner);
    const steps = [];
    await owner.page.click('[data-testid=open-passkeys]');
    steps.push('點「待核准的通行金鑰登記」');
    await owner.page.waitForSelector('[data-testid=enrollment-item]');
    const item = owner.page.locator('[data-testid=enrollment-item]', { hasText: '鄭雅文' });
    layout.push(...(await layoutProblems(owner.page, '背書通行金鑰')));
    // 念錯一碼：頁面算出來的不一樣，不簽
    await item.locator('[data-testid=endorse-code]').fill(code.replace(/\d$/, (d) => String((Number(d) + 1) % 10)));
    await item.locator('[data-testid=endorse-check].bad').waitFor();
    assert.equal(await owner.page.locator('[data-testid=confirm-passkey]').count(), 0);
    await item.locator('[data-testid=endorse-code]').fill(code);
    steps.push('輸入本人念的核對碼（滿 12 位數，頁面自動從指紋算一次，約一秒）');
    await owner.page.waitForSelector('[data-testid=confirm-passkey]');
    assert.match(await owner.page.textContent('[data-testid=consequence]'), new RegExp(code));
    const done = await flashAfter(owner.page, () => owner.page.click('[data-testid=confirm-passkey]'));
    steps.push('按「用通行金鑰確認」');
    steps.push('裝置上的使用者驗證');
    assert.equal(done.ok, true, done.text);
    // 本人：金鑰已核准，冷卻期內畫面說明什麼時候生效，還不能做決定
    await staff.page.reload();
    await waitPage(staff.page);
    await staff.page.waitForSelector('[data-testid=passkey-cooling]');
    assert.equal(await staff.page.locator('[data-action=recall]').count(), 1, '按鈕依資料庫的 actions 顯示');
    results.tests.passkey_enroll = { code_matches: true, endorse_steps_from_home: steps.length, steps, layout_problems: layout };
    assert.ok(steps.length <= 4, `步數 ${steps.length}`);
    assert.deepEqual(layout, []);
});

/** 從首頁打開通行金鑰頁（待核准的登記、撤銷）。 */
async function openPasskeys(p) {
    await home(p);
    await p.page.click('[data-testid=open-passkey-manage]');
    await p.page.waitForSelector('[data-testid=section-revoke]');
}

test('K-PASSKEY-SUSPEND 渡邊翔只憑登入停用自己的全部金鑰（裁決 D84 (2)：不是撤銷）；找回裝置後用原來的金鑰申請、田中美咲背書才恢復（兩邊都從首頁數步數）', async () => {
    const boss = await loggedIn('p32');
    const staff = await loggedIn('p35');
    await openPasskeys(staff);
    assert.equal(await ensurePasskey(staff), true);
    // 只憑登入：停用
    await openPasskeys(staff);
    const mine = staff.page.locator('[data-testid=revocation-item]', { hasText: '渡邊翔' });
    await mine.locator('[data-testid=revoke-self]').click();
    assert.match(await staff.page.textContent('[data-testid=consequence]'), /立即停用.*原來的金鑰.*背書/);
    await staff.page.fill('[data-testid=revoke-reason]', '手機不見了');
    const suspended = await flashAfter(staff.page, () => staff.page.click('[data-testid=confirm-revoke]'));
    assert.equal(suspended.ok, true, suspended.text);
    const me = (await callApi(staff.page, '/api/me')).result;
    assert.deepEqual([me.passkeys, me.passkey_suspended], [0, 1]);
    const admin = dbPool('ADMIN');
    const mailed = await admin.query(
        `select i.external_id from sgn.notification_outbox n join sgn.person_identity i on i.person_id = n.person_id
         where n.event_code = 'passkey.suspended' and i.external_id in ('p35', 'p32') order by 1`,
    );
    assert.deepEqual(
        mailed.rows.map((r) => r.external_id),
        ['p32', 'p35'],
        '通知本人與主管',
    );
    const layout = [];
    // 本人找回裝置：從首頁開始數步數
    const selfSteps = [];
    await home(staff);
    await staff.page.click('[data-testid=open-passkey-restore-self]');
    selfSteps.push('首頁「用原來的金鑰申請恢復」');
    const row = staff.page.locator('[data-testid=suspension-item][data-status=suspended]', { hasText: '渡邊翔' });
    await row.waitFor();
    layout.push(...(await layoutProblems(staff.page, '停用中的通行金鑰（本人）')));
    await row.locator('[data-testid=restore]').click();
    selfSteps.push('按「用原來的金鑰申請恢復」');
    const requested = await flashAfter(staff.page, () => staff.page.click('[data-testid=confirm-passkey]'));
    selfSteps.push('按「用通行金鑰確認」');
    selfSteps.push('裝置上的使用者驗證');
    assert.equal(requested.ok, true, requested.text);
    assert.equal((await callApi(staff.page, '/api/me')).result.passkeys, 0, '本人簽了還不夠，要主管背書');
    // 主管：首頁出現「等你背書恢復的通行金鑰」
    await openPasskeys(boss);
    await ensurePasskey(boss);
    await home(boss);
    const bossSteps = [];
    await boss.page.click('[data-testid=open-passkey-restore]');
    bossSteps.push('首頁「等你背書恢復的通行金鑰」');
    const item = boss.page.locator('[data-testid=suspension-item][data-status=self_confirmed]', { hasText: '渡邊翔' });
    await item.waitFor();
    layout.push(...(await layoutProblems(boss.page, '背書恢復通行金鑰')));
    await item.locator('[data-testid=endorse-restore]').click();
    bossSteps.push('按「背書恢復渡邊翔的金鑰」');
    assert.match(await boss.page.textContent('[data-testid=consequence]'), /本人申請/);
    const restored = await flashAfter(boss.page, () => boss.page.click('[data-testid=confirm-passkey]'));
    bossSteps.push('按「用通行金鑰確認」');
    bossSteps.push('裝置上的使用者驗證');
    assert.equal(restored.ok, true, restored.text);
    assert.equal((await callApi(staff.page, '/api/me')).result.passkeys, 1, '恢復可用');
    console.log(`K-PASSKEY-SUSPEND 本人申請恢復：${selfSteps.length} 步（${selfSteps.join(' → ')}）`);
    console.log(`K-PASSKEY-SUSPEND 主管背書恢復：${bossSteps.length} 步（${bossSteps.join(' → ')}）`);
    results.tests.passkey_restore = {
        self_steps_from_home: selfSteps.length,
        endorse_steps_from_home: bossSteps.length,
        selfSteps,
        bossSteps,
        layout_problems: layout,
    };
    assert.ok(selfSteps.length <= 4 && bossSteps.length <= 4, `步數 ${selfSteps.length}、${bossSteps.length}`);
    assert.deepEqual(layout, []);
});

test('K-PASSKEY-REVOKE K-PASSKEY-RECOVERY 裝置真的遺失：田中美咲用自己的通行金鑰撤銷渡邊翔的全部金鑰；渡邊翔重新登記，撤銷的田中美咲不能背書（裁決 D88 (1)），由登記人葉佳蓉用手機掃新裝置畫面上的 QR 碼背書（掃到別的指紋不簽）；冷卻期加長、本人看得到「不是我登記的」', async () => {
    const boss = await loggedIn('p32');
    const keeper = await person(config.db.SGN_SEED_REGISTRAR_2);
    await fakeBarcodeDetector(keeper);
    await loggedIn(keeper.uid);
    await useInstalledRegistrarKey(keeper);
    const staff = await loggedIn('p35');
    await openPasskeys(boss);
    await ensurePasskey(boss);
    await openPasskeys(boss);
    const target = boss.page.locator('[data-testid=revocation-item]', { hasText: '渡邊翔' });
    await target.locator('[data-testid=revoke]').click();
    await boss.page.fill('[data-testid=revoke-reason]', '裝置確定遺失');
    const revoked = await flashAfter(boss.page, () => boss.page.click('[data-testid=confirm-passkey]'));
    assert.equal(revoked.ok, true, revoked.text);
    assert.equal((await callApi(staff.page, '/api/me')).result.passkeys, 0);
    // 重新登記：新裝置畫面上有 QR 碼（完整指紋）
    await openPasskeys(staff);
    await staff.page.reload();
    await waitPage(staff.page);
    const shown = await requestPasskeyInUi(staff);
    const layout = await layoutProblems(staff.page, '新裝置的 QR 碼');
    // 測試的「相機」：從新裝置畫面的 QR 碼讀出來的就是畫面上的完整指紋
    const seen = await readDeviceQr(staff.page);
    assert.equal(fingerprintFromPayload(seen), shown.fingerprint);
    // 撤銷的人（田中美咲）不能背書替換的金鑰：她的待核准清單裡沒有這一筆，直接打後端也被擋
    await boss.page.goto(`${ORIGIN}/#passkeys`);
    await boss.page.reload();
    await waitPage(boss.page);
    assert.equal(await boss.page.locator('[data-testid=enrollment-item]', { hasText: '渡邊翔' }).count(), 0);
    const pendingId = (await callApi(staff.page, '/api/me')).result.passkey_pending[0].enrollment_id;
    const blocked = await callApi(boss.page, '/api/passkey_endorse_challenge', { enrollment_id: pendingId, method: 'qr' });
    assert.equal(blocked.error?.code, 'PASSKEY_ENDORSER_REVOKER', JSON.stringify(blocked));
    // 登記人葉佳蓉：從首頁開始數步數
    await home(keeper);
    const steps = [];
    await keeper.page.click('[data-testid=open-passkeys]');
    steps.push('點「待核准的通行金鑰登記」');
    const item = keeper.page.locator('[data-testid=enrollment-item]', { hasText: '渡邊翔' });
    await item.waitFor();
    layout.push(...(await layoutProblems(keeper.page, '背書通行金鑰（掃描）')));
    // 掃到別的指紋（例如被入侵的後端換掉的金鑰）：警告，不簽
    await keeper.page.evaluate((text) => (window.__seenQr = text), fingerprintPayload('ab'.repeat(32)));
    await item.locator('[data-testid=endorse-scan]').click();
    await keeper.page.waitForSelector('[data-testid=scan-mismatch]');
    assert.equal(await keeper.page.locator('[data-testid=confirm-passkey]').count(), 0);
    await keeper.page.click('.sheet button');
    // 掃新裝置畫面上的 QR 碼
    await keeper.page.evaluate((text) => (window.__seenQr = text), seen);
    await item.locator('[data-testid=endorse-scan]').click();
    steps.push('按「當面掃描新裝置的 QR 碼」（相機對準，自動辨識）');
    await keeper.page.waitForSelector('[data-testid=confirm-passkey]');
    layout.push(...(await layoutProblems(keeper.page, '掃描後確認')));
    assert.match(await keeper.page.textContent('[data-testid=consequence]'), /完整指紋和這筆登記一致/);
    const done = await flashAfter(keeper.page, () => keeper.page.click('[data-testid=confirm-passkey]'));
    steps.push('按「用通行金鑰確認」');
    steps.push('裝置上的使用者驗證');
    assert.equal(done.ok, true, done.text);
    // 復原的金鑰（被別人撤銷之後登記的）：冷卻期加長，本人首頁的提示多一個「不是我登記的」
    await staff.page.reload();
    await waitPage(staff.page);
    await staff.page.waitForSelector('[data-testid=passkey-cooling] [data-testid=open-not-me]');
    const me = (await callApi(staff.page, '/api/me')).result;
    assert.equal(me.passkey_disownable, 1);
    const admin = dbPool('ADMIN');
    const recovery = await admin.query(
        `select x.detail from sgn.exception_record x join sgn.person_identity i on i.person_id::text = x.detail ->> 'person'
         where x.rule_code = 'K-PASSKEY-RECOVERY' and i.external_id = 'p35' order by x.id desc limit 1`,
    );
    assert.equal(recovery.rows.length, 1, '開了 K-PASSKEY-RECOVERY');
    results.tests.passkey_qr = { endorse_steps_from_home: steps.length, steps, layout_problems: layout };
    assert.ok(steps.length <= 4, `步數 ${steps.length}`);
    assert.deepEqual(layout, []);
});

test('K-PASSKEY-NOT-ME 渡邊翔的新金鑰（別人背書、冷卻期內）不是他登記的：從首頁只憑登入回報，金鑰立即撤銷（量步數）', async () => {
    const staff = await loggedIn('p35');
    const layout = [];
    const steps = [];
    await home(staff);
    await staff.page.click('[data-testid=open-not-me]');
    steps.push('首頁「這把新金鑰不是我登記的」');
    const item = staff.page.locator('[data-testid=not-me-item]');
    await item.waitFor();
    assert.match(await item.textContent(), /葉佳蓉/, '看得到是誰背書的');
    layout.push(...(await layoutProblems(staff.page, '冷卻期內的新金鑰')));
    await item.locator('[data-testid=not-me]').click();
    steps.push('按「不是我登記的」');
    assert.match(await staff.page.textContent('[data-testid=consequence]'), /立即撤銷/);
    layout.push(...(await layoutProblems(staff.page, '回報不是我登記的')));
    const done = await flashAfter(staff.page, () => staff.page.click('[data-testid=confirm-not-me]'));
    steps.push('按「確認撤銷這把金鑰」');
    assert.equal(done.ok, true, done.text);
    const me = (await callApi(staff.page, '/api/me')).result;
    assert.deepEqual([me.passkey_disownable, me.passkey_cooling_until], [0, null]);
    console.log(`K-PASSKEY-NOT-ME 本人回報：${steps.length} 步（${steps.join(' → ')}）`);
    results.tests.passkey_not_me = { steps_from_home: steps.length, steps, layout_problems: layout };
    assert.ok(steps.length <= 3, `步數 ${steps.length}`);
    assert.deepEqual(layout, []);
});

test('K-DISPLAY-SIGNED 紅隊第三輪 高-1：後端改寫目錄與單上的其他欄位，決定畫面不跟著變；改寫顯示摘要的任何一個字，簽章被拒', async () => {
    const { caseNo } = await apply('p04', l3({ principal: '季度業績看板', description: '顯示摘要端對端' }));
    await decide('p06', caseNo); // 代填：負責人確認先過，主管關才開（D79 (2)）
    const manager = await loggedIn('p03');
    await ensurePasskey(manager);
    const context = manager.page.context();
    let tamperDisplay = false;
    // 被入侵的後端（改寫回應；頁面程式沒動）：目錄的名稱、case_get 的級別、例外、名字；第二階段連顯示摘要也改
    await context.route(`${API}/api/data_access_catalog`, async (route) => {
        const response = await route.fetch();
        const cat = await response.json();
        for (const pkg of cat.result.packages) pkg.name = `改名的${pkg.name}`;
        await route.fulfill({ response, json: cat });
    });
    await context.route(`${API}/api/case_get`, async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        if (body.result?.case_no === caseNo) {
            Object.assign(body.result, { tier: 'L2', exceptions: [], applicant_name: '王志明' });
            if (tamperDisplay) body.result.display.content.scope[0].package_name = '銷售訂單（假）';
        }
        await route.fulfill({ response, json: body });
    });
    try {
        await openFromHome(manager, caseNo);
        const facts = await manager.page.textContent('[data-testid=decision-facts]');
        assert.match(facts, /客戶主檔/);
        assert.match(facts, /林怡君/);
        assert.ok(!facts.includes('改名的') && !facts.includes('王志明'), '畫面只從顯示摘要畫');
        assert.equal(await manager.page.textContent('[data-testid=tier]'), 'L3');
        // 連顯示摘要也改：畫面照改過的畫，簽下去資料庫用自己的資料重算，對不上
        tamperDisplay = true;
        await manager.page.reload();
        await waitPage(manager.page);
        assert.match(await manager.page.textContent('[data-testid=decision-facts]'), /銷售訂單（假）/);
        await manager.page.click('[data-action=approve]');
        await manager.page.click('[data-testid=confirm-passkey]');
        await manager.page.waitForSelector('[data-testid=decision-error]:not([hidden])');
        assert.match(await manager.page.textContent('[data-testid=decision-error]'), /簽的內容和資料庫的紀錄不符/);
        assert.equal((await caseByNo(manager, caseNo, '/api/inbox_list')).state, 'in_approval');
    } finally {
        await context.unroute(`${API}/api/data_access_catalog`);
        await context.unroute(`${API}/api/case_get`);
    }
    // 誠實的畫面：核准成立
    await openFromHome(manager, caseNo);
    await decideHere(manager, 'approve');
    results.tests.display_signed = { case_no: caseNo, tampered_display_rejected: true };
});

test('D68 頁面與後端分開來源：頁面帶 CSP、後端只回 JSON；網址上的 ?error= 只收錯誤代碼（D71）', async () => {
    const page = await (await person('p26')).page;
    const pageResponse = await page.goto(`${ORIGIN}/`);
    const csp = pageResponse.headers()['content-security-policy'];
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, new RegExp(`connect-src 'self' ${API}`));
    // 後端不送頁面：舊網址導回頁面的來源，任意文字的 error 被丟掉
    const back = await fetch(`${API}/?error=${encodeURIComponent('請改到 https://evil.example 重新登入')}`, { redirect: 'manual' });
    assert.equal(back.status, 302);
    assert.equal(back.headers.get('location'), `${ORIGIN}/`);
    assert.equal((await fetch(`${API}/index.html`)).status, 404);
    // 頁面直接帶任意文字：不顯示；帶錯誤代碼：顯示錯誤目錄的文字
    await page.goto(`${ORIGIN}/?error=${encodeURIComponent('系統升級中，請改到 https://evil.example')}`);
    await page.waitForSelector('[data-testid=login]');
    assert.equal(await page.isVisible('#flash'), false);
    await page.goto(`${ORIGIN}/?error=LOGIN_FLOW_INVALID`);
    await page.waitForSelector('#flash:not([hidden])');
    assert.match(await page.textContent('#flash'), /登入流程已逾時或無效/);
    // 別的來源帶 cookie 打後端：CORS 只開給頁面的來源，會改狀態的請求被拒
    const forged = await fetch(`${API}/api/me`, {
        method: 'POST',
        headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
        body: '{}',
    });
    assert.equal(forged.status, 403);
    results.tests.frontdoor = { csp };
});

test('K-SESSION 登出：資料庫裡的工作階段失效，留下來的 cookie 再也打不開任何功能', async () => {
    const p = await person('p05');
    await login(p);
    const [sid] = (await p.page.context().cookies()).filter((c) => c.name === 'sid');
    assert.ok(sid?.value);
    await p.page.click('text=登出');
    await p.page.waitForSelector('[data-testid=login]');
    // 攻擊者手上留著登出前的 cookie：換一個乾淨的瀏覽器環境帶著它打後端
    const replay = await theBrowser().newContext();
    await replay.addCookies([{ name: 'sid', value: sid.value, url: API }]);
    const page = await replay.newPage();
    await page.goto(ORIGIN);
    const res = await callApi(page, '/api/me');
    assert.equal(res.status, 401);
    assert.equal(res.error.code, 'SESSION_INVALID');
    await replay.close();
    results.tests.logout = { replayed_status: res.status, code: res.error.code };
});

// 放在最後：竄改期間錨定程式若剛好重算到被改的那一筆，會依設計停下來，不能影響其他測試。
test('K-AUDIT-CHAIN 稽核驗證抓得到竄改：資料庫最高權限者改了核准紀錄，稽核畫面顯示驗證失敗；改回後恢復通過', async () => {
    const auditor = await loggedIn('p22');
    const psql = (sql) =>
        execFileSync('psql', ['-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', adminUrl(config), '-c', sql])
            .toString()
            .trim();
    const seq = psql(
        `select min(e.seq) from sgn.audit_event e join sgn.request_case c on c.id = e.case_id where c.case_no = ${mainCaseNo} and e.event_type = 'case.approve'`,
    );
    const original = psql(`select encode(body, 'base64') from sgn.audit_event where seq = ${seq}`).replaceAll('\n', '');
    await auditor.page.goto(`${ORIGIN}/#audit/${mainCaseNo}`);
    await auditor.page.reload();
    await waitPage(auditor.page);
    // session_replication_role = replica 讓 trigger 不觸發，又不會改到 trigger 的啟用狀態（程式指紋不變）
    psql(`set session_replication_role = replica;
          update sgn.audit_event set body = convert_to(replace(convert_from(body, 'UTF8'), '"passkey"', '"idp_stepup"'), 'UTF8') where seq = ${seq}`);
    try {
        await auditor.page.click('text=重新驗證');
        await auditor.page.waitForSelector('[data-testid=audit-result]:not([data-status=pending])');
        const status = await auditor.page.getAttribute('[data-testid=audit-result]', 'data-status');
        const problems = await auditor.page.locator('[data-testid=audit-problems] li').allTextContents();
        results.tests.tamper = { seq: Number(seq), status, problems };
        assert.equal(status, 'bad');
        assert.ok(
            problems.some((p) => p.includes(`第 ${seq} 筆`)),
            problems.join('；'),
        );
    } finally {
        psql(`set session_replication_role = replica;
              update sgn.audit_event set body = decode('${original}', 'base64') where seq = ${seq}`);
    }
    await auditor.page.click('text=重新驗證');
    await auditor.page.waitForSelector('[data-testid=audit-result][data-status=ok]');
});
