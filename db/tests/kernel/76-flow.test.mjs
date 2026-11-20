// 多關卡的流程（核心，不依賴任何流程包）：用測試專用的流程類型 probe_chain（db/testing/60_probe_process.sql）
// 主管 → 群組檢查（角色 mis 認領）→ 執行（同一群組認領），最終決定者 board_chair。
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { call, closePools, decidePasskey, issueChallenge, login, one, pool, PROBE, registerPasskey, rejectsWith } from './lib/harness.mjs';

const app = pool('APP');
const admin = pool('ADMIN');
const CHAIN = 'probe_chain';
const users = {};

before(async () => {
    for (const uid of ['p01', 'p03', 'p04', 'p05', 'p16', 'p17', 'p18', 'p22', 'p27']) users[uid] = await login(app, uid);
    for (const uid of ['p01', 'p03', 'p04', 'p16', 'p17', 'p18', 'p27']) users[uid].key = await registerPasskey(app, users[uid]);
});
after(closePools);

const submit = (who, type = CHAIN, content = { n: Math.random() }) =>
    call(app, 'case_submit_new', users[who].session, type, content, {}, null);
async function decide(who, caseId, decision = 'approve', input = {}) {
    const ch = await issueChallenge(app, users[who], caseId, decision, input);
    return decidePasskey(app, ch.challenge_id, decision, users[who].key.assert(ch.challenge));
}
const stages = async (caseId) => (await call(app, 'case_get', users.p04.session, caseId)).stages;
const taskBasis = async (caseId) =>
    (await one(admin, `select basis from sgn.case_task where case_id = $1 order by id desc limit 1`, [caseId])).basis;

test('K-RESOLVE-STAGE-START 送審時只開第一關；下一關在前一關完成時才解析', async () => {
    const c = await submit('p04');
    let view = await stages(c.case_id);
    assert.deepEqual(
        view.map((s) => [s.code, s.status]),
        [['manager', 'open']],
    );
    await decide('p03', c.case_id);
    view = await stages(c.case_id);
    assert.deepEqual(
        view.map((s) => [s.code, s.status]),
        [
            ['manager', 'done'],
            ['check', 'open'],
        ],
    );
    assert.equal(view[1].tasks[0].status, 'unclaimed');
});

test('K-CLAIM 群組關卡由一人認領；不是群組成員不能認領；認領後別人不能再認領，認領的人才能決定', async () => {
    const c = await submit('p04');
    await decide('p03', c.case_id);
    await rejectsWith(call(app, 'task_claim', users.p05.session, c.case_id), 'NOT_CLAIMABLE');
    await rejectsWith(issueChallenge(app, users.p16, c.case_id), 'NOT_APPROVER');
    const inbox = await call(app, 'inbox_list', users.p17.session);
    assert.ok(inbox.some((x) => x.case_id === c.case_id && x.actions.includes('claim')));
    const claimed = await call(app, 'task_claim', users.p16.session, c.case_id);
    assert.deepEqual(claimed.waiting_on, ['謝明哲']);
    assert.deepEqual(claimed.actions, ['approve', 'approve_reduced', 'reject', 'return']);
    await rejectsWith(call(app, 'task_claim', users.p17.session, c.case_id), 'NOT_CLAIMABLE');
    await rejectsWith(issueChallenge(app, users.p17, c.case_id), 'NOT_APPROVER');
    assert.equal(await decide('p16', c.case_id), 'pending_fulfilment');
});

test('K-SOD-DISTINCT 同一張單每一關都是不同的人：在前一關簽過的人不是後一關的候選人，也不能認領', async () => {
    const c = await submit('p04');
    await decide('p03', c.case_id);
    await call(app, 'task_claim', users.p16.session, c.case_id);
    await decide('p16', c.case_id);
    // 執行關（同一個群組）：p16 已經在檢查關簽過
    await rejectsWith(call(app, 'task_claim', users.p16.session, c.case_id), 'NOT_CLAIMABLE');
    const basis = await taskBasis(c.case_id);
    assert.deepEqual([...basis.candidates].sort(), [users.p17.personId, users.p18.personId].sort());
    // 申請人自己是群組成員時同樣排除（K-SOD-APPLICANT）：p17 送的單，檢查關的候選人不含 p17
    const own = await submit('p17');
    assert.deepEqual(own.waiting_on, ['謝明哲']);
    await decide('p16', own.case_id);
    const ownBasis = await taskBasis(own.case_id);
    assert.deepEqual(ownBasis.candidates, [users.p18.personId]);
});

test('K-FULFIL 核准完成才進入執行；執行人以決定證明標記完成後才生效，並建立授權', async () => {
    const c = await submit('p04');
    await decide('p03', c.case_id);
    await call(app, 'task_claim', users.p16.session, c.case_id);
    assert.equal(await decide('p16', c.case_id), 'pending_fulfilment');
    const pending = await call(app, 'case_get', users.p04.session, c.case_id);
    assert.equal(pending.grant, null);
    assert.match(pending.fulfilment.payload_sha256, /^[0-9a-f]{64}$/);
    await call(app, 'task_claim', users.p17.session, c.case_id);
    const ch = await issueChallenge(app, users.p17, c.case_id, 'fulfil');
    assert.equal(ch.binding.input.payload_sha256, pending.fulfilment.payload_sha256);
    assert.equal(await decidePasskey(app, ch.challenge_id, 'fulfil', users.p17.key.assert(ch.challenge)), 'active');
    const done = await call(app, 'case_get', users.p04.session, c.case_id);
    assert.equal(done.grant.status, 'active');
    const events = await admin.query(`select event_type from sgn.audit_event where case_id = $1 order by seq`, [c.case_id]);
    assert.ok(events.rows.some((r) => r.event_type === 'case.approval_completed'));
    assert.equal(events.rows.at(-1).event_type, 'grant.activated');
});

test('K-TOP-RESOLVER 沒有主管的人：主管關交給路徑設定的最終決定者（董事長），紀錄寫明依據', async () => {
    const c = await submit('p01');
    assert.deepEqual(c.waiting_on, ['郭永昌']);
    const basis = await taskBasis(c.case_id);
    assert.equal(basis.via, 'top_resolver');
    assert.equal(await decide('p27', c.case_id), 'in_approval');
});

test('K-AUDITOR-INDEPENDENT 稽核角色的人不會被指派：稽核員的主管是稽核主任（稽核角色），往上一層找', async () => {
    const c = await submit('p22', PROBE);
    assert.deepEqual(c.waiting_on, ['高志遠']);
    const basis = await taskBasis(c.case_id);
    assert.equal(basis.via, 'manager_chain');
    assert.equal(basis.path[0].denied, 'DECIDER_ROLE_EXCLUDED');
});

test('K-REJECT 駁回是終局：工作與關卡都結束，之後沒有任何人可以再做動作；必須填原因', async () => {
    const c = await submit('p04', PROBE);
    await rejectsWith(issueChallenge(app, users.p03, c.case_id, 'reject', {}), 'REASON_REQUIRED');
    assert.equal(await decide('p03', c.case_id, 'reject', { reason: '用途不明確' }), 'rejected');
    const view = await call(app, 'case_get', users.p04.session, c.case_id);
    assert.deepEqual(view.actions, []);
    assert.equal(view.stages[0].tasks[0].status, 'rejected');
    assert.equal(view.stages[0].tasks[0].reason, '用途不明確');
    await rejectsWith(call(app, 'case_submit', users.p04.session, c.case_id, null), 'STATE_TRANSITION');
});

test('K-RECALL 申請人可以把簽核中的單撤回（需要決定證明），狀態轉 returned；簽核人不能再決定', async () => {
    const c = await submit('p04', PROBE);
    assert.deepEqual(c.actions, ['recall']);
    assert.equal(await decide('p04', c.case_id, 'recall', { reason: '要補一個欄位' }), 'returned');
    await rejectsWith(issueChallenge(app, users.p03, c.case_id), 'STATE_TRANSITION');
    const view = await call(app, 'case_get', users.p04.session, c.case_id);
    assert.deepEqual(view.actions, ['revise', 'submit']);
    assert.equal(view.stages[0].status, 'returned');
});

test('K-CHANGE-EXPAND 沒有比較 hook 的流程：任何內容修改都算擴大，退回後重送從第一關重簽；不修改就從退回的那一關繼續（K-RETURN）', async () => {
    const c = await submit('p04', CHAIN, { n: 1 });
    await decide('p03', c.case_id);
    await call(app, 'task_claim', users.p16.session, c.case_id);
    assert.equal(await decide('p16', c.case_id, 'return', { reason: '再確認' }), 'returned');
    // 不修改直接重送：從退回的那一關（check）繼續，主管關仍然有效
    const resumed = await call(app, 'case_submit', users.p04.session, c.case_id, null);
    assert.equal(resumed.current_stage.code, 'check');
    await call(app, 'task_claim', users.p16.session, c.case_id);
    assert.equal(await decide('p16', c.case_id, 'return', { reason: '再確認一次' }), 'returned');
    // 修改內容後重送：擴大，從第一關重簽
    const revised = await call(app, 'case_revise', users.p04.session, c.case_id, { n: 2 }, {});
    assert.equal(revised.versions.at(-1).change_kind, 'expand');
    const restarted = await call(app, 'case_submit', users.p04.session, c.case_id, null);
    assert.equal(restarted.current_stage.code, 'manager');
    assert.deepEqual(
        restarted.stages.filter((s) => s.status !== 'cancelled' && s.status !== 'returned').map((s) => s.code),
        ['manager'],
    );
    const submitted = await one(
        admin,
        `select convert_from(body, 'UTF8')::jsonb -> 'data' -> 'path' as path from sgn.audit_event
         where case_id = $1 and event_type = 'case.submitted' order by seq desc limit 1`,
        [c.case_id],
    );
    assert.deepEqual(submitted.path, { mode: 'restart', change_kind: 'expand', compared_with: 1, resume_seq: 20 });
});
