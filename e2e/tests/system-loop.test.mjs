// 端對端：核准內容 → 使用方系統的閉環（裁決 D92；docs/handoff/closed-loop-1.md），對著真的 sim/dc 與背景程式。
//   目錄版本：簽核畫面上看得到綁定的資料目錄版本；交付程式送出的規則帶它，sim/dc 在已簽的回應裡回報它用的版本。
//   能力落差：受管系統宣告做不到的限制，簽核人在決定畫面上看得到（簽到的內容包含它）。
//   使用紀錄：實際操作的人經 sim/dc 查詢 → 對帳程式拉批次摘要 → 單的頁面顯示最後使用時間與次數。
//   目錄只改名稱：資料擁有者在手機首頁確認意義沒變（步數）。
// 排在 system-delivery.test.mjs 之後（檔名排序）；那個檔案把資料中心設回系統對系統。這裡改了目錄就在結束前載回種子的目錄。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { pool as dbPool, setSetting } from '../../db/tests/kernel/lib/harness.mjs';
import { DB_DIR, loadConfig } from '../../db/tools/lib/env.mjs';
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
const SEED = JSON.parse(/\$json\$([\s\S]*)\$json\$/.exec(readFileSync(join(DB_DIR, 'seed/packs/data_access/010_catalog.sql'), 'utf8'))[1]);
const load = async (snapshot) => (await admin.query('select pack_data_access.catalog_load($1) as r', [snapshot])).rows[0].r;

before(async () => {
    await startBrowser();
    await setSetting(admin, 'delivery.mode', 'system', 'system:dc');
    await setSetting(admin, 'delivery.retry_base_seconds', 1, 'channel:dc');
    await setSetting(admin, 'delivery.stuck_alert_seconds', 3600, 'channel:dc');
});
after(async () => {
    await setSetting(admin, 'data_access.capability.row', true, 'system:dc');
    await load(SEED);
    await stopBrowser();
});

const spec = (year) => ({
    principal: 'sales-report-bot',
    from: day(),
    to: day(2),
    packages: { sales_order: { fields: ['order_no', 'amount', 'order_date'], filters: { region: ['north'] } } },
    period: { from: `${year}-01-01`, to: `${year}-12-31` },
    purpose: 'reporting',
    description: `閉環端對端 ${year}`,
});

async function waitCase(p, caseNo, until, label, ms = 90000) {
    let c;
    for (const started = performance.now(); performance.now() - started < ms; ) {
        c = await caseByNo(p, caseNo);
        if (until(c)) return c;
        await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`${label}：等不到（state=${c?.state}，usage=${JSON.stringify(c?.usage)}）`);
}

let activeCaseNo;

test('DA-CATALOG-BOUND K-USAGE-ATTESTED 端對端：簽核畫面顯示綁定的目錄版本；sim/dc 回報同一個版本才生效；實際操作的人查詢之後，對帳程式拉回的使用摘要出現在單的頁面（390px）', async () => {
    const { caseNo } = await apply('p04', spec(2031));
    activeCaseNo = caseNo;
    const manager = await loggedIn('p03');
    await home(manager);
    await manager.page.click(`[data-case-no="${caseNo}"]`);
    const line = await manager.page.textContent('[data-testid=catalog-version]');
    const current = (await admin.query('select pack_data_access.catalog_current() as c')).rows[0].c;
    assert.equal(line, `資料目錄第 ${current.version_no} 版（${current.sha256.slice(0, 12)}）`);
    for (const uid of ['p03', 'p11', 'p18']) {
        await signer(uid);
        await decide(uid, caseNo);
    }
    const applicant = await loggedIn('p04');
    let c = await waitCase(applicant, caseNo, (x) => x.state === 'verifying' && x.confirmation?.status === 'pending', '等申請人確認');
    const applied = await admin.query(`select result from sgn.delivery_op where case_id = $1 and kind = 'apply' and status = 'done'`, [
        c.case_id,
    ]);
    assert.equal(applied.rows[0].result.catalog_sha256, current.sha256, 'sim/dc 套用時用的就是綁定的版本');
    assert.equal((await callApi(applicant.page, '/api/case_confirm_verification', { case_id: c.case_id })).result.state, 'active');
    // 實際操作的人（林怡君）經使用方系統查兩次（一次範圍內、一次範圍外被擋）
    const query = {
        package: 'sales_order',
        fields: ['amount', 'order_no'],
        row: { region: 'north' },
        data_date: '2031-03-01',
        action: 'query',
        as_of: day(),
    };
    for (const q of [query, { ...query, fields: ['gross_margin'] }]) {
        const r = await fetch(`${dcBase}/use`, {
            method: 'POST',
            headers: dcAdmin,
            body: JSON.stringify({
                principal_id: c.terms.principal.principal_id,
                actor: { provider: 'sim-ldap', external_id: 'p04' },
                query: q,
            }),
        });
        assert.equal(r.status, 200);
    }
    c = await waitCase(applicant, caseNo, (x) => x.usage?.queries === 1 && x.usage?.blocked === 1, '對帳程式拉回使用摘要');
    assert.equal(c.usage.people, 1);
    await applicant.page.goto(`${ORIGIN}/#case/${c.case_id}`);
    await applicant.page.reload();
    await applicant.page.waitForSelector('[data-testid=usage]');
    assert.match(await applicant.page.textContent('[data-testid=usage]'), /查詢 1 次、匯出 0 次、被擋 1 次・1 人/);
    assert.deepEqual(await layoutProblems(applicant.page, '使用情形'), []);
});

test('DA-CAPABILITY-GAP 端對端：受管系統宣告做不到列條件時，簽核人在決定畫面上看得到落差（簽到的內容包含它）', async () => {
    await setSetting(admin, 'data_access.capability.row', false, 'system:dc');
    let caseNo;
    try {
        ({ caseNo } = await apply('p04', spec(2032)));
    } finally {
        await setSetting(admin, 'data_access.capability.row', true, 'system:dc');
    }
    const manager = await loggedIn('p03');
    await home(manager);
    await manager.page.click(`[data-case-no="${caseNo}"]`);
    await manager.page.waitForSelector('[data-testid=capability-gaps]');
    assert.match(await manager.page.textContent('[data-testid=capability-gaps]'), /dc 不能執行「列條件」：所有的列都會開放/);
    assert.deepEqual(await layoutProblems(manager.page, '能力落差'), []);
    // 主管照樣可以核准（L3 只提示）；簽下去的顯示摘要含這段
    await signer('p03');
    await decide('p03', caseNo);
    const signed = await admin.query(
        `select p.display_snapshot -> 'content' -> 'capability_gaps' as g
         from sgn.decision_proof as p join sgn.auth_challenge as ch on ch.id = p.challenge_id
         where ch.binding ->> 'case_no' = $1`,
        [String(caseNo)],
    );
    assert.equal(signed.rows[0].g[0].aspect, 'row');
});

test('DA-CATALOG-RENAME-CONFIRM 端對端：目錄只改名稱 → 資料擁有者在手機首頁看到待確認的項目，按一下確認意義沒變（步數）；生效中的單不撤銷', async () => {
    const renamed = JSON.parse(JSON.stringify(SEED));
    renamed.packages.find((p) => p.code === 'sales_order').fields.find((f) => f.code === 'order_no').name = '訂單號碼';
    await load(renamed);
    const owner = await loggedIn('p11');
    const steps = [];
    await home(owner);
    steps.push('打開首頁');
    const item = owner.page.locator(`[data-testid=catalog-drift-item][data-case-no="${activeCaseNo}"]`);
    await item.waitFor();
    assert.match(await item.textContent(), /訂單編號」→「訂單號碼/);
    assert.deepEqual(await layoutProblems(owner.page, '目錄異動確認'), []);
    await owner.page.evaluate(() => {
        document.getElementById('flash').hidden = true;
    });
    await item.locator('[data-testid=catalog-drift-confirm]').click();
    steps.push('按「意義沒變，確認」');
    await owner.page.waitForSelector('#flash.ok:not([hidden])');
    assert.equal(await owner.page.locator(`[data-testid=catalog-drift-item][data-case-no="${activeCaseNo}"]`).count(), 0);
    console.log(`資料擁有者確認目錄只改名稱：${steps.length} 步（${steps.join(' → ')}）`);
    const applicant = await loggedIn('p04');
    const c = await caseByNo(applicant, activeCaseNo);
    assert.equal(c.state, 'active');
    const confirmed = await admin.query(
        `select count(*)::int as n from sgn.audit_event where case_id = $1 and event_type = 'data_access.catalog_rename_confirmed'`,
        [c.case_id],
    );
    assert.equal(confirmed.rows[0].n, 1);
});
