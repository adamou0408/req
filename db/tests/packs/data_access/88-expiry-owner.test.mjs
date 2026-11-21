// 功能第四批（docs/handoff/feature-4-deadlines.md）B：授權到期前提醒；C：被授權者的負責人離職或停用、被授權者結束。
// 負責人離職由人員同步（sgn_sync，api_sync.directory_apply）真的停用一個人觸發；時間的模擬由管理者連線把期限往前移。
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { routes, shapeProblems } from '../../../../packages/contract/src/routes.ts';
import { readDirectory } from '../../../tools/directory-sync.mjs';
import {
    call,
    challengeFor,
    closePools,
    config,
    login,
    one,
    pool,
    registerPasskey,
    rejectsWith,
    setSetting,
} from '../../kernel/lib/harness.mjs';
import { deliveryPool, drain, mockDc, salesOrderContent, systemDelivery } from './delivery-lib.mjs';
import { DA, decide, today } from './lib.mjs';

const app = pool('APP');
const admin = pool('ADMIN');
const scheduler = pool('SCHEDULER');
const syncDb = pool('SYNC');
const delivery = deliveryPool();
const users = {};
let dc;
let directory;

before(async () => {
    for (const uid of ['p03', 'p04', 'p05', 'p06', 'p07', 'p11', 'p17', 'p24', 'p01', 'p02']) {
        users[uid] = await login(app, uid);
        users[uid].key = await registerPasskey(app, users[uid]);
    }

    directory = await readDirectory(config);
    await systemDelivery(admin);
    dc = await mockDc(admin);
    await drain(delivery, dc);
});
after(async () => {
    await delivery.end();
    await closePools();
});

const OVERLAP_REASON = '測試：和其他測試留下的授權重疊';
const content = (year) => ({ ...salesOrderContent(year), environment: 'test' });
const terms = (principalId, days = 60) => ({ principal_id: principalId, valid_from: today(), valid_to: today(days) });
const view = (caseId, who = 'p04') => call(app, 'case_get', users[who].session, caseId);
const checks = async () => (await one(scheduler, 'select api_job.principal_checks() as r')).r;
const remind = async () => (await one(scheduler, 'select api_job.grant_expiry_remind_due() as r')).r;
const events = async (type, filter = {}) =>
    (
        await admin.query(
            `select case_id, convert_from(body, 'UTF8')::jsonb -> 'data' as data from sgn.audit_event where event_type = $1 order by seq`,
            [type],
        )
    ).rows.filter((r) => Object.entries(filter).every(([k, v]) => r.data[k] === v));
const notified = async (event, caseId = null) =>
    (
        await admin.query(
            'select person_id from sgn.notification_outbox where event_code = $1 and case_id is not distinct from $2 order by id',
            [event, caseId],
        )
    ).rows.map((r) => r.person_id);
const shaped = (fn, value) => {
    assert.deepEqual(shapeProblems(value, routes.find((r) => r.fn === fn).returns), [], fn);
    return value;
};
let serial = 0;
/** 測試專用的被授權者（種子與匯入的入口 principal_upsert；測試準備，管理者連線）。 */
async function newPrincipal(kind, owner, endsOn = '2027-12-31') {
    serial += 1;
    const ref = `${kind}:feature4-${Date.now()}-${serial}`;
    return (
        await one(admin, `select sgn_internal.principal_upsert('db-test', $1, $2, $3, $4, $5::date) as id`, [
            ref,
            kind,
            `第四批測試 ${serial}`,
            users[owner].personId,
            endsOn,
        ])
    ).id;
}
/** 送審並簽到生效。申請人不是負責人時，第一關由負責人確認。 */
async function activeCase(applicant, owner, principalId, year, days = 60) {
    const caseId = (
        await call(app, 'case_submit_new', users[applicant].session, DA, content(year), terms(principalId, days), OVERLAP_REASON)
    ).case_id;
    if (applicant !== owner) await decide(app, users[owner], caseId);
    await signRest(caseId, applicant);
    await drain(delivery, dc);
    await call(app, 'case_confirm_verification', users[applicant].session, caseId);
    assert.equal((await view(caseId, applicant)).state, 'active');
    return caseId;
}
/** 主管、資料擁有者、MIS。p04 的主管是 p03；p02 的主管是 p01。 */
async function signRest(caseId, applicant) {
    const manager = { p04: 'p03', p02: 'p01' }[applicant];
    await decide(app, users[manager], caseId);
    await decide(app, users.p11, caseId);
    await call(app, 'task_claim', users.p17.session, caseId);
    await decide(app, users.p17, caseId);
}
const grantOf = (caseId) => one(admin, 'select id, status, valid_to::text as valid_to from sgn.grant_record where case_id = $1', [caseId]);
/** 人員同步（增量）把一個人停用或恢復在職。停用門檻的時間窗設成 0（這裡只測單人立即生效），測完設回預設。 */
async function setActive(uid, active) {
    await setSetting(admin, 'directory.deactivation_window_hours', 0);
    try {
        const entry = { ...directory.find((e) => e.external_id === uid), active };
        await syncDb.query('select api_sync.directory_apply($1, $2, $3, $4) as r', ['sim-ldap', 'incremental', 1, JSON.stringify([entry])]);
    } finally {
        await setSetting(admin, 'directory.deactivation_window_hours', 24);
    }
}
/** 恢復在職要過冷卻期：測試準備把延後的異動往前移，由排程套用。 */
async function reactivate(uid) {
    await setActive(uid, true);
    await admin.query(
        `update sgn.person_change set effective_at = clock_timestamp() - interval '1 second' where person_id = $1 and applied_at is null`,
        [users[uid].personId],
    );
    await scheduler.query('select api_job.directory_settle()');
}
const gapOf = (principalId) =>
    one(admin, `select * from sgn.principal_owner_gap where principal_id = $1 order by opened_at desc limit 1`, [principalId]);
async function acceptWithPasskey(uid, gapId) {
    const ch = shaped('principal_owner_challenge', await call(app, 'principal_owner_challenge', users[uid].session, gapId));
    const challenge = await challengeFor({
        purpose: 'principal.owner_accept',
        ref: gapId,
        content: ch.display,
        decision: 'accept',
        nonce: ch.nonce,
    });
    const a = users[uid].key.assert(challenge);
    return call(app, 'principal_owner_accept_passkey', ch.challenge_id, a.credentialId, a.authenticatorData, a.clientDataJSON, a.signature);
}

// ── B：到期前提醒 ──

test('K-EXPIRE-REMIND 到期前 N 天提醒申請人與被授權者負責人，每筆一次（進鏈、寫明參數值）；已撤銷、已續期的不提醒；天數依級別設定', async () => {
    const bot = await newPrincipal('agent', 'p05');
    const caseId = await activeCase('p04', 'p05', bot, 2501);
    assert.equal((await remind()).reminded, 0, '迄日還遠');
    // 模擬時間過去：迄日只剩 10 天（測試準備）
    await admin.query(`update sgn.grant_record set valid_to = sgn_internal.today() + 10 where case_id = $1`, [caseId]);
    // 同一個被授權者有一張送審後、迄日較晚、重疊檢查列了這筆授權的單：當作已續期，不提醒
    const renewal = (
        await call(
            app,
            'case_submit_new',
            users.p04.session,
            DA,
            { ...salesOrderContent(2501, undefined, ['north', 'central']), environment: 'test' },
            terms(bot, 60),
            '續用：迄日之後還要用，多加中區',
        )
    ).case_id;
    assert.equal((await view(renewal)).overlap.level, 'partial');
    await remind();
    assert.deepEqual(await notified('grant.expiry_reminder', caseId), [], '已續期的不提醒');
    // 續期的單撤回之後：提醒申請人與負責人一次
    await decide(app, users.p04, renewal, 'recall', { reason: '不續了' });
    assert.ok((await remind()).reminded >= 1);
    const to = await notified('grant.expiry_reminder', caseId);
    assert.deepEqual([...to].sort(), [users.p04.personId, users.p05.personId].sort());
    const [ev] = (await events('grant.expiry_reminded')).filter((e) => e.case_id === caseId);
    assert.deepEqual(ev.data.rules, ['K-EXPIRE-REMIND']);
    assert.deepEqual(ev.data.settings, { 'validity.remind_before_days': 14 });
    assert.equal(ev.data.days_left, 10);
    await remind();
    assert.equal((await notified('grant.expiry_reminder', caseId)).length, 2, '每筆一次');
    // 已撤銷的不提醒；天數依級別（L3 改 30 天，迄日 20 天後的也提醒）
    const revoked = await activeCase('p04', 'p05', bot, 2502);
    await admin.query(`update sgn.grant_record set valid_to = sgn_internal.today() + 5 where case_id = $1`, [revoked]);
    await call(app, 'case_revoke', users.p04.session, revoked, '不用了');
    const far = await activeCase('p04', 'p05', bot, 2503);
    await admin.query(`update sgn.grant_record set valid_to = sgn_internal.today() + 20 where case_id = $1`, [far]);
    await remind();
    assert.deepEqual(await notified('grant.expiry_reminder', far), []);
    await setSetting(admin, 'validity.remind_before_days', 30, `tier:${DA}:L3`);
    try {
        await remind();
    } finally {
        await setSetting(admin, 'validity.remind_before_days', 14, `tier:${DA}:L3`);
    }
    assert.equal((await notified('grant.expiry_reminder', far)).length, 2);
    assert.deepEqual(await notified('grant.expiry_reminder', revoked), [], '已撤銷的不提醒');
    // 別人（不是原申請人、也不是負責人）送的重疊單不算續期：照常提醒
    const other = await activeCase('p04', 'p05', bot, 2504);
    await admin.query(`update sgn.grant_record set valid_to = sgn_internal.today() + 10 where case_id = $1`, [other]);
    const notRenewal = (
        await call(
            app,
            'case_submit_new',
            users.p06.session,
            DA,
            { ...salesOrderContent(2504, undefined, ['north', 'central']), environment: 'test' },
            terms(bot, 60),
            '別人的申請',
        )
    ).case_id;
    assert.equal((await view(notRenewal, 'p06')).overlap.level, 'partial');
    await remind();
    assert.equal((await notified('grant.expiry_reminder', other)).length, 2, '別人的單不能讓這筆授權收不到提醒');
    await decide(app, users.p06, notRenewal, 'recall', { reason: '還原' });
    for (const id of [caseId, far, other]) await call(app, 'case_revoke', users.p04.session, id, '還原');
    await drain(delivery, dc);
});

// ── C：負責人離職或停用 ──

test('K-OWNER-CONTINUITY K-OWNER-SOD 負責人被同步停用：開例外通知主管；簽核中的單不能再核准（可以退回）、時限暫停；主管指定的新負責人不能是簽核人；新負責人用通行金鑰接下才生效', async () => {
    const bot = await newPrincipal('agent', 'p05');
    const live = await activeCase('p04', 'p05', bot, 2511);
    const pending = (await call(app, 'case_submit_new', users.p04.session, DA, content(2512), terms(bot), OVERLAP_REASON)).case_id;
    await decide(app, users.p05, pending); // 負責人確認，停在主管關
    // 還在等負責人確認的單：改指派之後要交給新負責人
    const confirming = (await call(app, 'case_submit_new', users.p04.session, DA, content(2513), terms(bot), OVERLAP_REASON)).case_id;
    await setActive('p05', false);
    const gap = await gapOf(bot);
    assert.equal(gap.status, 'open');
    assert.equal(gap.manager_person_id, users.p03.personId, '王志明的主管是陳建宏');
    const x = await one(admin, 'select rule_code, detail from sgn.exception_record where id = $1', [gap.exception_id]);
    assert.equal(x.rule_code, 'K-OWNER-CONTINUITY');
    assert.deepEqual(x.detail.settings, { 'grant.owner_grace_days': 14, 'grant.owner_reassign_roles': ['control_owner'] });
    const days = (new Date(gap.due_at) - new Date(gap.opened_at)) / 86400000;
    assert.ok(Math.abs(days - 14) < 0.01, `寬限期 14 天（${days}）`);
    assert.ok((await notified('principal.owner_departed')).includes(users.p03.personId));
    // 簽核中的單：不能核准（授權入口），可以退回；頁面有原因與期限；不催不升級
    const seen = await view(pending, 'p03');
    assert.ok(!seen.actions.includes('approve') && seen.actions.includes('return'), JSON.stringify(seen.actions));
    assert.equal(seen.hold.code, 'PRINCIPAL_UNAVAILABLE');
    assert.ok(seen.hold.due_text);
    assert.equal(seen.sla, null, '時限暫停');
    await rejectsWith(call(app, 'challenge_issue', users.p03.session, pending, 'approve', {}), 'PRINCIPAL_UNAVAILABLE');
    // 誰能指定：主管、治理角色；別人不行。候選人與不能選的原因由資料庫給
    assert.deepEqual(await call(app, 'principal_owner_gaps', users.p17.session), []);
    await rejectsWith(call(app, 'principal_owner_propose', users.p17.session, gap.id, users.p06.personId, '接手'), 'NOT_OWNER_REASSIGNER');
    // 劉俊傑看得到何宗翰負責的每個被授權者（前一個測試的那個也是）
    const mine = shaped('principal_owner_gaps', await call(app, 'principal_owner_gaps', users.p03.session)).find(
        (g) => g.gap_id === gap.id,
    );
    assert.deepEqual(mine.actions, ['reassign']);
    assert.equal(mine.active_cases, 1);
    assert.equal(mine.approving_cases, 2);
    assert.ok(mine.candidates.some((c) => c.person.id === users.p07.personId && c.problem === null));
    assert.ok(
        mine.candidates.some((c) => c.person.id === users.p03.personId && c.problem === 'OWNER_CANDIDATE_SOD'),
        '不能選的人標出原因',
    );
    assert.ok(!mine.candidates.some((c) => c.person.id === users.p05.personId), '原負責人不在候選人裡');
    // 職責分離：這個被授權者的單的簽核人不能接手（陳建宏簽了生效中那張的主管關，張美玲簽了資料擁有者關）
    // 提議的人不能指定自己（一律要第二個人）
    await rejectsWith(call(app, 'principal_owner_propose', users.p03.session, gap.id, users.p03.personId, '接手'), 'OWNER_CANDIDATE_SELF');
    await rejectsWith(call(app, 'principal_owner_propose', users.p03.session, gap.id, users.p11.personId, '接手'), 'OWNER_CANDIDATE_SOD');
    await rejectsWith(
        call(app, 'principal_owner_propose', users.p03.session, gap.id, users.p05.personId, '接手'),
        'OWNER_CANDIDATE_INVALID',
    );
    await rejectsWith(call(app, 'principal_owner_propose', users.p03.session, gap.id, users.p06.personId, ' '), 'OWNER_REASON_REQUIRED');
    // 治理角色也可以指定；新的提議取代舊的
    await call(app, 'principal_owner_propose', users.p24.session, gap.id, users.p07.personId, '先由劉俊傑接手');
    const proposed = shaped(
        'principal_owner_propose',
        await call(app, 'principal_owner_propose', users.p03.session, gap.id, users.p06.personId, '同組的蔡佩珊接手'),
    );
    assert.equal(proposed.find((g) => g.gap_id === gap.id).handover.new_owner.id, users.p06.personId);
    assert.deepEqual(await call(app, 'principal_owner_gaps', users.p07.session), [], '被取代的提議不能再確認');
    assert.ok((await notified('principal.owner_handover')).includes(users.p06.personId));
    // 新負責人確認之前什麼都沒變；別人不能確認
    assert.equal((await one(admin, 'select owner_person_id from sgn.principal where id = $1', [bot])).owner_person_id, users.p05.personId);
    await rejectsWith(call(app, 'principal_owner_challenge', users.p07.session, gap.id), 'NOT_OWNER_CANDIDATE');
    const [offered] = await call(app, 'principal_owner_gaps', users.p06.session);
    assert.deepEqual(offered.actions, ['accept']);
    assert.deepEqual(offered.candidates, [], '候選人只給能指定的人');
    const accepted = shaped('principal_owner_accept_passkey', await acceptWithPasskey('p06', gap.id));
    assert.deepEqual(accepted, []);
    assert.equal((await one(admin, 'select owner_person_id from sgn.principal where id = $1', [bot])).owner_person_id, users.p06.personId);
    assert.equal((await gapOf(bot)).status, 'reassigned');
    assert.ok((await one(admin, 'select closed_at from sgn.exception_record where id = $1', [gap.exception_id])).closed_at);
    const [ev] = await events('principal.owner_reassigned', { gap_id: gap.id });
    assert.equal(ev.data.to, users.p06.personId);
    assert.equal(ev.data.proof_kind, 'passkey');
    assert.deepEqual(ev.data.rules, ['K-OWNER-CONTINUITY', 'K-OWNER-SOD']);
    // 簽核中的單可以繼續簽；生效中的授權不受影響
    assert.equal((await view(pending, 'p03')).hold, null);
    assert.ok((await view(pending, 'p03')).actions.includes('approve'));
    assert.equal((await grantOf(live)).status, 'active');
    // 新負責人不能簽同一被授權者進行中的單的其他關（K-OWNER-SOD；決定者資格入口）
    const stage = await one(admin, `select id from sgn.case_stage where case_id = $1 and status = 'open'`, [pending]);
    assert.equal(
        (await one(admin, 'select sgn_internal.decider_denial($1, $2, $3) as d', [pending, users.p06.personId, stage.id])).d,
        'SOD_PRINCIPAL_OWNER',
    );
    // 還在等的負責人確認交給新負責人（進鏈、重新計時），他可以確認
    const handed = await one(admin, `select assignee_person_id, sla_round from sgn.case_task where case_id = $1 and status = 'pending'`, [
        confirming,
    ]);
    assert.equal(handed.assignee_person_id, users.p06.personId);
    assert.equal(handed.sla_round, 1);
    const [moved] = (await events('case.task_reassigned')).filter((e) => e.case_id === confirming);
    assert.equal(moved.data.from, users.p05.personId);
    assert.deepEqual(moved.data.rules, ['K-OWNER-CONTINUITY', 'K-PRINCIPAL-OWNER-CONFIRM']);
    await decide(app, users.p06, confirming);
    assert.equal((await view(confirming)).current_stage.code, 'manager');
    await decide(app, users.p04, confirming, 'recall', { reason: '還原' });
    await decide(app, users.p04, pending, 'recall', { reason: '還原' });
    await call(app, 'case_revoke', users.p04.session, live, '還原');
    await drain(delivery, dc);
});

test('K-OWNER-CONTINUITY 逾期沒有改指派：生效中、執行中與驗證中的單都撤銷並交付撤回，簽核中的單開例外（進鏈、寫明參數值）；寬限期內不能確認生效；撤銷後不重開缺口；寬限期過了不能接下；原負責人恢復在職則結案', async () => {
    const team = await newPrincipal('project', 'p02');
    const a = await activeCase('p04', 'p02', team, 2521);
    const b = await activeCase('p04', 'p02', team, 2522);
    // 驗證中（等申請人確認）與簽核中的單
    const verifying = (await call(app, 'case_submit_new', users.p04.session, DA, content(2523), terms(team), OVERLAP_REASON)).case_id;
    await decide(app, users.p02, verifying);
    await signRest(verifying, 'p04');
    await drain(delivery, dc);
    assert.equal((await view(verifying)).state, 'verifying');
    const approving = (await call(app, 'case_submit_new', users.p04.session, DA, content(2524), terms(team), OVERLAP_REASON)).case_id;
    await decide(app, users.p02, approving);
    await setActive('p02', false);
    const gap = await gapOf(team);
    // 寬限期內：不能確認生效（授權不能在沒有負責人的時候生效）
    await rejectsWith(call(app, 'case_confirm_verification', users.p04.session, verifying), 'PRINCIPAL_UNAVAILABLE');
    assert.equal((await checks()).gaps_expired, 0, '寬限期內不撤銷');
    assert.equal((await grantOf(a)).status, 'active');
    // 模擬寬限期已過（測試準備）：不能再接下
    await admin.query(`update sgn.principal_owner_gap set due_at = clock_timestamp() - interval '1 minute' where id = $1`, [gap.id]);
    await rejectsWith(call(app, 'principal_owner_propose', users.p01.session, gap.id, users.p03.personId, '太晚了'), 'OWNER_GAP_STATE');
    const done = await checks();
    assert.equal(done.gaps_expired, 1);
    for (const id of [a, b]) assert.equal((await grantOf(id)).status, 'revoked');
    assert.equal((await view(verifying)).state, 'revoked', '驗證中的單也撤銷');
    assert.equal((await view(approving)).state, 'in_approval');
    const blocked = await one(admin, `select detail from sgn.exception_record where case_id = $1 and rule_code = 'K-OWNER-CONTINUITY'`, [
        approving,
    ]);
    assert.equal(blocked.detail.kind, 'in_approval_blocked');
    const [ev] = await events('principal.owner_gap_expired', { gap_id: gap.id });
    assert.deepEqual(ev.data.rules, ['K-OWNER-CONTINUITY']);
    assert.deepEqual(ev.data.settings, { 'grant.owner_grace_days': 14 });
    assert.equal(ev.data.revoked_cases.length, 3);
    assert.equal(ev.data.blocked_cases.length, 1);
    const revokedEvents = (await events('grant.revoked')).filter((e) => [a, b, verifying].includes(e.case_id));
    assert.equal(revokedEvents.length, 3);
    assert.ok(revokedEvents.every((e) => e.data.rules.includes('K-OWNER-CONTINUITY')));
    assert.equal((await gapOf(team)).status, 'revoked');
    assert.equal((await checks()).gaps_expired, 0, '只撤一次');
    await drain(delivery, dc);
    assert.equal(
        dc.store.get(String((await one(admin, 'select case_no from sgn.request_case where id = $1', [a])).case_no)).withdrawn,
        true,
    );
    // 另一個被授權者：排程補開它的缺口，但撤銷過的那個不重開（同一位負責人）
    const other = await newPrincipal('agent', 'p02');
    assert.equal((await checks()).gaps_opened, 1, '只補開新的那一個；撤銷過的不重開');
    assert.equal((await gapOf(other)).status, 'open');
    assert.equal((await gapOf(team)).status, 'revoked');
    // 寬限期過了不能接下：先指定，期限過了再確認
    const otherGap = await gapOf(other);
    await call(app, 'principal_owner_propose', users.p01.session, otherGap.id, users.p03.personId, '陳建宏接手');
    await admin.query(`update sgn.principal_owner_gap set due_at = clock_timestamp() - interval '1 second' where id = $1`, [otherGap.id]);
    await rejectsWith(call(app, 'principal_owner_challenge', users.p03.session, otherGap.id), 'OWNER_GAP_STATE');
    await admin.query(`update sgn.principal_owner_gap set due_at = clock_timestamp() + interval '14 days' where id = $1`, [otherGap.id]);
    // 原負責人恢復在職 → 結案，不撤銷
    await reactivate('p02');
    assert.ok((await checks()).gaps_restored >= 1);
    assert.equal((await gapOf(other)).status, 'restored');
    await decide(app, users.p04, approving, 'recall', { reason: '還原' });
});

test('K-PRINCIPAL-END 被授權者結束：專案過了結束日 → 授權到期失效；團隊解散 → 撤銷；簽核中的單不能再核准', async () => {
    const project = await newPrincipal('project', 'p04', '2027-06-30');
    const team = await newPrincipal('team', 'p04', null);
    const p = await activeCase('p04', 'p04', project, 2531);
    const t = await activeCase('p04', 'p04', team, 2532);
    const pending = (await call(app, 'case_submit_new', users.p04.session, DA, content(2533), terms(project), OVERLAP_REASON)).case_id;
    assert.equal((await checks()).principal_ended, 0);
    // 測試準備：專案的結束日改成昨天；團隊標為解散（團隊的來源同步還沒有，見交接）
    await admin.query(`update sgn.principal set ends_on = sgn_internal.today() - 1 where id = $1`, [project]);
    await admin.query(`update sgn.principal set status = 'ended' where id = $1`, [team]);
    assert.equal((await view(p)).overdue.kind, 'principal_end');
    await rejectsWith(call(app, 'challenge_issue', users.p03.session, pending, 'approve', {}), 'PRINCIPAL_UNAVAILABLE');
    assert.equal((await view(pending, 'p03')).hold.code, 'PRINCIPAL_UNAVAILABLE');
    assert.ok((await checks()).principal_ended >= 2);
    assert.equal((await grantOf(p)).status, 'expired');
    assert.equal((await grantOf(t)).status, 'revoked');
    const ended = (await events('grant.expired')).find((e) => e.case_id === p);
    assert.deepEqual(ended.data.rules, ['K-PRINCIPAL-END', 'K-DELIVERY-AUTO']);
    assert.equal((await view(p)).overdue, null);
    await drain(delivery, dc);
    await decide(app, users.p04, pending, 'recall', { reason: '還原' });
});
