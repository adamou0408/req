// 端對端：最窄的完整路徑。真的 Dex 登入頁、真的 WebAuthn（Chromium + CDP 虛擬驗證器）、390px 寬。
// 前提：sim（ldap、idp）、探針資料庫、錨定程式（每 2 秒）、後端都在跑 —— 由 probe/run-all.sh 啟動。
import assert from 'node:assert/strict';
import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { adminUrl, loadConfig } from '../../db/tools/lib/env.mjs';

const { chromium } = await import(`${execSync('npm root -g').toString().trim()}/playwright/index.mjs`);
const config = loadConfig();
const ORIGIN = config.probe.PROBE_RP_ORIGIN;
const PASSWORD = config.ldap.SIM_LDAP_USER_PASSWORD;
const RUN_DIR = join(import.meta.dirname, '..', '..', '.run');
const results = { measured_at: new Date().toISOString(), viewport: '390x844', tests: {} };

let browser;
const people = {};

before(async () => {
    browser = await chromium.launch();
});
after(async () => {
    await browser?.close();
    mkdirSync(RUN_DIR, { recursive: true });
    writeFileSync(join(RUN_DIR, 'e2e-results.json'), `${JSON.stringify(results, null, 2)}\n`);
});

/** 一個人一個瀏覽器環境（手機尺寸），各自帶一個虛擬通行金鑰驗證器。 */
async function person(uid) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'zh-TW' });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true },
    });
    const p = { uid, page, cdp, authenticatorId };
    people[uid] = p;
    return p;
}

/** 走真的 Dex 登入頁。 */
async function dexLogin(page, uid) {
    await page.waitForURL(/127\.0\.0\.1:5556\/dex/);
    await page.fill('#login', uid);
    await page.fill('#password', PASSWORD);
    await page.click('#submit-login');
    await page.waitForURL(`${ORIGIN}/**`);
}

async function login(p) {
    await p.page.goto(ORIGIN);
    await p.page.click('[data-testid=login]');
    await dexLogin(p.page, p.uid);
    await p.page.waitForSelector('[data-testid=me]');
}

/** 在頁面裡直接打後端（模擬「拿到工作階段的人」繞過畫面）。 */
async function callApi(page, path, body = {}) {
    return page.evaluate(
        async ({ path, body }) => {
            const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
            return { status: r.status, ...(await r.json()) };
        },
        { path, body },
    );
}

/** 手機版面的自動檢查：沒有水平捲動、可點擊元素至少 44×44。 */
async function layoutProblems(page, label) {
    const problems = await page.evaluate(() => {
        const out = [];
        if (document.documentElement.scrollWidth > window.innerWidth) out.push(`水平捲動 ${document.documentElement.scrollWidth}px`);
        for (const node of document.querySelectorAll('button, input, select, textarea, a')) {
            const r = node.getBoundingClientRect();
            if (r.width > 0 && (r.width < 44 || r.height < 44)) out.push(`${node.tagName} "${node.textContent.trim().slice(0, 12)}" ${r.width}x${r.height}`);
        }
        return out;
    });
    return problems.map((p) => `${label}: ${p}`);
}

async function submitCase(p, content) {
    await p.page.fill('#f-dataset', content.dataset);
    await p.page.fill('#f-purpose', content.purpose);
    const before = await p.page.textContent('#flash');
    await p.page.click('[data-testid=apply-form] button[type=submit]');
    await p.page.waitForFunction((prev) => {
        const box = document.querySelector('#flash.ok');
        return box && !box.hidden && box.textContent !== prev;
    }, before);
    const text = await p.page.textContent('#flash');
    return { caseNo: Number(/單號 (\d+)/.exec(text)[1]), text };
}

let mainCaseNo;

test('路徑：林怡君送出申請 → 陳建宏用通行金鑰核准 → 黃淑芬看到完整紀錄且驗證通過', async () => {
    const layout = [];
    // 林怡君（p04）
    const applicant = await person('p04');
    await login(applicant);
    layout.push(...(await layoutProblems(applicant.page, '申請人首頁')));
    const submitted = await submitCase(applicant, { dataset: '北區客戶交易明細（去識別）', purpose: '北區客戶流失分析' });
    mainCaseNo = submitted.caseNo;
    assert.match(submitted.text, /陳建宏/);
    const mine = applicant.page.locator(`[data-testid=mine-item][data-case-no="${mainCaseNo}"]`);
    assert.equal(await mine.locator('[data-testid=state]').textContent(), '待簽核');

    // 陳建宏（p03）：第一次要先登記通行金鑰（瀏覽器建立金鑰 → Dex 再驗證一次 → 資料庫登記）
    const manager = await person('p03');
    await login(manager);
    await manager.page.waitForSelector('[data-testid=passkey-missing]');
    await manager.page.click('text=登記通行金鑰');
    await dexLogin(manager.page, 'p03');
    await manager.page.waitForSelector('#flash.ok');
    assert.equal(await manager.page.locator('[data-testid=passkey-missing]').count(), 0);
    layout.push(...(await layoutProblems(manager.page, '簽核人首頁（待簽清單）')));

    // 從待簽清單開始數步數。驗證器的生物辨識在真機上是一步，這裡由虛擬驗證器自動通過，照樣算一步。
    const steps = [];
    await manager.page.click(`[data-testid=inbox-item][data-case-no="${mainCaseNo}"]`);
    steps.push('點待簽清單裡的單');
    layout.push(...(await layoutProblems(manager.page, '簽核詳情')));
    await manager.page.click('[data-action=approve]');
    steps.push('按「核准」');
    await manager.page.waitForSelector('[data-testid=confirm-passkey]');
    layout.push(...(await layoutProblems(manager.page, '核准確認')));
    const t0 = performance.now();
    await manager.page.click('[data-testid=confirm-passkey]');
    steps.push('按「用通行金鑰確認」');
    steps.push('裝置上的使用者驗證（指紋／臉部／PIN；虛擬驗證器自動通過）');
    await manager.page.waitForSelector('#flash.ok');
    const decideMs = performance.now() - t0;
    assert.match(await manager.page.textContent('#flash'), /已核准/);
    assert.equal(await manager.page.locator(`[data-testid=inbox-item][data-case-no="${mainCaseNo}"]`).count(), 0);

    // 黃淑芬（p22）：查這張單，驗證整條鏈、外部錨點與核准的簽章
    const auditor = await person('p22');
    await login(auditor);
    await auditor.page.fill('#f-case-no', String(mainCaseNo));
    await auditor.page.click('text=查詢');
    const result = auditor.page.locator('[data-testid=audit-result]');
    const tAnchor = performance.now();
    // 核准剛寫進鏈，要等錨定程式下一次把它寫到資料庫以外；之前畫面會顯示「還沒有寫進外部錨點」。
    let status;
    let sawUnanchored = false;
    for (;;) {
        await auditor.page.waitForSelector('[data-testid=audit-result]:not([data-status=pending])');
        status = await result.getAttribute('data-status');
        sawUnanchored ||= status === 'warn';
        if (status !== 'warn' || performance.now() - tAnchor > 30000) break;
        await auditor.page.click('text=重新驗證');
    }
    const anchorWaitMs = performance.now() - tAnchor;
    assert.equal(status, 'ok', await result.textContent());
    const tVerify = performance.now();
    await auditor.page.click('text=重新驗證');
    await auditor.page.waitForSelector('[data-testid=audit-result][data-status=ok]');
    const verifyMs = performance.now() - tVerify;
    const types = await auditor.page.locator('[data-testid=audit-events] li').evaluateAll((lis) => lis.map((li) => li.dataset.type));
    for (const type of ['passkey.registered', 'case.created', 'case.submitted', 'case.approve']) assert.ok(types.includes(type), type);
    assert.match(await auditor.page.textContent('[data-testid=audit-events] li[data-type="case.approve"]'), /陳建宏.*通行金鑰簽章/);
    layout.push(...(await layoutProblems(auditor.page, '稽核證據頁')));

    results.tests.main = {
        case_no: mainCaseNo,
        approver_steps_from_inbox: steps.length,
        approver_steps: steps,
        decide_ms: Math.round(decideMs),
        anchor_wait_ms: Math.round(anchorWaitMs),
        auditor_saw_unanchored_warning: sawUnanchored,
        auditor_verify_ms: Math.round(verifyMs),
        layout_problems: layout,
    };
    assert.ok(steps.length <= 4, `步數 ${steps.length} 超過 T2 上限 4`);
    assert.deepEqual(layout, []);
});

test('林怡君不能核准自己的單', async () => {
    const applicant = people.p04;
    await applicant.page.reload();
    await applicant.page.waitForSelector('[data-testid=section-mine]');
    // 畫面：她沒有待簽清單，自己的單上沒有任何決定按鈕（依資料庫回傳的 capabilities 與 actions）
    assert.equal(await applicant.page.locator('[data-testid=section-inbox]').count(), 0);
    const own = await submitCase(applicant, { dataset: '自己的單', purpose: '測試自己核准' });
    assert.equal(await applicant.page.locator(`[data-testid=mine-item][data-case-no="${own.caseNo}"] [data-action]`).count(), 0);
    // 繞過畫面直接打後端：資料庫拒絕發挑戰值，沒有挑戰值就簽不了
    const mine = await callApi(applicant.page, '/api/case_list_mine');
    const caseId = mine.result.find((c) => c.case_no === own.caseNo).case_id;
    const res = await callApi(applicant.page, '/api/challenge_issue', { case_id: caseId, decision: 'approve' });
    assert.equal(res.status, 403);
    assert.equal(res.error.code, 'SELF_APPROVAL');
    assert.equal(res.error.message, '申請人不能核准自己的申請');
    // 她也查不了稽核紀錄
    const audit = await callApi(applicant.page, '/api/audit_case', { case_no: own.caseNo });
    assert.equal(audit.error.code, 'AUDITOR_REQUIRED');
    results.tests.self_approval = { case_no: own.caseNo, response: res };
});

test('沒有通行金鑰的證明就核准不了', async () => {
    const applicant = people.p04;
    const manager = people.p03;
    const pending = await submitCase(applicant, { dataset: '南區門市營收', purpose: '測試沒有證明' });
    const caseId = (await callApi(applicant.page, '/api/case_list_mine')).result.find((c) => c.case_no === pending.caseNo).case_id;
    await manager.page.reload();
    await manager.page.waitForSelector(`[data-testid=inbox-item][data-case-no="${pending.caseNo}"]`);
    const outcomes = {};

    // 1. 沒有任何「只憑登入就核准」的路由
    outcomes.no_route = (await callApi(manager.page, '/api/case_decide_idp', { case_id: caseId })).status;
    assert.equal(outcomes.no_route, 404);

    // 2. 有挑戰值、但證明是空的
    const ch = (await callApi(manager.page, '/api/challenge_issue', { case_id: caseId, decision: 'approve' })).result;
    const empty = await callApi(manager.page, '/api/case_decide_passkey', { challenge_id: ch.challenge_id, decision: 'approve' });
    outcomes.empty_proof = empty.error.code;
    assert.notEqual(empty.status, 200);

    // 3. 用一把沒登記的金鑰對挑戰值簽章（格式完全正確的 WebAuthn assertion）
    // 4. 用主管登記過的憑證 id，配上別的金鑰的簽章
    const { credentials } = await manager.cdp.send('WebAuthn.getCredentials', { authenticatorId: manager.authenticatorId });
    const registeredId = Buffer.from(credentials[0].credentialId, 'base64').toString('base64url');
    const forged = await manager.page.evaluate(async ({ challenge, registeredId }) => {
        const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
        const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
        const clientData = new TextEncoder().encode(JSON.stringify({ type: 'webauthn.get', challenge, origin: location.origin }));
        const rpHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(location.hostname)));
        const authData = new Uint8Array([...rpHash, 0x05, 0, 0, 0, 9]);
        const clientHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientData));
        const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, new Uint8Array([...authData, ...clientHash])));
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
    }, { challenge: ch.challenge, registeredId });
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
    await manager.page.click(`[data-testid=inbox-item][data-case-no="${pending.caseNo}"]`);
    await manager.page.click('[data-action=approve]');
    await manager.page.click('[data-testid=confirm-passkey]');
    await manager.page.waitForSelector('#flash:not(.ok):not([hidden])', { timeout: 70000 });
    outcomes.ui_without_user_verification = await manager.page.textContent('#flash');
    await manager.cdp.send('WebAuthn.setUserVerified', { authenticatorId: manager.authenticatorId, isUserVerified: true });

    // 單仍然待簽核
    const after = await callApi(applicant.page, '/api/case_list_mine');
    assert.equal(after.result.find((c) => c.case_no === pending.caseNo).state, 'submitted');
    results.tests.no_proof = { case_no: pending.caseNo, outcomes };
});

test('稽核驗證抓得到竄改：資料庫最高權限者改了核准紀錄，稽核畫面顯示驗證失敗；改回後恢復通過', async () => {
    const auditor = people.p22;
    const psql = (sql) => execFileSync('psql', ['-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', adminUrl(config), '-c', sql]).toString().trim();
    const seq = psql(
        `select e.seq from sgn.audit_event e join sgn.request_case c on c.id = e.case_id where c.case_no = ${mainCaseNo} and e.event_type = 'case.approve'`,
    );
    const original = psql(`select encode(body, 'base64') from sgn.audit_event where seq = ${seq}`).replaceAll('\n', '');
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
        assert.ok(problems.some((p) => p.includes(`第 ${seq} 筆`)), problems.join('；'));
    } finally {
        psql(`set session_replication_role = replica;
              update sgn.audit_event set body = decode('${original}', 'base64') where seq = ${seq}`);
    }
    await auditor.page.click('text=重新驗證');
    await auditor.page.waitForSelector('[data-testid=audit-result][data-status=ok]');
});
