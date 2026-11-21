// 端對端（排在其他 system-* 之後、z-anchor-store 之前：會讓目錄裡的人離職再還原）：功能第四批（docs/handoff/feature-4-deadlines.md）——時限與負責人離職，在 390px 寬的真實畫面上。
//   A 待簽清單顯示已等幾個工作天與是否逾期（排序依據看得到）、單的頁面顯示目前這關的期限；
//   C 用 sim/ 的目錄（LDAP）真的讓一個人離職：同步之後他負責的被授權者開缺口，主管在首頁指定新負責人，新負責人用通行金鑰接下。
// 背景的排程每 60 秒跑一次：這裡模擬的等待時間只到「催辦期限已過、升級期限還沒到」，排程只會催辦、不會升級（不影響後面的步驟）。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { pool as dbPool, setSetting } from '../../db/tests/kernel/lib/harness.mjs';
import { REPO_DIR, loadConfig } from '../../db/tools/lib/env.mjs';
import { syncDirectory } from '../../db/tools/directory-sync.mjs';
import {
    ORIGIN,
    apply,
    callApi,
    day,
    ensurePasskey,
    flashAfter,
    home,
    layoutProblems,
    loggedIn,
    signer,
    startBrowser,
    stopBrowser,
    waitPage,
} from './lib/ui.mjs';

const admin = dbPool('ADMIN');
const scheduler = dbPool('SCHEDULER');
const results = {};
const ldap = (...args) => execFileSync(join(REPO_DIR, 'sim/ldap', args[0]), args.slice(1), { stdio: 'pipe' });

before(startBrowser);
after(async () => {
    console.log(JSON.stringify({ deadlines: results }));
    await stopBrowser();
});

const personId = async (uid) =>
    (await admin.query(`select person_id from sgn.person_identity where source = 'sim-ldap' and external_id = $1`, [uid])).rows[0]
        .person_id;

test('K-SLA-VIEW 待簽清單顯示已等幾個工作天、已逾期的排在前面；單的頁面顯示目前這關的催辦與升級期限（390px）', async () => {
    const fresh = await apply('p04', {
        principal: 'sales-report-bot',
        from: day(),
        to: day(1),
        packages: { sales_order: { fields: ['order_no', 'amount'], filters: { region: ['north'] } } },
        period: { from: '2193-01-01', to: '2193-12-31' },
        purpose: 'reporting',
        description: '時限端對端：剛送出',
    });
    const late = await apply('p04', {
        principal: 'sales-report-bot',
        from: day(),
        to: day(1),
        packages: { sales_order: { fields: ['order_no', 'amount'], filters: { region: ['north'] } } },
        period: { from: '2194-01-01', to: '2194-12-31' },
        purpose: 'reporting',
        description: '時限端對端：等了 4 個工作天',
    });
    // 模擬時間過去（測試準備）：主管關的工作從 4 個工作天前開始（催辦 3 天已過、升級再 2 天還沒到）
    await admin.query(
        `update sgn.case_task t set opened_at = (
             select max(d) from generate_series(clock_timestamp() - interval '14 days', clock_timestamp(), interval '1 hour') as d
             where sgn_internal.add_workdays(d, 4) <= clock_timestamp())
         from sgn.request_case c where c.id = t.case_id and c.case_no = $1 and t.status = 'pending'`,
        [late.caseNo],
    );
    const manager = await loggedIn('p03');
    await home(manager);
    const items = manager.page.locator('[data-testid=inbox-item]');
    const order = await items.evaluateAll((nodes) => nodes.map((n) => Number(n.dataset.caseNo)));
    assert.ok(order.indexOf(late.caseNo) >= 0 && order.indexOf(late.caseNo) < order.indexOf(fresh.caseNo), `逾期的在前：${order}`);
    const lateLine = manager.page.locator(`[data-case-no="${late.caseNo}"] [data-testid=sla]`);
    assert.equal(await lateLine.getAttribute('data-overdue'), 'true');
    assert.equal(await lateLine.getAttribute('data-workdays'), '4');
    assert.match(await lateLine.textContent(), /已等 4 個工作天・已逾期/);
    assert.match(await manager.page.locator(`[data-case-no="${fresh.caseNo}"] [data-testid=sla]`).textContent(), /已等 0 個工作天/);
    const problems = await layoutProblems(manager.page, '待簽清單');
    // 單的頁面：期限與是否逾期（0 步：打開就看到）
    await manager.page.click(`[data-case-no="${late.caseNo}"]`);
    await manager.page.waitForSelector('[data-testid=decision-facts]');
    const box = manager.page.locator('[data-testid=sla]');
    assert.equal(await box.getAttribute('data-overdue'), 'true');
    assert.match(await box.textContent(), /催辦期限 \d{4}-\d\d-\d\d \d\d:\d\d，升級期限 \d{4}-\d\d-\d\d \d\d:\d\d/);
    problems.push(...(await layoutProblems(manager.page, '單的頁面')));
    assert.deepEqual(problems, []);
    results.slaView = { steps_inbox: 0, steps_case: 1, detail: ['首頁待簽清單直接顯示', '點開單的頁面'] };
    // 還原：申請人撤回兩張單
    for (const no of [fresh.caseNo, late.caseNo]) {
        const applicant = await signer('p04');
        const c = (await callApi(applicant.page, '/api/case_list_mine')).result.find((x) => x.case_no === no);
        await applicant.page.goto(`${ORIGIN}/#case/${c.case_id}`);
        await waitPage(applicant.page);
        await ensurePasskey(applicant);
        await applicant.page.click('[data-action=recall]');
        await applicant.page.fill('[data-testid=decision-reason]', '端對端還原');
        await flashAfter(applicant.page, () => applicant.page.click('[data-testid=confirm-passkey]'));
    }
});

test('K-OWNER-CONTINUITY 真的讓一個人離職：LDAP 停用 → 同步 → 主管在首頁指定新負責人（390px）→ 新負責人用通行金鑰接下 → 例外結案', async () => {
    const departed = await personId('p06');
    const principal = (
        await admin.query(
            `select sgn_internal.principal_upsert('e2e', 'agent:feature4-owner', 'agent', '第四批端對端 bot', $1, '2027-12-31') as id`,
            [departed],
        )
    ).rows[0].id;
    // 停用門檻的時間窗設成 0（這裡只有一人離職；測試準備），之後設回預設
    await setSetting(admin, 'directory.deactivation_window_hours', 0);
    try {
        ldap('change.sh', 'offboard', 'p06');
        const synced = await syncDirectory(loadConfig());
        assert.equal(synced.deactivated, 1, JSON.stringify(synced));
    } finally {
        await setSetting(admin, 'directory.deactivation_window_hours', 24);
    }
    try {
        const gap = (
            await admin.query(`select id, exception_id from sgn.principal_owner_gap where principal_id = $1 and status = 'open'`, [
                principal,
            ])
        ).rows[0];
        assert.ok(gap, '同步的同一個交易裡開了缺口');
        const notice = await admin.query(
            `select person_id from sgn.notification_outbox where event_code = 'principal.owner_departed' order by id desc limit 5`,
        );
        assert.ok(notice.rows.some((r) => r.person_id !== departed));
        // 主管（陳建宏）：首頁 → 選新負責人 → 寫原因 → 指定（3 步）
        const manager = await loggedIn('p03');
        await home(manager);
        const card = manager.page.locator(`[data-testid=owner-gap][data-gap="${gap.id}"]`);
        await card.waitFor();
        const steps = [];
        await card.locator('[data-testid=owner-candidate]').selectOption(await personId('p05'));
        steps.push('選新的負責人');
        await card.locator('[data-testid=owner-reason]').fill('同組的王志明接手');
        steps.push('寫原因');
        const problems = await layoutProblems(manager.page, '改指派（主管）');
        const proposed = await flashAfter(manager.page, () => card.locator('[data-testid=owner-propose-submit]').click());
        steps.push('按「指定為新的負責人」');
        assert.ok(proposed.ok, proposed.text);
        // 新負責人（王志明）：首頁 → 確認接下 → 用通行金鑰確認（2 步）
        const successor = await signer('p05');
        await home(successor);
        await ensurePasskey(successor);
        const offer = successor.page.locator(`[data-testid=owner-gap][data-gap="${gap.id}"]`);
        await offer.waitFor();
        const accepting = [];
        await offer.locator('[data-testid=owner-accept]').click();
        accepting.push('按「確認接下負責人」');
        problems.push(...(await layoutProblems(successor.page, '確認接下（新負責人）')));
        const accepted = await flashAfter(successor.page, () => successor.page.click('[data-testid=confirm-passkey]'));
        accepting.push('用通行金鑰確認');
        assert.ok(accepted.ok, accepted.text);
        assert.deepEqual(problems, []);
        const owner = (await admin.query('select owner_person_id from sgn.principal where id = $1', [principal])).rows[0].owner_person_id;
        assert.equal(owner, await personId('p05'));
        assert.ok((await admin.query('select closed_at from sgn.exception_record where id = $1', [gap.exception_id])).rows[0].closed_at);
        results.ownerReassign = { manager_steps: steps.length, manager: steps, successor_steps: accepting.length, successor: accepting };
        assert.ok(steps.length <= 3 && accepting.length <= 2);
    } finally {
        // 還原：目錄回到種子狀態、同步、恢復在職的冷卻期視為已過，由排程套用；原負責人的其他被授權者的缺口結案
        ldap('reset.sh');
        await syncDirectory(loadConfig());
        await admin.query(
            `update sgn.person_change set effective_at = clock_timestamp() - interval '1 second' where person_id = $1 and applied_at is null`,
            [departed],
        );
        await scheduler.query('select api_job.directory_settle()');
        // 測試專用的被授權者不留在被授權者清單裡（之後的攻擊腳本依名稱挑被授權者）
        await admin.query(`update sgn.principal set status = 'ended' where id = $1`, [principal]);
        await scheduler.query('select api_job.principal_checks()');
        assert.equal((await admin.query('select active from sgn.person where id = $1', [departed])).rows[0].active, true);
        assert.equal(
            (
                await admin.query(
                    `select count(*)::int as n from sgn.principal_owner_gap g join sgn.principal x on x.id = g.principal_id where x.owner_person_id = $1 and g.status = 'open'`,
                    [departed],
                )
            ).rows[0].n,
            0,
        );
    }
});
