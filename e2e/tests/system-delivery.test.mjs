// 端對端：核准之後的系統對系統交付（裁決 D63），對著真的 sim/dc（把規則套用成真正資料庫權限的 DC 模擬器）。
// 申請 → 各關核准（畫面、通行金鑰）→ 交付程式（api/src/delivery.ts，背景每秒一輪）自動套用 → 自動驗證 → 生效，沒有人工執行；
// 撤銷 → 外部系統裡的權限消失；後門多給權限 → 對帳（api/src/reconciler.ts）開例外；外部系統停掉 → 重送，恢復後送達；
// 交付內容被竄改 → 外部系統拒絕、平台開例外。
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
import { ORIGIN, apply, callApi, caseByNo, day, decide, home, layoutProblems, loggedIn, startBrowser, stopBrowser } from './lib/ui.mjs';

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

/**
 * 這個人在前面的測試檔（path.test.mjs）已經在手機上登記過通行金鑰：把同一把金鑰放回這個行程的虛擬驗證器（同一支手機），
 * 不另外登記。前面沒登記過的人，decide 會照常在畫面上登記（ensurePasskey）。
 */
const savedKeys = () => {
    try {
        return JSON.parse(readFileSync(join(RUN_DIR, `passkeys-${config.database}.json`), 'utf8'));
    } catch {
        return {};
    }
};
async function signer(uid) {
    const p = await loggedIn(uid);
    if (p.keyRestored) return p;
    const me = (await callApi(p.page, '/api/me')).result;
    const saved = savedKeys()[me.person_id];
    if (saved?.privateKeyPkcs8) {
        await p.cdp.send('WebAuthn.addCredential', {
            authenticatorId: p.authenticatorId,
            credential: {
                credentialId: Buffer.from(saved.credentialId, 'base64url').toString('base64'),
                isResidentCredential: true,
                rpId: config.db.SGN_RP_ID,
                privateKey: saved.privateKeyPkcs8,
                userHandle: Buffer.from(me.person_id.replaceAll('-', ''), 'hex').toString('base64'),
                signCount: Math.floor((Date.now() - 1.7e12) / 100),
            },
        });
    }
    p.keyRestored = true;
    return p;
}

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
const inScope = (year) => ({
    package: 'sales_order',
    fields: ['amount', 'order_date', 'order_no'],
    row: { region: 'north' },
    data_date: `${year}-03-01`,
    action: 'query',
    as_of: day(),
});

let revokeCaseNo;

test('K-DELIVERY-AUTO 端對端（真的 sim/dc）：申請 → 各關核准 → 自動交付 → 自動驗證 → 生效，全程沒有人工執行步驟；外部系統上範圍內查得到、範圍外查不到', async () => {
    const { caseNo } = await apply('p04', spec(2024));
    revokeCaseNo = caseNo;
    await approveAll(caseNo);
    const applicant = await loggedIn('p04');
    const c = await waitCase(applicant, caseNo, (x) => x.state === 'active', '生效');
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
    const c = await waitCase(applicant, caseNo, (x) => x.state === 'active', '生效');
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
    const c = await waitCase(applicant, caseNo, (x) => x.state === 'active', '恢復後生效');
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
