// 功能第四批（docs/handoff/feature-4-deadlines.md）A：簽核關卡的時限——催辦、升級、群組認領逾期、畫面上的期限。
// 時間的模擬：管理者連線把等待中工作的起點往前移（真實環境的時間不能倒退），排程（sgn_scheduler）再跑 api_job.approval_sla_due。
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { routes, shapeProblems } from '../../../../packages/contract/src/routes.ts';
import {
    call,
    closePools,
    issueChallenge,
    decidePasskey,
    login,
    one,
    pool,
    registerPasskey,
    rejectsWith,
    setSetting,
} from '../../kernel/lib/harness.mjs';
import { salesOrderContent } from './delivery-lib.mjs';
import { DA, decide, principals, today } from './lib.mjs';

const app = pool('APP');
const admin = pool('ADMIN');
const scheduler = pool('SCHEDULER');
const users = {};
let P;

before(async () => {
    for (const uid of ['p01', 'p02', 'p03', 'p04', 'p10', 'p11', 'p16', 'p17']) {
        users[uid] = await login(app, uid);
        users[uid].key = await registerPasskey(app, users[uid]);
    }
    P = await principals(app, users.p04.session);
});
after(closePools);

const OVERLAP_REASON = '測試：和其他測試留下的授權重疊';
const bot = () => ({ principal_id: P['sales-report-bot'], valid_from: today(), valid_to: today(60) });
const submit = async (year, who = 'p04') =>
    (await call(app, 'case_submit_new', users[who].session, DA, { ...salesOrderContent(year), environment: 'test' }, bot(), OVERLAP_REASON))
        .case_id;
const view = (caseId, who = 'p04') => call(app, 'case_get', users[who].session, caseId);
const sla = () => one(scheduler, 'select api_job.approval_sla_due() as r').then((x) => x.r);
/** 模擬時間過去：這張單等待中的工作的起點（開始、認領、升級）往前移幾天。 */
const age = (caseId, days) =>
    admin.query(
        `update sgn.case_task
         set opened_at = opened_at - make_interval(days => $2),
             claimed_at = claimed_at - make_interval(days => $2),
             sla_from = sla_from - make_interval(days => $2)
         where case_id = $1 and status in ('pending', 'unclaimed')`,
        [caseId, days],
    );
const events = async (caseId, type) =>
    (
        await admin.query(
            `select convert_from(body, 'UTF8')::jsonb -> 'data' as data from sgn.audit_event where case_id = $1 and event_type = $2 order by seq`,
            [caseId, type],
        )
    ).rows.map((r) => r.data);
const notified = async (caseId, event) =>
    (
        await admin.query('select person_id from sgn.notification_outbox where case_id = $1 and event_code = $2 order by id', [
            caseId,
            event,
        ])
    ).rows.map((r) => r.person_id);
const exceptions = async (caseId, rule) =>
    (
        await admin.query('select id, detail, closed_at from sgn.exception_record where case_id = $1 and rule_code = $2 order by id', [
            caseId,
            rule,
        ])
    ).rows;
const waitingTask = async (caseId) =>
    one(
        admin,
        `select id, assignee_person_id, status, sla_from from sgn.case_task where case_id = $1 and status in ('pending', 'unclaimed') order by id limit 1`,
        [caseId],
    );
/** 還原：申請人撤回（簽核中的單不能撤銷）；撤回之後工作作廢、不再等待。 */
const withdraw = (caseId, who = 'p04') => decide(app, users[who], caseId, 'recall', { reason: '還原' });
const DEFAULTS = { 'approval.remind_after_workdays': 3, 'approval.escalate_after_workdays': 2 };

test('K-SLA-REMIND 催辦：超過催辦期限未簽，排程催辦一次（進鏈、寫明期限與參數值），重跑不重複；期限還沒到不催', async () => {
    const fresh = await submit(7401);
    await sla();
    assert.deepEqual(await notified(fresh, 'case.task_reminder'), [], '剛送出的單不催');
    const caseId = await submit(7402);
    await age(caseId, 10);
    // 還沒處理的步驟算逾期工作（排程停擺時由 K-PROGRAM-STALLED 讓人知道）
    assert.equal((await view(caseId)).overdue.kind, 'approval_sla');
    assert.ok((await sla()).remind >= 1);
    assert.deepEqual(await notified(caseId, 'case.task_reminder'), [users.p03.personId]);
    const [ev] = await events(caseId, 'case.task_reminded');
    assert.deepEqual(ev.rules, ['K-SLA-REMIND']);
    assert.deepEqual(ev.settings, DEFAULTS);
    assert.equal(ev.step, 'remind');
    assert.ok(ev.due_at && ev.started_at);
    // 同一輪不會接著升級（先催辦，下一輪才升級）
    assert.equal((await waitingTask(caseId)).assignee_person_id, users.p03.personId);
    // 升級期限還沒到：不是逾期工作；重跑不再催
    await admin.query(
        `update sgn.case_task set opened_at = clock_timestamp() - interval '1 day' where case_id = $1 and status = 'pending'`,
        [caseId],
    );
    assert.equal((await view(caseId)).overdue, null);
    await sla();
    assert.equal((await notified(caseId, 'case.task_reminder')).length, 1, '每件工作只催一次');
    await withdraw(caseId, 'p04');
    await withdraw(fresh, 'p04');
});

test('K-SLA-ESCALATE 升級：催辦後再逾期，升級給簽核人的上一層主管；原簽核人不能再簽（已拿到的挑戰值也不行）但看得到；升級對象簽了往下走；只升級一次', async () => {
    const caseId = await submit(7403);
    await age(caseId, 10);
    await sla(); // 催辦
    const early = await issueChallenge(app, users.p03, caseId); // 原簽核人在升級前拿到挑戰值
    const counts = await sla(); // 升級
    assert.ok(counts.escalate >= 1, JSON.stringify(counts));
    const task = await waitingTask(caseId);
    assert.equal(task.assignee_person_id, users.p02.personId, '陳建宏的上一層主管是方國華');
    assert.ok(task.sla_from);
    const [ev] = await events(caseId, 'case.task_escalated');
    assert.deepEqual(ev.rules, ['K-SLA-ESCALATE']);
    assert.equal(ev.from, users.p03.personId);
    assert.equal(ev.to, users.p02.personId);
    assert.deepEqual(ev.settings, DEFAULTS);
    assert.equal(ev.via, 'direct');
    assert.ok(ev.line.reporting_line_id, '寫明用哪一條主管關係');
    assert.deepEqual(await notified(caseId, 'case.task_escalated'), [users.p02.personId]);
    assert.deepEqual(await notified(caseId, 'case.task_escalated_away'), [users.p03.personId]);
    // 原簽核人：拿到的挑戰值驗章之後授權失敗；也拿不到新的；仍看得到這張單
    await rejectsWith(decidePasskey(app, early.challenge_id, 'approve', users.p03.key.assert(early.challenge)), 'NOT_APPROVER');
    await rejectsWith(call(app, 'challenge_issue', users.p03.session, caseId, 'approve', {}), 'NOT_APPROVER');
    const seen = await view(caseId, 'p03');
    assert.deepEqual(seen.actions, []);
    assert.equal(seen.sla.escalated, true);
    assert.equal(seen.sla.escalated_to.length, 1);
    // 只升級一次
    await sla();
    assert.equal((await events(caseId, 'case.task_escalated')).length, 1);
    // 升級對象簽了 → 下一關
    assert.ok((await call(app, 'inbox_list', users.p02.session)).some((c) => c.case_id === caseId));
    await decide(app, users.p02, caseId);
    assert.equal((await view(caseId)).current_stage.code, 'data_owner');
    await withdraw(caseId, 'p04');
});

test('K-SLA-ESCALATE 升級對象仍受每關不同人、不能是申請人約束：撞到申請人與已簽過的人就再往上，最後到路徑的 top_resolver', async () => {
    // 蘇慧敏（p10）替 sales-report-bot 申請：負責人確認（林怡君）→ 主管（高志遠）→ 資料擁有者（張美玲，主管是蘇慧敏）
    const caseId = (
        await call(
            app,
            'case_submit_new',
            users.p10.session,
            DA,
            { ...salesOrderContent(7404), environment: 'test' },
            bot(),
            OVERLAP_REASON,
        )
    ).case_id;
    await decide(app, users.p04, caseId);
    await decide(app, users.p01, caseId);
    assert.equal((await view(caseId, 'p10')).current_stage.code, 'data_owner');
    await age(caseId, 10);
    await sla();
    await sla();
    const [ev] = await events(caseId, 'case.task_escalated');
    assert.equal(ev.from, users.p11.personId);
    assert.equal(ev.via, 'top_resolver');
    assert.deepEqual(
        ev.path.map((x) => [x.person_id, x.denied]),
        [
            [users.p10.personId, 'SELF_APPROVAL'],
            [users.p01.personId, 'SOD_DISTINCT'],
        ],
    );
    const top = await one(admin, `select i.person_id from sgn.person_identity i where i.source = 'sim-ldap' and i.external_id = 'p27'`);
    assert.equal(ev.to, top.person_id, '董事長（路徑的 top_resolver）');
    await withdraw(caseId, 'p10');
});

test('K-SLA-ESCALATE 主管關係在簽核途中被改：還在冷卻期的新主管不會成為升級對象（只用已生效的主管關係）', async () => {
    const caseId = await submit(7405);
    await age(caseId, 10);
    await sla();
    // 同步剛把陳建宏（p03）的主管改成王志明（p05）：還在冷卻期
    const line = await one(admin, 'select id from sgn.reporting_line where person_id = $1 and valid_to is null', [users.p03.personId]);
    const p05 = await one(admin, `select person_id from sgn.person_identity where source = 'sim-ldap' and external_id = 'p05'`);
    await admin.query('update sgn.reporting_line set valid_to = clock_timestamp() where id = $1', [line.id]);
    const inserted = await one(
        admin,
        `insert into sgn.reporting_line (person_id, manager_person_id, valid_from, origin, change_event_seq)
         values ($1, $2, clock_timestamp(), 'sync_change', 1) returning id`,
        [users.p03.personId, p05.person_id],
    );
    try {
        await sla();
        const [ev] = await events(caseId, 'case.task_escalated');
        assert.equal(ev.to, users.p02.personId, '仍是已生效的方國華，不是剛改上去的王志明');
        assert.equal(ev.line.reporting_line_id, Number(line.id));
    } finally {
        await admin.query('delete from sgn.reporting_line where id = $1', [inserted.id]);
        await admin.query('update sgn.reporting_line set valid_to = null where id = $1', [line.id]);
    }
    await withdraw(caseId, 'p04');
});

test('K-SLA-STALLED 往上找不到合格的人：開例外通知治理角色與申請人，工作留給原簽核人（不卡死、不自動通過）；升級對象也逾期再開；不再等待就結案', async () => {
    // 方國華（p02）替 sales-report-bot 申請：主管是高志遠（沒有主管）；董事長暫時是排除的決定者角色
    const caseId = (
        await call(
            app,
            'case_submit_new',
            users.p02.session,
            DA,
            { ...salesOrderContent(7406), environment: 'test' },
            bot(),
            OVERLAP_REASON,
        )
    ).case_id;
    await decide(app, users.p04, caseId);
    await setSetting(admin, 'approval.excluded_decider_roles', ['auditor', 'tech_ops', 'board_chair']);
    try {
        await age(caseId, 10);
        await sla();
        const counts = await sla();
        assert.equal(counts.stalled, 1, JSON.stringify(counts));
    } finally {
        await setSetting(admin, 'approval.excluded_decider_roles', ['auditor', 'tech_ops']);
    }
    assert.equal((await waitingTask(caseId)).assignee_person_id, users.p01.personId, '工作留給原簽核人');
    const [failed] = await events(caseId, 'case.task_escalation_failed');
    assert.equal(failed.target.via, 'none');
    const [x] = await exceptions(caseId, 'K-SLA-STALLED');
    assert.equal(x.detail.kind, 'no_escalation_target');
    assert.deepEqual(x.detail.settings['approval.stalled_notify_roles'], ['control_owner']);
    const to = await notified(caseId, 'case.task_stalled');
    assert.ok(to.includes(users.p02.personId), '申請人');
    const owners = (await admin.query(`select person_id from sgn.role_assignment where role_code = 'control_owner' and valid_to is null`))
        .rows;
    for (const o of owners) assert.ok(to.includes(o.person_id), '治理角色');
    await sla();
    assert.equal((await exceptions(caseId, 'K-SLA-STALLED')).length, 1, '只開一次');
    // 原簽核人仍可以簽；簽了之後例外結案
    await decide(app, users.p01, caseId);
    assert.ok((await sla()).closed >= 1);
    assert.ok((await exceptions(caseId, 'K-SLA-STALLED'))[0].closed_at);
    await withdraw(caseId, 'p02');
});

test('K-SLA-STALLED 升級對象也逾期：開例外通知治理角色與升級對象的主管', async () => {
    const caseId = await submit(7407);
    await age(caseId, 10);
    await sla();
    await sla();
    assert.equal((await waitingTask(caseId)).assignee_person_id, users.p02.personId);
    await age(caseId, 10);
    await sla();
    const [x] = await exceptions(caseId, 'K-SLA-STALLED');
    assert.equal(x.detail.kind, 'escalated_overdue');
    assert.deepEqual(x.detail.rules, ['K-SLA-STALLED']);
    assert.ok((await notified(caseId, 'case.task_stalled')).includes(users.p01.personId), '方國華的主管');
    assert.equal((await events(caseId, 'case.task_escalated')).length, 1, '升級過的工作不再升級');
    await withdraw(caseId);
    await sla();
    assert.ok((await exceptions(caseId, 'K-SLA-STALLED'))[0].closed_at, '撤回之後不再等待：結案');
});

test('K-SLA-CLAIM 群組認領關沒人認領：催辦整個群組；再逾期開例外通知候選人的主管與治理角色；認領之後結案、重新計時', async () => {
    const caseId = await submit(7408);
    await decide(app, users.p03, caseId);
    await decide(app, users.p11, caseId);
    assert.equal((await waitingTask(caseId)).status, 'unclaimed');
    await age(caseId, 10);
    await sla();
    const group = await notified(caseId, 'case.claim_reminder');
    const mis = (await admin.query(`select person_id from sgn.role_assignment where role_code = 'mis' and valid_to is null`)).rows.map(
        (r) => r.person_id,
    );
    assert.deepEqual([...group].sort(), [...mis].sort(), '催辦整個群組');
    const [ev] = await events(caseId, 'case.task_reminded');
    assert.deepEqual(ev.rules, ['K-SLA-CLAIM']);
    assert.equal(ev.step, 'claim_remind');
    await sla();
    const [x] = await exceptions(caseId, 'K-SLA-CLAIM');
    assert.equal(x.detail.kind, 'unclaimed');
    assert.equal(x.detail.role, 'mis');
    const to = await notified(caseId, 'case.claim_stalled');
    assert.ok(to.includes(users.p16.personId) && to.includes(users.p01.personId), '候選人的主管（謝明哲、高志遠）');
    // 認領之後：例外結案，計時從認領起算（不會立刻被催辦）
    await call(app, 'task_claim', users.p17.session, caseId);
    const after = await sla();
    assert.ok(after.closed >= 1);
    assert.ok((await exceptions(caseId, 'K-SLA-CLAIM'))[0].closed_at);
    assert.deepEqual(await notified(caseId, 'case.task_reminder'), []);
    assert.equal((await view(caseId)).sla.overdue, false);
    await withdraw(caseId, 'p04');
});

test('K-SLA-VIEW 待簽清單與單的頁面：已等幾個工作天、催辦與升級期限、是否逾期與升級；逾期的排在前面；時限依級別設定', async () => {
    const recent = await submit(7409);
    const late = await submit(7410);
    await age(late, 10);
    const inbox = await call(app, 'inbox_list', users.p03.session);
    const shape = routes.find((r) => r.fn === 'inbox_list').returns;
    assert.deepEqual(shapeProblems(inbox, shape), []);
    const i = (id) => inbox.findIndex((c) => c.case_id === id);
    assert.ok(i(late) >= 0 && i(recent) >= 0 && i(late) < i(recent), '逾期的在前');
    const lateSla = inbox[i(late)].sla;
    assert.equal(lateSla.overdue, true);
    assert.equal(lateSla.escalated, false);
    assert.equal(lateSla.stage_name, inbox[i(late)].current_stage.name);
    const expected = await one(
        admin,
        `select sgn_internal.workdays_between((opened_at at time zone 'Asia/Taipei')::date, sgn_internal.today()) as n
         from sgn.case_task where case_id = $1 and status = 'pending'`,
        [late],
    );
    assert.equal(lateSla.waiting_workdays, expected.n);
    assert.ok(lateSla.waiting_workdays >= 6);
    assert.ok(/^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(lateSla.remind_due) && /^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(lateSla.escalate_due));
    assert.deepEqual(lateSla.settings, DEFAULTS);
    const recentSla = inbox[i(recent)].sla;
    assert.equal(recentSla.overdue, false);
    assert.equal(recentSla.waiting_workdays, 0);
    // 依級別設定：L3 的催辦改成 1 個工作天，畫面與排程都讀到
    await setSetting(admin, 'approval.remind_after_workdays', 1, `tier:${DA}:L3`);
    try {
        assert.equal((await view(recent)).sla.settings['approval.remind_after_workdays'], 1);
    } finally {
        await setSetting(admin, 'approval.remind_after_workdays', 3, `tier:${DA}:L3`);
    }
    await sla();
    for (const id of [recent, late]) await withdraw(id, 'p04');
    await sla();
});
