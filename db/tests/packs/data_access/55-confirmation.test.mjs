// 申請人確認驗證結果（rules.md「驗證中」「申請人逾期沒有確認驗證結果，自動撤銷」；骨幹 K-CONFIRM）。
// 威脅小表見 docs/handoff/applicant-confirm.md 第 1 節：每一列對應這裡的一個斷言（列號寫在註解）。
// 交付程式（sgn_delivery）＋模擬的外部系統（api/src/dcMock.ts）；真的 sim/dc 在端對端（e2e/tests/system-delivery.test.mjs）。
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { call, closePools, login, one, pool, registerPasskey, rejectsWith, setSetting } from '../../kernel/lib/harness.mjs';
import { CHANNEL, confirmVerification, deliveryPool, drain, mockDc, salesOrderContent, systemDelivery } from './delivery-lib.mjs';
import { DA, decide, principals, today } from './lib.mjs';

const app = pool('APP');
const admin = pool('ADMIN');
const job = pool('JOB');
const delivery = deliveryPool();
const users = {};
let P;
let dc;

before(async () => {
    for (const uid of ['p03', 'p04', 'p05', 'p11', 'p17', 'p19', 'p02']) {
        users[uid] = await login(app, uid);
        users[uid].key = await registerPasskey(app, users[uid]);
    }
    P = await principals(app, users.p04.session);
    await systemDelivery(admin);
    dc = await mockDc(admin);
    await drain(delivery, dc);
});
after(async () => {
    await delivery.end();
    await closePools();
});

const view = (caseId, who = 'p04') => call(app, 'case_get', users[who].session, caseId);
const so = salesOrderContent;

/** applicant 替 sales-report-bot（負責人林怡君 p04）申請，各關核准（代填時先由負責人確認）。 */
async function approved(year, applicant = 'p04') {
    const t = { principal_id: P['sales-report-bot'], valid_from: today(), valid_to: today(60) };
    const c = await call(app, 'case_submit_new', users[applicant].session, DA, so(year), t, null);
    if (applicant !== 'p04') await decide(app, users.p04, c.case_id);
    await decide(app, users.p03, c.case_id);
    await decide(app, users.p11, c.case_id);
    await call(app, 'task_claim', users.p17.session, c.case_id);
    await decide(app, users.p17, c.case_id);
    return c.case_id;
}
/** 送到自動驗證全部通過、等申請人確認。 */
async function awaiting(year, applicant) {
    const caseId = await approved(year, applicant);
    await drain(delivery, dc);
    return caseId;
}
const events = async (caseId, type) =>
    (
        await admin.query(
            `select actor_person_id, convert_from(body, 'UTF8')::jsonb -> 'data' as data from sgn.audit_event
             where case_id = $1 and event_type = $2 order by seq`,
            [caseId, type],
        )
    ).rows;
const notified = async (caseId, event) =>
    (await admin.query('select person_id from sgn.notification_outbox where case_id = $1 and event_code = $2', [caseId, event])).rows.map(
        (r) => r.person_id,
    );
const exceptionCodes = async (caseId) =>
    (await admin.query('select rule_code from sgn.exception_record where case_id = $1 order by id', [caseId])).rows.map((r) => r.rule_code);

test('K-CONFIRM 自動驗證全部通過不直接生效：開確認（時限是參數、記進鏈）、還沒有授權；只有申請人本人能確認，確認後才生效', async () => {
    const caseId = await awaiting(2060);
    let v = await view(caseId);
    assert.equal(v.state, 'verifying');
    assert.equal(v.grant, null, '確認前沒有授權');
    assert.ok(v.delivery.verifications.every((r) => r.status === 'passed'));
    assert.equal(v.confirmation.status, 'pending');
    assert.equal(v.confirmation.due_workdays, 5, 'rules.md：驗證結果確認時限 5 個工作天');
    assert.equal(v.confirmation.workdays_left, 5);
    assert.deepEqual(v.actions, ['confirm_verification', 'dispute_verification', 'revoke']);
    const [opened] = await events(caseId, 'confirmation.opened');
    assert.deepEqual(opened.data.settings, { 'confirmation.due_workdays': 5 });
    assert.ok(opened.data.rules.includes('K-CONFIRM'));
    assert.equal(new Date(opened.data.due_at).getTime(), new Date(v.confirmation.due_at).getTime());
    assert.deepEqual(await notified(caseId, 'confirmation.requested'), [users.p04.personId]);
    // 列 1：主管、資料擁有者、MIS（都在這張單上簽過）都不能替申請人確認或回報；畫面上也沒有這兩個按鈕
    for (const who of ['p03', 'p11', 'p17']) {
        await rejectsWith(confirmVerification(app, users[who], caseId), 'NOT_APPLICANT');
        await rejectsWith(call(app, 'case_dispute_verification', users[who].session, caseId, '不是我的'), 'NOT_APPLICANT');
        assert.ok(!(await view(caseId, who)).actions.includes('confirm_verification'), who);
    }
    v = await confirmVerification(app, users.p04, caseId);
    assert.equal(v.state, 'active');
    assert.equal(v.grant.status, 'active');
    assert.equal(v.confirmation.status, 'confirmed');
    assert.equal(v.confirmation.decided_by.id, users.p04.personId);
    const [done] = await events(caseId, 'confirmation.confirmed');
    assert.equal(done.actor_person_id, users.p04.personId, '紀錄寫明是誰確認');
    assert.equal((await events(caseId, 'grant.activated')).length, 1);
    await rejectsWith(confirmVerification(app, users.p04, caseId), 'STATE_TRANSITION');
});

test('K-CONFIRM 代填：申請人不是被授權者的負責人時，確認的仍是申請人本人；負責人不能替他確認', async () => {
    const caseId = await awaiting(2061, 'p05');
    const v = await view(caseId, 'p05');
    assert.equal(v.confirmation.status, 'pending');
    assert.deepEqual(await notified(caseId, 'confirmation.requested'), [users.p05.personId]);
    // 列 6：負責人（第一關已確認過代填）也不能確認驗證結果
    await rejectsWith(confirmVerification(app, users.p04, caseId), 'NOT_APPLICANT');
    assert.equal((await confirmVerification(app, users.p05, caseId)).state, 'active');
});

test('K-CONFIRM 自動驗證還沒全部通過時不能確認、回報或撤銷（CONFIRMATION_NOT_OPEN）；驗證不一致的單不會開確認', async () => {
    const caseId = await approved(2062);
    // 只送出套用，驗證還在排：狀態已經是驗證中
    const { deliverChannel } = await import('../../../../api/src/delivery.ts');
    await deliverChannel(delivery, CHANNEL, { kind: 'mock', send: (item) => dc.send(item) });
    let v = await view(caseId);
    assert.equal(v.state, 'verifying');
    assert.equal(v.confirmation, null);
    assert.deepEqual(v.actions, []);
    // 列 3：跳過自動驗證直接確認
    await rejectsWith(confirmVerification(app, users.p04, caseId), 'CONFIRMATION_NOT_OPEN');
    await rejectsWith(call(app, 'case_dispute_verification', users.p04.session, caseId, 'x'), 'CONFIRMATION_NOT_OPEN');
    await rejectsWith(call(app, 'case_revoke', users.p04.session, caseId, 'x'), 'CONFIRMATION_NOT_OPEN');
    // 列 4：外部系統查詢的結果和預期不同（範圍內查不到）→ 不一致，不開確認，申請人無從「確認」錯的結果
    const wrong = {
        kind: 'mock',
        send: async (item) => {
            if (item.kind !== 'verify') return dc.send(item);
            const cases = JSON.parse(item.body).cases.map((c) => ({ code: c.code, actual: 'deny' }));
            return dc.reply(item, 200, { status: 'completed', results: cases });
        },
    };
    await drain(delivery, wrong);
    v = await view(caseId);
    assert.equal(v.state, 'fulfilment_failed');
    assert.equal(v.confirmation, null);
    await rejectsWith(confirmVerification(app, users.p04, caseId), 'STATE_TRANSITION');
    await drain(delivery, dc);
});

test('K-CONFIRM-DISPUTE 申請人回報結果不對：要原因；不生效、已送出的規則自動撤回、開例外、通知升級對象與負責人', async () => {
    const caseId = await awaiting(2063, 'p05');
    const caseNo = String((await view(caseId)).case_no);
    await rejectsWith(call(app, 'case_dispute_verification', users.p05.session, caseId, '  '), 'REASON_REQUIRED');
    const v = await call(app, 'case_dispute_verification', users.p05.session, caseId, '應該只有北區，卻也查得到中區');
    assert.equal(v.state, 'fulfilment_failed');
    assert.equal(v.grant, null);
    assert.equal(v.confirmation.status, 'disputed');
    assert.equal(v.confirmation.reason, '應該只有北區，卻也查得到中區');
    assert.deepEqual(v.actions, []);
    assert.ok((await exceptionCodes(caseId)).includes('K-CONFIRM-DISPUTE'));
    assert.deepEqual(v.delivery.ops.map((o) => [o.kind, o.status]).at(-1), ['withdraw', 'queued']);
    const [ev] = await events(caseId, 'case.verification_disputed');
    assert.equal(ev.actor_person_id, users.p05.personId);
    assert.deepEqual(ev.data.rules, ['K-CONFIRM-DISPUTE', 'K-DELIVERY-AUTO']);
    assert.equal(ev.data.withdrawals, 1);
    const to = await notified(caseId, 'confirmation.disputed');
    for (const who of ['p05', 'p04', 'p19', 'p17']) assert.ok(to.includes(users[who].personId), `${who} 收到通知`);
    await drain(delivery, dc);
    assert.equal(dc.store.get(caseNo).withdrawn, true, '外部系統上的規則撤回了');
    await rejectsWith(confirmVerification(app, users.p05, caseId), 'STATE_TRANSITION');
});

test('K-CONFIRM-TIMEOUT 逾期沒確認：不能再確認；排程自動撤銷並撤回；事件寫明規則代碼、期限與用到的參數值；時限是參數', async () => {
    // 時限是參數（流程類型 → 全域 → 預設），開確認時算好
    await setSetting(admin, 'confirmation.due_workdays', 2, `process:${DA}`);
    const caseId = await awaiting(2064);
    await setSetting(admin, 'confirmation.due_workdays', 5, `process:${DA}`);
    let v = await view(caseId);
    assert.equal(v.confirmation.due_workdays, 2);
    assert.equal(v.confirmation.workdays_left, 2, '之後改參數不影響已經開的確認');
    // 模擬時間過去：期限改到現在之前（資料庫擁有者，測試用）
    await admin.query(`update sgn.case_confirmation set due_at = clock_timestamp() - interval '1 second' where case_id = $1`, [caseId]);
    v = await view(caseId);
    assert.deepEqual(v.actions, ['dispute_verification', 'revoke'], '逾期後沒有確認的按鈕');
    // 列 5：逾期之後確認（排程還沒跑）
    await rejectsWith(confirmVerification(app, users.p04, caseId), 'CONFIRMATION_OVERDUE');
    assert.ok((await one(job, 'select api_job.confirmation_expire_due() as r')).r.expired >= 1);
    v = await view(caseId);
    assert.equal(v.state, 'revoked');
    assert.equal(v.grant, null);
    assert.equal(v.confirmation.status, 'expired');
    const [ev] = await events(caseId, 'case.confirmation_expired');
    assert.equal(ev.actor_person_id, null, '系統動作');
    assert.deepEqual(ev.data.rules, ['K-CONFIRM-TIMEOUT', 'K-DELIVERY-AUTO']);
    assert.deepEqual(ev.data.settings, { 'confirmation.due_workdays': 2 });
    assert.ok(ev.data.due_at);
    assert.equal(ev.data.withdrawals, 1);
    assert.deepEqual((await events(caseId, 'confirmation.expired'))[0].data.rules, ['K-CONFIRM-TIMEOUT']);
    assert.ok((await notified(caseId, 'confirmation.expired')).includes(users.p04.personId));
    assert.equal(v.delivery.ops.at(-1).kind, 'withdraw');
    await drain(delivery, dc);
    assert.equal(dc.store.get(String(v.case_no)).withdrawn, true);
    assert.equal((await one(job, 'select api_job.confirmation_expire_due() as r')).r.expired, 0, '同一張不重複撤銷');
});

test('K-CONFIRM-TIMEOUT 排程停擺也擋不住：交付程式的領取先處理逾期的確認', async () => {
    const caseId = await awaiting(2065);
    await admin.query(`update sgn.case_confirmation set due_at = clock_timestamp() - interval '1 second' where case_id = $1`, [caseId]);
    // 列 7：沒有呼叫排程，只有交付程式照常領取
    await drain(delivery, dc);
    const v = await view(caseId);
    assert.equal(v.state, 'revoked');
    assert.equal(v.delivery.ops.at(-1).kind, 'withdraw');
    assert.equal(v.delivery.ops.at(-1).status, 'done');
});

test('K-CONFIRM 等確認時也能撤銷（縮小到零）：確認作廢、規則撤回；申請人之外的撤銷者（MIS）也可以', async () => {
    const caseId = await awaiting(2066);
    const v = await call(app, 'case_revoke', users.p17.session, caseId, '用途取消');
    assert.equal(v.state, 'revoked');
    assert.equal(v.confirmation.status, 'cancelled');
    assert.equal(v.delivery.ops.at(-1).kind, 'withdraw');
    await rejectsWith(confirmVerification(app, users.p04, caseId), 'STATE_TRANSITION');
    await drain(delivery, dc);
});
