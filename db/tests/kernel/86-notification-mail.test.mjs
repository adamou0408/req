// 通知真的寄出（裁決 D76）：mail port 的 SMTP adapter 的合約測試，對著 sim/mail 的 Mailpit（真的 SMTP 伺服器）跑。
// 待寄送佇列 → 寄送程式（api/src/notify.ts，以 sgn_job 連線）→ SMTP → 信箱裡看得到；失敗會放回佇列、超過次數標為失敗。
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { deliverPending } from '../../../api/src/notify.ts';
import { smtpMailer } from '../../../api/src/smtp.ts';
import { roleUrl } from '../../tools/lib/env.mjs';
import { closePools, config, login, newAuthenticator, one, pool, requestPasskey, setSetting } from './lib/harness.mjs';

const app = pool('APP');
const admin = pool('ADMIN');
const job = new pg.Pool({ connectionString: roleUrl(config, 'JOB'), max: 2 });
const smtp = { host: config.mail.SIM_MAIL_SMTP_HOST, port: Number(config.mail.SIM_MAIL_SMTP_PORT) };
const mailbox = `http://${config.mail.SIM_MAIL_HTTP_HOST}:${config.mail.SIM_MAIL_HTTP_PORT}/api/v1`;
const FROM = config.db.SGN_MAIL_FROM;

after(async () => {
    await job.end();
    await closePools();
});

/** 把佇列裡別的測試留下的通知先寄掉，這裡只看自己的。 */
before(async () => {
    while ((await deliverPending(job, smtpMailer(smtp), FROM)).sent > 0);
});

async function messagesTo(address, subjectPart) {
    const res = await fetch(`${mailbox}/search?query=${encodeURIComponent(`to:${address}`)}`);
    const body = await res.json();
    return body.messages.filter((m) => m.Subject.includes(subjectPart));
}

test('K-NOTIFY-DELIVERED 新金鑰登記的通知經 SMTP 寄給本人與主管：主旨與內文由範本產生（繁體中文不亂碼）', async () => {
    const p07 = await login(app, 'p07');
    const me = await one(admin, `select display_name, email from sgn.person where id = $1`, [p07.personId]);
    const manager = await one(
        admin,
        `select m.email from sgn.reporting_line r join sgn.person m on m.id = r.manager_person_id where r.person_id = $1 and r.valid_to is null`,
        [p07.personId],
    );
    await requestPasskey(app, p07, newAuthenticator());
    const result = await deliverPending(job, smtpMailer(smtp), FROM);
    assert.ok(result.sent >= 2, JSON.stringify(result));
    const subject = `${me.display_name} 登記了一把新的通行金鑰`;
    for (const address of [me.email, manager.email]) {
        const found = await messagesTo(address, subject);
        assert.ok(found.length >= 1, `${address} 收到「${subject}」`);
    }
    const [latest] = await messagesTo(me.email, subject);
    const full = await (await fetch(`${mailbox}/message/${latest.ID}`)).json();
    assert.match(full.Text, /金鑰指紋開頭 [0-9a-f]{16}/);
    const sent = await one(
        admin,
        `select count(*)::int as n from sgn.notification_outbox where event_code = 'passkey.enrollment_requested' and status = 'sent' and person_id = $1`,
        [p07.personId],
    );
    assert.ok(sent.n >= 1);
});

test('K-NOTIFY-DELIVERED SMTP 連不上：通知放回佇列並記下錯誤，超過 notification.max_attempts 次標為失敗；後端帳號領不到通知', async () => {
    const p08 = await login(app, 'p08');
    await requestPasskey(app, p08, newAuthenticator());
    const down = smtpMailer({ host: '127.0.0.1', port: 1 });
    await setSetting(admin, 'notification.max_attempts', 2);
    try {
        await deliverPending(job, down, FROM);
        let row = await one(
            admin,
            `select status, attempts, last_error from sgn.notification_outbox where person_id = $1 order by id desc limit 1`,
            [p08.personId],
        );
        assert.deepEqual([row.status, row.attempts], ['pending', 1]);
        assert.ok(row.last_error);
        await deliverPending(job, down, FROM);
        row = await one(admin, `select status, attempts from sgn.notification_outbox where person_id = $1 order by id desc limit 1`, [
            p08.personId,
        ]);
        assert.deepEqual([row.status, row.attempts], ['failed', 2]);
    } finally {
        await setSetting(admin, 'notification.max_attempts', 5);
    }
    await assert.rejects(app.query('select api_job.notification_claim(1)'), (err) => err.code === '42501');
});
