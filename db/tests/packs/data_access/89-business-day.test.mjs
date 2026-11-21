// 業務日（「今天是哪一天」）只有一個入口 sgn_internal.today()（參數 calendar.timezone）：資料庫工作階段的時區不影響
// 到期判定、到期前提醒的剩餘天數（功能第四批審查：UTC 16:00–24:00 台北已經是隔天，用 current_date 會差一天）。
// 時間的模擬：不能改時鐘，改用「和台北的日期一定不同」的工作階段時區——Etc/GMT+12 在台北 20:00 前、Pacific/Kiritimati
// 在台北 18:00 後都和台北不同一天，所以任何時刻至少有一個時區是跨日的。
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { closePools, login, one, pool } from '../../kernel/lib/harness.mjs';
import { activeSalesOrderCase } from './delivery-lib.mjs';
import { BUSINESS_TIMEZONE, today } from './lib.mjs';

const app = pool('APP');
const admin = pool('ADMIN');
const scheduler = pool('SCHEDULER');
after(closePools);

const ZONES = ['UTC', 'Asia/Taipei', 'Etc/GMT+12', 'Pacific/Kiritimati'];

/** 用指定的工作階段時區跑一段（預設管理者連線讀內部 function；排程的入口用 scheduler）。 */
async function inZone(zone, fn, db = admin) {
    const client = await db.connect();
    try {
        await client.query(`set timezone to '${zone}'`);
        return await fn(client);
    } finally {
        await client.query('reset timezone');
        client.release();
    }
}

test('K-EXPIRE-REMIND K-GRANT-EXPIRE 業務日只有一個入口：測試的 today() 與資料庫的 calendar.timezone、sgn_internal.today() 一致；工作階段時區（含跨日的）不影響到期判定與剩餘天數', async () => {
    assert.equal((await one(admin, `select sgn_internal.setting_text('calendar.timezone') as z`)).z, BUSINESS_TIMEZONE);
    assert.equal((await one(admin, 'select sgn_internal.today()::text as d')).d, today());
    const crossDay = [];
    for (const zone of ZONES) {
        const r = await inZone(zone, (c) =>
            c.query('select current_date::text as d, sgn_internal.today()::text as t').then((x) => x.rows[0]),
        );
        assert.equal(r.t, today(), `${zone}：業務日不隨工作階段時區改變`);
        if (r.d !== r.t) crossDay.push(zone);
    }
    assert.ok(crossDay.length >= 1, '至少有一個工作階段時區和業務日不同一天（真的測到跨日）');
    const applicant = await login(app, 'p04');
    const caseId = await activeSalesOrderCase(app, admin, applicant, 2901);
    const setTo = (expr) => admin.query(`update sgn.grant_record set valid_to = ${expr} where case_id = $1`, [caseId]);
    for (const zone of ZONES) {
        await inZone(zone, async (c) => {
            await setTo('sgn_internal.today() + 10');
            assert.equal(
                (await c.query('select count(*)::int as n from sgn_internal.grant_expiry_remind_pending($1)', [caseId])).rows[0].n,
                1,
                `${zone}：10 天內要提醒`,
            );
            await setTo('sgn_internal.today() + 15');
            assert.equal(
                (await c.query('select count(*)::int as n from sgn_internal.grant_expiry_remind_pending($1)', [caseId])).rows[0].n,
                0,
                `${zone}：15 天後不提醒`,
            );
            await setTo('sgn_internal.today()');
            assert.equal(
                (await c.query(`select count(*)::int as n from sgn_internal.overdue_work($1) where kind = 'grant_expiry'`, [caseId]))
                    .rows[0].n,
                0,
                `${zone}：迄日是今天還有效`,
            );
            await setTo('sgn_internal.today() - 1');
            assert.equal(
                (await c.query(`select count(*)::int as n from sgn_internal.overdue_work($1) where kind = 'grant_expiry'`, [caseId]))
                    .rows[0].n,
                1,
                `${zone}：迄日是昨天就該到期`,
            );
        });
    }
    // 在跨日的時區真的跑排程：剩餘天數是 10；迄日今天不到期、昨天到期
    const zone = crossDay[0];
    await setTo('sgn_internal.today() + 10');
    await inZone(zone, (c) => c.query('select api_job.grant_expiry_remind_due()'), scheduler);
    const ev = await one(
        admin,
        `select convert_from(body, 'UTF8')::jsonb -> 'data' as data from sgn.audit_event where case_id = $1 and event_type = 'grant.expiry_reminded'`,
        [caseId],
    );
    assert.equal(ev.data.days_left, 10, `${zone}：剩 10 天`);
    await setTo('sgn_internal.today()');
    await inZone(zone, (c) => c.query('select api_job.grant_expire_due()'), scheduler);
    assert.equal((await one(admin, 'select status from sgn.grant_record where case_id = $1', [caseId])).status, 'active');
    await setTo('sgn_internal.today() - 1');
    await inZone(zone, (c) => c.query('select api_job.grant_expire_due()'), scheduler);
    assert.equal((await one(admin, 'select status from sgn.grant_record where case_id = $1', [caseId])).status, 'expired');
});
