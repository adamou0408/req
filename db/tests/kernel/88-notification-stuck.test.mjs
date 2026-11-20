// 通知卡住要開例外（K-NOTIFY-STUCK）。威脅表見 docs/handoff/leftovers-1.md 第 5 節，每一列對應這裡的一個斷言。
// 攻擊者模型：拿到寄信角色 sgn_mailer 可以不寄；拿到排程角色 sgn_scheduler 可以不跑排程。
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { roleUrl } from '../../tools/lib/env.mjs';
import { PROBE, call, closePools, config, login, one, pool, setSetting } from './lib/harness.mjs';

const app = pool('APP');
const admin = pool('ADMIN');
const scheduler = new pg.Pool({ connectionString: roleUrl(config, 'SCHEDULER'), max: 2 });

after(async () => {
    await scheduler.end();
    await closePools();
});

const exceptionsFor = (notificationIds) =>
    admin
        .query(
            `select e.id, e.case_id, e.detail from sgn.exception_record e
             where e.rule_code = 'K-NOTIFY-STUCK' and (e.detail ->> 'notification_id')::bigint = any ($1::bigint[]) order by e.id`,
            [notificationIds],
        )
        .then((r) => r.rows);
const notificationsOf = (caseId) =>
    admin
        .query(`select id, status from sgn.notification_outbox where case_id = $1 order by id`, [caseId])
        .then((r) => r.rows.map((x) => x.id));
const defaultSeconds = () =>
    one(admin, `select default_value::int as v from sgn.setting_definition where key = 'notification.stuck_alert_seconds'`).then(
        (r) => r.v,
    );

test('K-NOTIFY-STUCK 通知超過參數時間沒寄出：排程開例外，每則一次；寄出的不算；例外不掛在申請單上', async () => {
    const applicant = await login(app, 'p25');
    try {
        await setSetting(admin, 'notification.stuck_alert_seconds', 1);
        // 列 1：寄送程式沒有在跑（或拿到 sgn_mailer 的人不寄）
        const caseId = (await call(app, 'case_submit_new', applicant.session, PROBE, { dataset: 'stuck', n: Math.random() }, {}, null))
            .case_id;
        const ids = await notificationsOf(caseId);
        assert.ok(ids.length > 0);
        // 列 3：已經寄出的不算卡住
        const sentCase = (await call(app, 'case_submit_new', applicant.session, PROBE, { dataset: 'sent', n: Math.random() }, {}, null))
            .case_id;
        const sentIds = await notificationsOf(sentCase);
        await admin.query(`update sgn.notification_outbox set status = 'sent', sent_at = clock_timestamp() where id = any ($1::bigint[])`, [
            sentIds,
        ]);
        await sleep(1100);
        const r = (await scheduler.query('select api_job.notification_stuck_check() as r')).rows[0].r;
        assert.ok(r.opened >= ids.length);
        const opened = await exceptionsFor(ids);
        assert.deepEqual(
            opened.map((e) => Number(e.detail.notification_id)),
            ids.map(Number),
        );
        assert.ok(
            opened.every(
                (e) => e.case_id === null && e.detail.case_id === caseId && e.detail.settings['notification.stuck_alert_seconds'] === 1,
            ),
        );
        assert.deepEqual(await exceptionsFor(sentIds), []);
        // 每則只開一次
        await scheduler.query('select api_job.notification_stuck_check()');
        assert.equal((await exceptionsFor(ids)).length, ids.length);
        // 申請單的例外（決定畫面）不受影響
        assert.deepEqual((await call(app, 'case_get', applicant.session, caseId)).exceptions, []);
    } finally {
        await setSetting(admin, 'notification.stuck_alert_seconds', await defaultSeconds());
    }
});

test('K-NOTIFY-STUCK 排程也停了：下一個寫入通知的使用者動作就開例外（不只靠排程）', async () => {
    const applicant = await login(app, 'p26');
    try {
        await setSetting(admin, 'notification.stuck_alert_seconds', 1);
        // 列 2：寄信與排程完全停擺（不寄、不跑排程）
        const first = (await call(app, 'case_submit_new', applicant.session, PROBE, { dataset: 'stuck-2', n: Math.random() }, {}, null))
            .case_id;
        const ids = await notificationsOf(first);
        await sleep(1100);
        assert.deepEqual(await exceptionsFor(ids), []);
        // 另一個人經後端做了一件會寫通知的事
        await call(app, 'case_submit_new', applicant.session, PROBE, { dataset: 'stuck-3', n: Math.random() }, {}, null);
        assert.equal((await exceptionsFor(ids)).length, ids.length);
        // 例外看得到：稽核的例外清單
        const auditor = await login(app, 'p22');
        const listed = await call(app, 'audit_exceptions', auditor.session);
        assert.ok(listed.some((e) => e.rule_code === 'K-NOTIFY-STUCK'));
    } finally {
        await setSetting(admin, 'notification.stuck_alert_seconds', await defaultSeconds());
    }
});
