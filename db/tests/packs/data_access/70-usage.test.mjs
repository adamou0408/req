// 使用紀錄的批次摘要（裁決 D92 (4)；db/kernel/545_usage_summary.sql；威脅表 docs/handoff/closed-loop-1.md）：
// 對帳程式（sgn_reconciler）拉外部系統簽過的一批摘要交給資料庫；只採信證明、簽發時間嚴格遞增、整批的雜湊進鏈；
// 單的頁面與稽核頁顯示最後使用時間與近幾天的次數；閒置的授權提醒收回（不自動撤銷）。
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { call, closePools, login, one, pool, registerPasskey, rejectsWith, setSetting } from '../../kernel/lib/harness.mjs';
import { activeSalesOrderCase, CHANNEL, deliveryPool, drain, mockDc, systemDelivery } from './delivery-lib.mjs';
import { principals } from './lib.mjs';

const app = pool('APP');
const admin = pool('ADMIN');
const reconciler = pool('RECONCILER');
const scheduler = pool('SCHEDULER');
const delivery = deliveryPool();
const users = {};
let dc;
let used;
let idle;

before(async () => {
    for (const uid of ['p04', 'p22']) users[uid] = await login(app, uid);
    users.p04.key = await registerPasskey(app, users.p04);
    await principals(app, users.p04.session);
    await systemDelivery(admin);
    dc = await mockDc(admin);
    await drain(delivery, dc);
    used = await activeSalesOrderCase(app, admin, users.p04, 2140);
    idle = await activeSalesOrderCase(app, admin, users.p04, 2141);
});
after(async () => {
    await delivery.end();
    await closePools();
});

const view = (caseId) => call(app, 'case_get', users.p04.session, caseId);
const caseNo = async (caseId) => String((await view(caseId)).case_no);
const HOUR = 3600000;
function period(hoursAgo) {
    const from = new Date(Math.floor((Date.now() - hoursAgo * HOUR) / HOUR) * HOUR);
    return { from: from.toISOString(), to: new Date(from.getTime() + HOUR).toISOString() };
}
// 每一筆帶這張單的規則所在的區（K-USAGE-DETAIL：salesOrderContent 沒有指定環境，是測試區）
function item(no, actor, p, counts, last = new Date(Date.parse(p.from) + 60000).toISOString()) {
    return {
        case_no: no,
        actor: { provider: 'sim-ldap', external_id: actor },
        period: p,
        ...counts,
        last_used_at: last,
        environment: 'test',
    };
}
const batch = (items) => ({ format: 'usage_summary_batch/2', database: 'mock', period_seconds: 3600, items });
const submit = async (response) => (await one(reconciler, 'select api_job.usage_submit($1, $2) as r', [CHANNEL, response])).r;
const openCount = async (rule) =>
    (await one(admin, `select count(*)::int as n from sgn.exception_record where rule_code = $1 and closed_at is null`, [rule])).n;

test('K-USAGE-ATTESTED K-USAGE-BATCH-AUDIT 收下外部系統簽過的一批：整批一筆稽核事件（雜湊、筆數），不逐筆進鏈；單的頁面與稽核頁顯示最後使用時間與近幾天的次數；同一個鍵在之後的一批以最新的為準', async () => {
    const no = await caseNo(used);
    const p = period(2);
    const r = await submit(
        dc.usage(
            batch([item(no, 'p04', p, { queries: 3, exports: 0, blocked: 1 }), item(no, 'p05', p, { queries: 1, exports: 0, blocked: 0 })]),
        ),
    );
    assert.equal(r.status, 'accepted');
    assert.equal(r.items, 2);
    let v = await view(used);
    assert.deepEqual([v.usage.queries, v.usage.exports, v.usage.blocked, v.usage.people], [4, 0, 1, 2]);
    assert.equal(v.usage.recent_days, 30);
    assert.equal(Date.parse(v.usage.last_used_at), Date.parse(p.from) + 60000);
    const ev = await one(
        admin,
        `select convert_from(e.body, 'UTF8')::jsonb -> 'data' as d, b.batch_sha256, b.event_seq = e.seq as linked
         from sgn.usage_batch as b join sgn.audit_event as e on e.seq = b.event_seq where b.id = $1`,
        [r.batch],
    );
    assert.ok(ev.linked);
    assert.equal(ev.d.items, 2);
    assert.equal(ev.d.batch_sha256, ev.batch_sha256.toString('hex'));
    assert.deepEqual(ev.d.rules, ['K-USAGE-ATTESTED', 'K-USAGE-BATCH-AUDIT', 'K-DELIVERY-ATTESTED']);
    const perRow = await one(admin, `select count(*)::int as n from sgn.audit_event where case_id = $1 and event_type like 'usage.%'`, [
        used,
    ]);
    assert.equal(perRow.n, 0, '摘要不逐筆進鏈');
    // 時段還沒結束：之後的一批同一個鍵次數增加，以最新的為準（重送不重複計算）
    assert.equal((await submit(dc.usage(batch([item(no, 'p04', p, { queries: 5, exports: 1, blocked: 1 })])))).status, 'accepted');
    v = await view(used);
    assert.deepEqual([v.usage.queries, v.usage.exports, v.usage.people], [6, 1, 2]);
    const auditor = await call(app, 'audit_case', users.p22.session, Number(no));
    assert.deepEqual(auditor.usage, v.usage);
    assert.equal((await view(idle)).usage, null, '沒有回報的單是 null');
    await rejectsWith(admin.query('update sgn.usage_summary set query_count = 0'), 'USAGE_APPEND_ONLY');
    await rejectsWith(admin.query('delete from sgn.usage_batch'), 'USAGE_APPEND_ONLY');
});

test('K-USAGE-UNVERIFIED 不收的一批：證明不符、別的端點的回應、重送、簽發時間不比上一批新、對不到這個通道的單、次數不合理、太多筆；開例外並升級（同一通道在新鮮度內一筆）', async () => {
    const no = await caseNo(used);
    const p = period(3);
    const older = dc.usage(batch([item(no, 'p04', p, { queries: 1, exports: 0, blocked: 0 })]));
    const newer = dc.usage(batch([item(no, 'p04', p, { queries: 2, exports: 0, blocked: 0 })]));
    assert.equal((await submit(newer)).status, 'accepted');
    const reasons = [];
    const reject = async (response) => {
        const r = await submit(response);
        assert.equal(r.status, 'rejected');
        reasons.push(r.reason);
    };
    await reject(newer);
    await reject(older);
    const tampered = dc.usage(batch([item(no, 'p04', p, { queries: 9, exports: 0, blocked: 0 })]));
    tampered.attestation.payload = tampered.attestation.payload.replace('"queries":9', '"queries":0');
    await reject(tampered);
    await reject(dc.reconciliation(batch([])));
    await reject(dc.usage(batch([item('999999', 'p04', p, { queries: 1, exports: 0, blocked: 0 })])));
    await reject(dc.usage(batch([item(no, 'p04', p, { queries: -1, exports: 0, blocked: 0 })])));
    await reject(dc.usage(batch([item(no, 'p04', p, { queries: 10000001, exports: 0, blocked: 0 })])));
    await reject(
        dc.usage(batch([item(no, 'p04', p, { queries: 1, exports: 0, blocked: 0 }, new Date(Date.parse(p.to) + 1).toISOString())])),
    );
    await reject(dc.usage(batch([item(no, 'p04', period(-2), { queries: 1, exports: 0, blocked: 0 })])));
    await setSetting(admin, 'usage.max_items', 1, `channel:${CHANNEL}`);
    try {
        await reject(
            dc.usage(
                batch([
                    item(no, 'p04', p, { queries: 1, exports: 0, blocked: 0 }),
                    item(no, 'p05', p, { queries: 1, exports: 0, blocked: 0 }),
                ]),
            ),
        );
    } finally {
        await setSetting(admin, 'usage.max_items', 20000, `channel:${CHANNEL}`);
    }
    assert.deepEqual(reasons, [
        'replay',
        'not_newer',
        'unverified',
        'unverified',
        'item_invalid',
        'item_invalid',
        'item_invalid',
        'item_invalid',
        'item_invalid',
        'too_many_items',
    ]);
    assert.equal((await view(used)).usage.queries >= 2, true, '不收的批次不影響已收下的摘要');
    const x = await admin.query(
        `select detail from sgn.exception_record where rule_code = 'K-USAGE-UNVERIFIED' and detail ->> 'channel' = $1`,
        [CHANNEL],
    );
    assert.equal(x.rowCount, 1, '新鮮度的時間內一筆');
});

test('K-USAGE-IDLE 生效超過參數天數仍沒有任何查詢或匯出（只看回報過使用摘要的通道）：開例外並通知申請人與被授權者負責人，不撤銷；之後有使用就結案', async () => {
    await setSetting(admin, 'usage.idle_alert_days', 0, 'process:data_access');
    try {
        await one(scheduler, 'select api_job.usage_checks() as r');
        const open = async (caseId) =>
            (
                await admin.query(
                    `select id from sgn.exception_record where rule_code = 'K-USAGE-IDLE' and case_id = $1 and closed_at is null`,
                    [caseId],
                )
            ).rowCount;
        assert.equal(await open(idle), 1);
        assert.equal(await open(used), 0, '有使用的單不算閒置');
        await one(scheduler, 'select api_job.usage_checks() as r');
        assert.equal(await open(idle), 1, '同一張單未結案時不重開');
        const notified = await admin.query(
            `select person_id from sgn.notification_outbox where case_id = $1 and event_code = 'usage.idle'`,
            [idle],
        );
        assert.deepEqual(
            notified.rows.map((r) => r.person_id),
            [users.p04.personId],
            '申請人就是被授權者負責人（sales-report-bot），通知一則',
        );
        assert.equal((await view(idle)).state, 'active', '不自動撤銷');
        await submit(dc.usage(batch([item(await caseNo(idle), 'p04', period(1), { queries: 1, exports: 0, blocked: 0 })])));
        assert.equal(await open(idle), 0, '有使用就結案');
    } finally {
        await setSetting(admin, 'usage.idle_alert_days', 30, 'process:data_access');
    }
});

test('K-USAGE-OVERDUE 回報過使用摘要的通道超過參數的時間沒有新的一批：開例外並升級（每段逾期一筆）', async () => {
    await setSetting(admin, 'usage.max_interval_seconds', 0, `channel:${CHANNEL}`);
    try {
        const before = await openCount('K-USAGE-OVERDUE');
        await one(scheduler, 'select api_job.usage_checks() as r');
        await one(scheduler, 'select api_job.usage_checks() as r');
        assert.equal(await openCount('K-USAGE-OVERDUE'), before + 1);
    } finally {
        await setSetting(admin, 'usage.max_interval_seconds', 600, `channel:${CHANNEL}`);
    }
});
