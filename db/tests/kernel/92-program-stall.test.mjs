// 紅隊第七輪 中-2（裁決 D88 (3)；redteam/exploits/47）：存活檢查不能只靠被檢查的程式。威脅小表見 docs/handoff/redteam-fixes-7.md 第 1 節。
// 「拿掉防線就失敗」：
//   - 心跳只檢查自己（或只有排程檢查）→ 第二個測試「寄信程式的心跳發現排程停了」失敗（列 S2）
//   - 任何程式角色都能替別人報心跳 → 第一個測試失敗（列 S1）
//   - 逾期工作只靠排程與交付程式自己發現 → 第三個測試失敗（列 S3）
//   - 稽核頁不觸發檢查（所有程式都停了就沒有訊號）→ 第四個測試失敗（列 S4）
//   - 頁面自行推斷「逾期」→ 單的 overdue 由資料庫算，這裡直接比對 case_get（列 S5）
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { activeSalesOrderCase, confirmableSalesOrderCase, deliveryPool, drain, mockDc } from '../packs/data_access/delivery-lib.mjs';
import { call, closePools, login, one, pool, rejectsPermission, rejectsWith, setSetting } from './lib/harness.mjs';

const admin = pool('ADMIN');
const app = pool('APP');
const programs = {
    jobs: { db: pool('SCHEDULER'), fn: 'api_job.scheduler_heartbeat' },
    mailer: { db: pool('MAILER'), fn: 'api_job.mailer_heartbeat' },
    reconciler: { db: pool('RECONCILER'), fn: 'api_job.reconciler_heartbeat' },
    anchor: { db: pool('ANCHOR'), fn: 'api_job.anchor_heartbeat' },
    delivery: { db: pool('DELIVERY'), fn: 'api_delivery.delivery_heartbeat' },
    'idp-keys': { db: pool('IDP_KEYS'), fn: 'api_idp.idp_keys_heartbeat' },
};
let applicant;
let auditor;

before(async () => {
    applicant = await login(app, 'p04');
    auditor = await login(app, 'p22');
    // 測試裡每次心跳都要跑檢查（預設最少間隔 program.stall_check_interval_seconds 秒）
    await setSetting(admin, 'program.stall_check_interval_seconds', 0);
});
after(async () => {
    await setSetting(admin, 'program.stall_check_interval_seconds', 10);
    await closePools();
});

const beat = (code) => one(programs[code].db, `select ${programs[code].fn}() as r`).then((r) => r.r);
const beatAll = async () => {
    for (const code of Object.keys(programs)) await beat(code);
};
const openFor = (subject) =>
    admin
        .query(
            `select id, detail from sgn.exception_record where rule_code = 'K-PROGRAM-STALLED' and closed_at is null and detail ->> 'subject' = $1`,
            [subject],
        )
        .then((r) => r.rows);
const maxId = async (table) => (await one(admin, `select coalesce(max(id), 0)::bigint as x from ${table}`)).x;
const ageProgram = (code, seconds) =>
    admin.query(`update sgn.program set last_seen = clock_timestamp() - make_interval(secs => $2) where code = $1`, [code, seconds]);
const heartbeatMax = (code) =>
    one(admin, `select (sgn_internal.setting('program.heartbeat_max_seconds', array['program:' || $1::text]) #>> '{}')::int as s`, [
        code,
    ]).then((r) => r.s);

test('K-PROGRAM-STALLED 每個背景程式只能用自己的資料庫角色報自己的心跳（拿到一個程式的密鑰不能替別的程式報平安）', async () => {
    for (const [code, p] of Object.entries(programs)) {
        await beat(code);
        const row = await one(admin, 'select last_seen, first_seen from sgn.program where code = $1', [code]);
        assert.ok(row.last_seen && row.first_seen, code);
        // 列 S1：別的程式的心跳函式一律沒有權限
        for (const [other, q] of Object.entries(programs)) {
            if (other !== code) await rejectsPermission(p.db.query(`select ${q.fn}()`));
        }
    }
    await rejectsPermission(app.query('select api_job.scheduler_heartbeat()'));
});

test('K-PROGRAM-STALLED 排程停了：寄信程式的心跳就會發現（不靠排程自己），開例外並通知；同一個對象不重複開；排程回來就結案。從沒回報過的程式在第一個程式開始回報之後才起算', async () => {
    await beatAll();
    const n0 = await maxId('sgn.notification_outbox');
    await ageProgram('jobs', (await heartbeatMax('jobs')) + 60);
    // 列 S2：被檢查的程式停了，別的程式照樣檢查
    assert.equal((await beat('mailer')).checked, true);
    const [ex] = await openFor('program:jobs');
    assert.equal(ex.detail.kind, 'heartbeat');
    assert.equal(ex.detail.settings['program.heartbeat_max_seconds'], await heartbeatMax('jobs'));
    const people = (await one(admin, `select sgn_internal.roles_holders(sgn_internal.setting('program.stalled_notify_roles')) as p`)).p;
    const notified = await admin.query(
        `select distinct person_id from sgn.notification_outbox where event_code = 'program.stalled' and id > $1`,
        [n0],
    );
    assert.deepEqual(notified.rows.map((r) => r.person_id).sort(), [...people].sort());
    await beat('reconciler');
    assert.equal((await openFor('program:jobs')).length, 1, '同一個對象只開一筆');
    await beat('jobs');
    assert.deepEqual(await openFor('program:jobs'), [], '回來就結案');
    const closed = await one(admin, 'select closed_at, close_detail from sgn.exception_record where id = $1', [ex.id]);
    assert.ok(closed.closed_at);
    // 從沒回報過的程式：建置之後、程式啟動之前的空檔不算（從第一個程式開始回報時起算）
    await admin.query(`update sgn.program set last_seen = null, first_seen = null where code = 'idp-keys'`);
    await beat('mailer');
    assert.deepEqual(await openFor('program:idp-keys'), []);
    await admin.query(
        `update sgn.program set first_seen = first_seen - interval '1 day', registered_at = registered_at - interval '1 day'
         where first_seen is not null or code = 'idp-keys'`,
    );
    await beat('mailer');
    assert.equal((await openFor('program:idp-keys')).length, 1, '其他程式早就在跑了，它卻從沒回報');
    await beat('idp-keys');
    assert.deepEqual(await openFor('program:idp-keys'), []);
});

test('K-PROGRAM-STALLED 逾期的工作沒人處理（授權到期、確認逾期、交付逾時）：任何一個程式的心跳都會開例外；單的 overdue 由資料庫算，處理之後消失、例外結案', async () => {
    const view = (caseId) => call(app, 'case_get', applicant.session, caseId);
    // 授權迄日已過（模擬排程停擺期間過了迄日）
    const active = await activeSalesOrderCase(app, admin, applicant, 2091);
    await admin.query('update sgn.grant_record set valid_to = current_date - 1 where case_id = $1', [active]);
    // 列 S5：單的頁面與首頁清單都有 overdue（資料庫算）
    assert.equal((await view(active)).overdue.kind, 'grant_expiry');
    assert.equal((await call(app, 'case_list_mine', applicant.session)).find((c) => c.case_id === active).overdue.kind, 'grant_expiry');
    await setSetting(admin, 'program.overdue_max_seconds', 0, 'work:grant_expiry');
    try {
        // 列 S3：交付程式的心跳（不是排程）發現
        await beat('delivery');
        const [ex] = await openFor('work:grant_expiry');
        assert.equal(ex.detail.work, 'grant_expiry');
        assert.ok(ex.detail.count >= 1);
        // 排程處理掉之後：單上沒有警示、例外結案
        await programs.jobs.db.query('select api_job.grant_expire_due()');
        assert.equal((await view(active)).state, 'expired');
        assert.equal((await view(active)).overdue, null);
        await beat('anchor');
        assert.deepEqual(await openFor('work:grant_expiry'), []);
    } finally {
        await setSetting(admin, 'program.overdue_max_seconds', 600, 'work:grant_expiry');
    }
    // 確認期限已過（排程與交付程式的領取都停了）
    const waiting = await confirmableSalesOrderCase(app, admin, applicant, 2092);
    await admin.query(
        `update sgn.case_confirmation set due_at = clock_timestamp() - interval '2 hours' where case_id = $1 and status = 'pending'`,
        [waiting],
    );
    assert.equal((await view(waiting)).overdue.kind, 'confirmation_expiry');
    await beat('mailer');
    assert.equal((await openFor('work:confirmation_expiry')).length, 1, '超過 program.overdue_max_seconds（預設 600 秒）');
    await programs.jobs.db.query('select api_job.confirmation_expire_due()');
    assert.equal((await view(waiting)).state, 'revoked');
    // 撤回排著送不出去（交付程式停了）：交付逾時
    await admin.query(
        `update sgn.delivery_op set created_at = created_at - interval '1 day' where case_id = $1 and status in ('queued', 'sending')`,
        [waiting],
    );
    assert.equal((await view(waiting)).overdue.kind, 'delivery');
    await beat('reconciler');
    assert.deepEqual(await openFor('work:confirmation_expiry'), [], '確認逾期處理掉了');
    assert.equal((await openFor('work:delivery')).length, 1);
    const delivery = deliveryPool();
    try {
        await drain(delivery, await mockDc(admin));
    } finally {
        await delivery.end();
    }
    assert.equal((await view(waiting)).overdue, null);
    await beat('mailer');
    assert.deepEqual(await openFor('work:delivery'), []);
});

test('K-PROGRAM-STALLED 所有程式都停了：稽核頁一打開就檢查（開例外、列出每個程式最後一次回報）；只限稽核角色；程式回來之後稽核頁再看就結案', async () => {
    for (const code of Object.keys(programs)) await ageProgram(code, (await heartbeatMax(code)) + 60);
    await rejectsWith(call(app, 'program_health', applicant.session), 'AUDITOR_REQUIRED');
    // 列 S4：沒有任何程式在跑，稽核頁的檢查照樣開例外
    const h = await call(app, 'program_health', auditor.session);
    assert.deepEqual(
        h.programs
            .filter((p) => p.stalled)
            .map((p) => p.code)
            .sort(),
        Object.keys(programs).sort(),
    );
    for (const code of Object.keys(programs)) assert.equal((await openFor(`program:${code}`)).length, 1, code);
    await beatAll();
    const back = await call(app, 'program_health', auditor.session);
    assert.deepEqual(
        back.programs.filter((p) => p.stalled),
        [],
    );
    for (const code of Object.keys(programs)) assert.deepEqual(await openFor(`program:${code}`), [], code);
});
