// 最小的業務路徑：每條規則（sgn.rule）至少一個測試，測試名稱以規則代碼開頭。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { syncDirectory } from '../../tools/directory-sync.mjs';
import { verifyChain } from '../../tools/chain-lib.mjs';
import { REPO_DIR, roleUrl } from '../../tools/lib/env.mjs';
import {
    call,
    closePools,
    config,
    createSubmittedCase,
    decidePasskey,
    issueChallenge,
    login,
    one,
    pool,
    PROBE,
    registerPasskey,
    rejectsWith,
    settleManagerChange,
} from './lib/harness.mjs';

const app = pool('APP');
const admin = pool('ADMIN');
const users = {};

before(async () => {
    for (const uid of ['p01', 'p02', 'p03', 'p04', 'p05', 'p07', 'p22']) users[uid] = await login(app, uid);
    users.p02.key = await registerPasskey(app, users.p02);
    users.p03.key = await registerPasskey(app, users.p03);
    users.p07.key = await registerPasskey(app, users.p07);
});
after(closePools);

const ldapChange = (...args) => execFileSync(join(REPO_DIR, 'sim/ldap/change.sh'), args, { stdio: 'pipe' });
const caseState = async (caseId) => (await one(admin, 'select state from sgn.request_case where id = $1', [caseId])).state;

test('K-HR-SYNC 送審時從同步進來的主管關係解析簽核人：p04 → p03', async () => {
    const caseId = await createSubmittedCase(app, users.p04);
    const view = await call(app, 'case_get', users.p04.session, caseId);
    // 設計改變：簽核人由每一關的工作記錄（case_task），不再是申請單上的單一欄位
    assert.deepEqual(view.waiting_on, ['陳建宏']);
    const stored = await one(admin, `select assignee_person_id from sgn.case_task where case_id = $1 and status = 'pending'`, [caseId]);
    assert.equal(stored.assignee_person_id, users.p03.personId);
    assert.deepEqual(view.exceptions, [], '基準同步建立的主管關係不開例外');
});

test('K-HR-SYNC 在 LDAP 換主管後重新同步：舊關係關閉；冷卻期內仍由原主管簽，過了冷卻期改由新主管簽並開例外', async () => {
    ldapChange('set-manager', 'p05', 'p07');
    try {
        const result = await syncDirectory(config);
        assert.equal(result.manager_changes, 1);
        const lines = await admin.query(
            `select * from (select id, manager_person_id, valid_to is null as current from sgn.reporting_line
             where person_id = $1 order by id desc limit 2) last_two order by id`,
            [users.p05.personId],
        );
        assert.deepEqual(
            lines.rows.map((r) => [r.manager_person_id, r.current]),
            [
                [users.p03.personId, false],
                [users.p07.personId, true],
            ],
        );
        // 冷卻期（approval.manager_change_cooling_workdays，預設 1 個營業日）內：仍由原主管簽，沒有例外
        const cooling = await createSubmittedCase(app, users.p05);
        const coolingView = await call(app, 'case_get', users.p05.session, cooling);
        assert.deepEqual(coolingView.waiting_on, ['陳建宏']);
        assert.deepEqual(coolingView.exceptions, []);
        // 讓時間「過了」冷卻期：把新關係的起點往前移 5 天（測試用的管理者連線，模擬時間經過）
        await settleManagerChange(admin, users.p05.personId);
        const caseId = await createSubmittedCase(app, users.p05);
        // 真的人事異動同樣是「基準之後的同步異動」，一樣開例外（結案流程還沒做，見 docs/handoff/promote.md）
        const view = await call(app, 'case_get', users.p05.session, caseId);
        assert.deepEqual(view.waiting_on, ['劉俊傑']);
        assert.deepEqual(
            view.exceptions.map((x) => x.rule_code),
            ['K-DETECT-MANAGER-FLIP'],
        );
        await rejectsWith(issueChallenge(app, users.p03, caseId), 'NOT_APPROVER');
        const ch = await issueChallenge(app, users.p07, caseId);
        assert.equal(await decidePasskey(app, ch.challenge_id, 'approve', users.p07.key.assert(ch.challenge)), 'completed');
    } finally {
        ldapChange('set-manager', 'p05', 'p03');
        await syncDirectory(config);
        // 改回原主管也是一次同步異動；讓它也「過了」冷卻期，後面的測試才回到原本的主管
        await settleManagerChange(admin, users.p05.personId);
    }
});

test('K-ACTOR-PROVEN 別人不能修改或送出我的申請單 → NOT_APPLICANT', async () => {
    const created = await call(app, 'case_create', users.p04.session, PROBE, { a: 1 }, {});
    await rejectsWith(
        app.query('select api.case_revise($1, $2, $3, $4)', [users.p05.session, created.case_id, { a: 2 }, {}]),
        'NOT_APPLICANT',
    );
    await rejectsWith(app.query('select api.case_submit($1, $2, $3)', [users.p05.session, created.case_id, null]), 'NOT_APPLICANT');
    await rejectsWith(app.query('select api.case_create($1, $2, $3, $4)', ['not-a-session', PROBE, { a: 1 }, {}]), 'SESSION_INVALID');
});

test('K-NO-REGRESS 送審後不能改內容；退回後可改；核准後不能再決定', async () => {
    const caseId = await createSubmittedCase(app, users.p04);
    await rejectsWith(app.query('select api.case_revise($1, $2, $3, $4)', [users.p04.session, caseId, { x: 1 }, {}]), 'STATE_TRANSITION');
    const back = await issueChallenge(app, users.p03, caseId, 'return', { reason: '請補充用途' });
    assert.equal(await decidePasskey(app, back.challenge_id, 'return', users.p03.key.assert(back.challenge)), 'returned');
    await rejectsWith(issueChallenge(app, users.p03, caseId, 'approve'), 'STATE_TRANSITION');
    const revised = await call(app, 'case_revise', users.p04.session, caseId, { x: 2 }, {});
    assert.equal(revised.version, 2);
    assert.deepEqual(revised.actions, ['revise', 'submit']);
    await app.query('select api.case_submit($1, $2, $3)', [users.p04.session, caseId, null]);
    const ch = await issueChallenge(app, users.p03, caseId);
    assert.equal(await decidePasskey(app, ch.challenge_id, 'approve', users.p03.key.assert(ch.challenge)), 'completed');
    await rejectsWith(issueChallenge(app, users.p03, caseId, 'approve'), 'STATE_TRANSITION');
    await rejectsWith(issueChallenge(app, users.p03, caseId, 'cancel'), 'ACTION_UNKNOWN');
    await rejectsWith(issueChallenge(app, users.p04, caseId, 'revise'), 'ACTION_UNKNOWN');
});

test('K-DECISION-ELIGIBLE 只有直屬主管能拿到挑戰值：同事、隔級主管都不行', async () => {
    const caseId = await createSubmittedCase(app, users.p04);
    await rejectsWith(issueChallenge(app, users.p05, caseId), 'NOT_APPROVER');
    await rejectsWith(issueChallenge(app, users.p02, caseId), 'NOT_APPROVER');
});

test('K-RESOLVE-HALT 沒有主管、路徑也沒有設定最終決定者：可以送審，但關卡停住並開例外，不自動通過', async () => {
    // 設計改變（骨幹 K-RESOLVE-HALT）：原本送審直接回 NO_APPROVER；現在找不到人是一件要有人看的例外
    const top = await call(app, 'case_create', users.p01.session, PROBE, { top: true }, {});
    const submitted = await call(app, 'case_submit', users.p01.session, top.case_id, null);
    assert.equal(submitted.state, 'in_approval');
    assert.deepEqual(submitted.current_stage, { seq: 10, code: 'manager', name: '申請人主管', phase: 'approval', status: 'halted' });
    assert.deepEqual(submitted.waiting_on, []);
    assert.deepEqual(
        submitted.exceptions.map((x) => x.rule_code),
        ['K-RESOLVE-HALT'],
    );
});

test('K-SOD-APPLICANT 申請人不能核准自己的單：拿不到挑戰值；拿主管的挑戰值用自己的金鑰簽也被擋', async () => {
    const caseId = await createSubmittedCase(app, users.p03);
    await rejectsWith(issueChallenge(app, users.p03, caseId), 'SELF_APPROVAL');
    const ch = await issueChallenge(app, users.p02, caseId);
    await rejectsWith(decidePasskey(app, ch.challenge_id, 'approve', users.p03.key.assert(ch.challenge)), 'SELF_APPROVAL');
    assert.equal(await caseState(caseId), 'in_approval');
    assert.equal(await decidePasskey(app, ch.challenge_id, 'approve', users.p02.key.assert(ch.challenge)), 'completed');
});

test('K-DECISION-PROOF 沒有證明就沒有決定：改狀態的入口是固定的幾個，需要證明的動作只能經過驗過證明的入口', async () => {
    const callers = async (callee) =>
        (
            await admin.query(
                `select n.nspname || '.' || p.proname as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname in ('api', 'sgn_internal') and p.prosrc like '%' || $1 || '(%' order by 1`,
                [callee],
            )
        ).rows.map((r) => r.fn);
    // 設計改變：決定的套用移到 decision_apply（只由 decision_commit 呼叫）；關卡推進（case_advance）與認領（task_claim）
    // 是新的狀態入口，不需要證明的動作（送審、修改、認領）各自經授權入口
    // D63：生效後縮小（api.case_reduce，不需要證明、經授權入口）與交付的系統動作（執行關的進度、交付或驗證失敗、授權結束）
    // 是新的狀態入口；它們都不是需要證明的動作（下面 needs_proof 的清單不變）
    // K-CONFIRM：申請人確認、回報不對（不需要證明、經授權入口）與確認逾期的系統撤銷也是狀態入口
    assert.deepEqual(await callers('sgn_internal.case_transition'), [
        'api.case_confirm_verification',
        'api.case_dispute_verification',
        'api.case_reduce',
        'api.case_revise',
        'api.task_claim',
        'sgn_internal.case_advance',
        'sgn_internal.case_submit_draft',
        'sgn_internal.confirmation_expire_due',
        'sgn_internal.decision_apply',
        'sgn_internal.fulfilment_fail',
        'sgn_internal.fulfilment_progress',
        'sgn_internal.grant_end',
    ]);
    assert.deepEqual(await callers('sgn_internal.decision_apply'), ['sgn_internal.decision_commit']);
    // 紅隊 高-2：後端帳號能用的決定入口只剩通行金鑰（身分提供者再驗證的比較版本在 api_verified，只有測試帳號能用）
    assert.deepEqual(await callers('sgn_internal.decision_commit'), ['api.case_decide_passkey']);
    // decision_commit 只轉移挑戰值綁定的決定；挑戰值只發給動作目錄裡 needs_proof 的動作
    const proofActions = await admin.query('select action from sgn.action where needs_proof order by 1');
    assert.deepEqual(
        proofActions.rows.map((r) => r.action),
        ['approve', 'approve_reduced', 'fulfil', 'recall', 'reject', 'return'],
    );
});

test('K-AUDIT-APPEND 一張單從建立到核准，每一步都在鏈上，且整條鏈驗得過', async () => {
    const caseId = await createSubmittedCase(app, users.p04);
    const ch = await issueChallenge(app, users.p03, caseId);
    await decidePasskey(app, ch.challenge_id, 'approve', users.p03.key.assert(ch.challenge));
    const events = await admin.query('select event_type from sgn.audit_event where case_id = $1 order by seq', [caseId]);
    // 設計改變：多關卡之後，開關卡與核准完成各自也是一筆事件
    assert.deepEqual(
        events.rows.map((r) => r.event_type),
        ['case.created', 'case.submitted', 'case.stage_opened', 'case.approve', 'case.completed'],
    );
    const result = await verifyChain({ dbUrl: roleUrl(config, 'JOB') });
    assert.equal(result.ok, true, JSON.stringify(result.problems.slice(0, 3)));
});

test('K-AUDITOR-READONLY 稽核人員查得到整張單的軌跡與證明雜湊；非稽核人員被拒；查詢 function 是唯讀的', async () => {
    const caseId = await createSubmittedCase(app, users.p04);
    const ch = await issueChallenge(app, users.p03, caseId);
    await decidePasskey(app, ch.challenge_id, 'approve', users.p03.key.assert(ch.challenge));
    const caseNo = (await one(admin, 'select case_no from sgn.request_case where id = $1', [caseId])).case_no;
    const audit = await call(app, 'audit_case', users.p22.session, caseNo);
    const own = audit.events.filter((e) => e.event_type.startsWith('case.'));
    assert.deepEqual(
        own.map((e) => e.event_type),
        ['case.created', 'case.submitted', 'case.stage_opened', 'case.approve', 'case.completed'],
    );
    assert.equal(own[3].actor_name, '陳建宏');
    assert.match(audit.proofs[0].raw_sha256, /^[0-9a-f]{64}$/);
    await rejectsWith(call(app, 'audit_case', users.p04.session, caseNo), 'AUDITOR_REQUIRED');
    await rejectsWith(call(app, 'audit_chain', users.p03.session, 0, 10), 'AUDITOR_REQUIRED');
    await rejectsWith(call(app, 'audit_exceptions', users.p03.session), 'AUDITOR_REQUIRED');
    const { rows } = await admin.query(
        `select p.proname, p.provolatile from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'api' and p.proname like 'audit\\_%' order by 1`,
    );
    assert.deepEqual(
        rows.map((r) => [r.proname, r.provolatile]),
        [
            ['audit_case', 's'],
            ['audit_chain', 's'],
            ['audit_code_fingerprint', 's'],
            ['audit_exceptions', 's'],
        ],
    );
});
