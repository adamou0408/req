// 端對端：資料授權的完整簽核流程。真的 Dex 登入頁、真的 WebAuthn（Chromium + CDP 虛擬驗證器）、390px 寬。
// 前提：sim（ldap、idp）、端對端用的資料庫（SGN_DATABASE）、錨定程式（每 2 秒）、後端都在跑 —— 由 tools/run-all.sh 啟動。
// 測試依序執行、共用同一個資料庫：前面的測試產生的有效授權，後面的重疊測試會用到。竄改測試必須放在最後。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { RUN_DIR, adminUrl, loadConfig } from '../../db/tools/lib/env.mjs';
import {
    ORIGIN,
    apply,
    callApi,
    caseByNo,
    checkSettled,
    day,
    decide,
    decideHere,
    ensurePasskey,
    fillApplication,
    flashAfter,
    home,
    layoutProblems,
    loggedIn,
    openFromHome,
    openNew,
    person,
    login,
    startBrowser,
    stopBrowser,
    submitForm,
    theBrowser,
    waitPage,
} from './lib/ui.mjs';

const config = loadConfig();
const results = { measured_at: new Date().toISOString(), viewport: '390x844', tests: {} };

before(startBrowser);
after(async () => {
    await stopBrowser();
    mkdirSync(RUN_DIR, { recursive: true });
    writeFileSync(join(RUN_DIR, 'e2e-results.json'), `${JSON.stringify(results, null, 2)}\n`);
});

/** 林怡君的 L3 申請：客戶主檔（北、中區）＋銷售訂單（北區、2025 年）。 */
const l3 = (overrides = {}) => ({
    principal: '北區客戶流失分析',
    from: day(),
    to: day(3),
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
    for (const text of ['林怡君', '北區客戶流失分析', '客戶主檔', '銷售訂單', day(3), '沒有前一版', '沒有和有效授權重疊'])
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
    assert.match(await decideHere(custodian, 'fulfil'), /授權生效/);
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
    const caseId = (await caseByNo(applicant, pending.caseNo)).case_id;
    const outcomes = {};

    // 1. 沒有任何「只憑登入就核准」的路由
    outcomes.no_route = (await callApi(manager.page, '/api/case_decide_idp', { case_id: caseId })).status;
    assert.equal(outcomes.no_route, 404);

    // 2. 有挑戰值、但證明是空的
    const ch = (await callApi(manager.page, '/api/challenge_issue', { case_id: caseId, decision: 'approve', input: {} })).result;
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
        { challenge: ch.challenge, registeredId },
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
        to: day(5),
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
    const { caseNo } = await apply('p04', l3({ principal: '業務分析部', to: day(4), description: '縮小測試' }));
    await decide('p03', caseNo);
    const owner = await loggedIn('p11');
    await home(owner);
    const steps = [];
    const layout = [];
    await owner.page.click(`[data-testid=inbox-item][data-case-no="${caseNo}"]`);
    steps.push('點待簽清單裡的單');
    await owner.page.waitForSelector('[data-testid=decision-facts]');
    assert.match(await owner.page.textContent('[data-testid=validity]'), new RegExp(day(4)));
    await owner.page.click('[data-action=approve_reduced]');
    steps.push('按「縮小後核准」');
    layout.push(...(await layoutProblems(owner.page, '縮小後核准')));
    await owner.page.fill('[data-testid=reduce-valid-to]', day(2));
    steps.push('改授權迄日');
    await owner.page.click('[data-testid=reduce-submit]');
    steps.push('按「縮小後核准」（送出縮小內容）');
    await owner.page.click('[data-testid=confirm-passkey]');
    steps.push('按「用通行金鑰確認」');
    steps.push('裝置上的使用者驗證');
    await owner.page.waitForSelector('#flash.ok:not([hidden])');
    const c = await caseByNo(applicant, caseNo);
    assert.equal(c.terms.valid_to, day(2));
    assert.deepEqual(c.versions.map((v) => [v.change_kind, v.created_by_name]).at(-1), ['reduce', '張美玲']);
    assert.equal(c.stages.find((s) => s.code === 'manager').status, 'done', '主管不用重簽');
    // 申請人：詳情頁看得到誰縮小了什麼
    await openFromHome(applicant, caseNo);
    assert.match(await applicant.page.textContent('[data-testid=reduced-by]'), /張美玲 縮小了申請內容/);
    assert.match(await applicant.page.textContent('[data-testid=diff]'), new RegExp(`授權迄日：${day(4)} → ${day(2)}`));
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
    await decide('p03', caseNo);
    // 張美玲退回並填原因：數步數（T4）
    const owner = await loggedIn('p11');
    await home(owner);
    const steps = [];
    await owner.page.click(`[data-testid=inbox-item][data-case-no="${caseNo}"]`);
    steps.push('點待簽清單裡的單');
    await owner.page.waitForSelector('[data-testid=decision-facts]');
    await owner.page.click('[data-action=return]');
    steps.push('按「退回」');
    assert.match(await owner.page.textContent('[data-testid=consequence]'), /只做縮小會從你這一關繼續/);
    await owner.page.fill('[data-testid=decision-reason]', '銷售訂單只能給北區，客戶主檔請拿掉');
    steps.push('填原因');
    await owner.page.click('[data-testid=confirm-passkey]');
    steps.push('按「用通行金鑰確認」');
    steps.push('裝置上的使用者驗證');
    await owner.page.waitForSelector('#flash.ok:not([hidden])');
    assert.equal((await caseByNo(applicant, caseNo)).state, 'returned');

    // 申請人只做縮小（拿掉客戶主檔）→ 從資料擁有者關繼續，只剩銷售訂單的擁有者
    await openFromHome(applicant, caseNo);
    await applicant.page.click('[data-action=revise]');
    await applicant.page.waitForSelector('[data-testid=returned-note]');
    assert.match(await applicant.page.textContent('[data-testid=returned-note]'), /張美玲.*銷售訂單只能給北區/);
    for (const f of ['customer_id', 'customer_name']) await applicant.page.uncheck(`#f-customer_master-f-${f}`);
    await checkSettled(applicant.page);
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
    await applicant.page.fill('#f-purpose-text', '退回測試（補充用途：每月檢視北區訂單）');
    await checkSettled(applicant.page);
    await submitForm(applicant);
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
    await applicant.page.check('#f-sales_order-f-customer_id');
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
        to: day(3),
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

test('尚未錨定：錨定程式暫停時，稽核畫面明確標示「尚未有外部摘要涵蓋」，不顯示驗證通過；恢復錨定後才通過', async () => {
    const auditor = await loggedIn('p22');
    const anchorPid = Number(readFileSync(join(RUN_DIR, 'anchor.pid'), 'utf8'));
    process.kill(anchorPid, 'SIGSTOP');
    let caseNo;
    try {
        caseNo = (await apply('p04', l3({ principal: '季度業績看板', to: day(2), description: '測試尚未錨定' }))).caseNo;
        await decide('p03', caseNo);
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

test('K-SESSION 登出：資料庫裡的工作階段失效，留下來的 cookie 再也打不開任何功能', async () => {
    const p = await person('p05');
    await login(p);
    const [sid] = (await p.page.context().cookies()).filter((c) => c.name === 'sid');
    assert.ok(sid?.value);
    await p.page.click('text=登出');
    await p.page.waitForSelector('[data-testid=login]');
    // 攻擊者手上留著登出前的 cookie：換一個乾淨的瀏覽器環境帶著它打後端
    const replay = await theBrowser().newContext();
    await replay.addCookies([{ name: 'sid', value: sid.value, url: ORIGIN }]);
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
