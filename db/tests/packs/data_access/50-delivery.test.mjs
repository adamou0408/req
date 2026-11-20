// 核准之後的系統對系統交付（裁決 D63；威脅表 docs/handoff/delivery.md）：交付程式（sgn_delivery）＋模擬的外部系統
// （api/src/dcMock.ts）。真的外部系統（sim/dc）在合約測試（db/tests/kernel/93-delivery-adapter.test.mjs）與端對端測試。
import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { after, before, test } from 'node:test';
import {
    call,
    closePools,
    login,
    one,
    pool,
    registerPasskey,
    rejectsPermission,
    rejectsWith,
    setSetting,
} from '../../kernel/lib/harness.mjs';
import { CHANNEL, CONTEXT, deliveryPool, drain, mockDc, ops, salesOrderContent, systemDelivery } from './delivery-lib.mjs';
import { DA, decide, principals, today } from './lib.mjs';

const app = pool('APP');
const admin = pool('ADMIN');
const job = pool('JOB');
const delivery = deliveryPool();
const users = {};
let P;
let dc;

before(async () => {
    for (const uid of ['p03', 'p04', 'p09', 'p11', 'p12', 'p15', 'p16', 'p17', 'p18', 'p19', 'p30', 'p02']) {
        users[uid] = await login(app, uid);
        users[uid].key = await registerPasskey(app, users[uid]);
    }
    P = await principals(app, users.p04.session);
    await systemDelivery(admin);
    dc = await mockDc(admin);
    // 前面的測試檔留下、還沒送的交付（例如契約測試撤銷的單）先送完，這裡只看自己的
    await drain(delivery, dc);
});
after(async () => {
    await delivery.end();
    await closePools();
});

const view = (caseId, who = 'p04') => call(app, 'case_get', users[who].session, caseId);
const so = salesOrderContent;
async function approved(year, content = so(year)) {
    const t = { principal_id: P['sales-report-bot'], valid_from: today(), valid_to: today(60) };
    const c = await call(app, 'case_submit_new', users.p04.session, DA, content, t, null);
    await decide(app, users.p03, c.case_id);
    await decide(app, users.p11, c.case_id);
    await call(app, 'task_claim', users.p17.session, c.case_id);
    await decide(app, users.p17, c.case_id);
    return c.case_id;
}
async function active(year, content) {
    const caseId = await approved(year, content);
    await drain(delivery, dc);
    assert.equal((await view(caseId)).state, 'active');
    return caseId;
}
const events = async (caseId) =>
    (await admin.query('select event_type from sgn.audit_event where case_id = $1 order by seq', [caseId])).rows.map((r) => r.event_type);
const exceptionCodes = async (caseId) =>
    (await admin.query('select rule_code from sgn.exception_record where case_id = $1 order by id', [caseId])).rows.map((r) => r.rule_code);
/** 包一層 port：讓某種交付的回應換成指定的樣子（模擬外部系統停掉、拒絕、或交付程式動手腳）。 */
const wrap = (fn) => ({ kind: 'mock', send: (item) => fn(item) });

test('K-DELIVERY-AUTO 系統對系統：核准完成後執行關不開人工工作；自動套用 → 驗證中 → 自動驗證通過 → 生效，全程沒有人工執行', async () => {
    const caseId = await approved(2010);
    let v = await view(caseId);
    assert.equal(v.state, 'pending_fulfilment');
    assert.equal(v.current_stage.code, 'fulfil');
    assert.deepEqual(v.waiting_on, []);
    assert.deepEqual(v.stages.find((s) => s.code === 'fulfil').tasks, [], '人工退路只在交付方式是人工時出現');
    assert.deepEqual(v.actions, []);
    assert.deepEqual(
        v.delivery.ops.map((o) => [o.kind, o.status]),
        [['apply', 'queued']],
    );
    const [apply] = await ops(admin, caseId);
    assert.deepEqual(JSON.parse(apply.body), v.fulfilment.payload, '送出的就是核准那一版產生的規則');
    assert.equal(await deliverChannelOnce(), 1);
    v = await view(caseId);
    assert.equal(v.state, 'verifying');
    await drain(delivery, dc);
    v = await view(caseId);
    assert.equal(v.state, 'active');
    assert.equal(v.grant.status, 'active');
    assert.deepEqual(
        v.delivery.ops.map((o) => [o.kind, o.status, o.attempts]),
        [
            ['apply', 'done', 1],
            ['verify', 'done', 1],
        ],
    );
    assert.equal(v.delivery.verifications[0].status, 'passed');
    const ev = await events(caseId);
    for (const e of [
        'delivery.queued',
        'delivery.succeed',
        'case.delivery_applied',
        'verification.started',
        'verification.passed',
        'grant.activated',
    ]) {
        assert.ok(ev.includes(e), e);
    }
    assert.ok(!(await exceptionCodes(caseId)).includes('K-DELIVERY-MANUAL'));
});

async function deliverChannelOnce() {
    const { deliverChannel } = await import('../../../../api/src/delivery.ts');
    return deliverChannel(delivery, CHANNEL, dc);
}

test('DA-VERIFY-CASES 驗證案例由送出的規則產生：範圍內應允許；列條件外、未申請的欄位、資料期間外、匯出、到期後應拒絕', async () => {
    const caseId = await active(2040);
    const [run] = (await view(caseId)).delivery.verifications;
    assert.deepEqual(
        run.cases.map((c) => [c.code, c.expected, c.actual]),
        [
            ['sales_order:in', 'allow', 'allow'],
            ['sales_order:row:region', 'deny', 'deny'],
            ['sales_order:field', 'deny', 'deny'],
            ['sales_order:period', 'deny', 'deny'],
            ['request:export', 'deny', 'deny'],
            ['request:after_validity', 'deny', 'deny'],
        ],
    );
    const stored = await one(admin, 'select cases from sgn.verification_run where id = $1', [run.run_id]);
    const byCode = Object.fromEntries(stored.cases.map((c) => [c.code, c.query]));
    assert.deepEqual(byCode['sales_order:in'].row, { region: 'north' });
    assert.equal(byCode['sales_order:in'].data_date, '2040-01-01');
    assert.notEqual(byCode['sales_order:row:region'].row.region, 'north');
    assert.equal(byCode['sales_order:period'].data_date, '2039-12-31');
    assert.deepEqual(byCode['sales_order:field'].fields, ['gross_margin']);
    assert.equal(byCode['request:after_validity'].as_of > today(60), true);
    assert.match(run.cases[0].description, /銷售訂單・訂單金額、訂單日期、訂單編號/);
});

test('DA-VERIFY-CASES 外部系統以被授權者為單位取聯集：同一被授權者的其他單合法放行的反例，不能證明這張單設定錯，不列入；其他反例照舊', async () => {
    await active(2042);
    const caseId = await active(2043);
    const [run] = (await view(caseId)).delivery.verifications;
    assert.equal(run.status, 'passed');
    assert.deepEqual(
        run.cases.map((c) => c.code),
        ['sales_order:in', 'sales_order:row:region', 'sales_order:field', 'request:export', 'request:after_validity'],
        '資料期間外（2042-12-31）被 2042 年那張單放行，不列入',
    );
    const rs = JSON.parse((await ops(admin, caseId))[0].body);
    const allowed = await one(admin, 'select pack_data_access.rules_allow(pack_data_access.other_rule_sets($1, $2), $3) as a', [
        caseId,
        rs,
        {
            package: 'sales_order',
            fields: ['amount', 'order_no'],
            row: { region: 'north' },
            data_date: '2042-12-31',
            action: 'query',
            as_of: today(),
        },
    ]);
    assert.equal(allowed.a, true);
});

test('K-DELIVERY-SIGNED 簽章由資料庫以資料庫內的金鑰做：外部系統用公鑰驗得過；後端與交付程式讀不到私鑰、叫不動簽章', async () => {
    const caseId = await approved(2012);
    const claimed = await one(delivery, 'select api_delivery.delivery_claim($1, 10) as r', [CHANNEL]);
    const caseNo = String((await view(caseId)).case_no);
    const item = claimed.r.find((x) => x.case_no === caseNo);
    const [key] = (await one(admin, 'select sgn_internal.signing_keys_current() as k')).k;
    assert.equal(item.signature.key_id, key.key_id);
    const signed = Buffer.concat([Buffer.from(`${CONTEXT}\n`), Buffer.from(item.body, 'utf8')]);
    assert.ok(verify(null, signed, createPublicKey(key.public_key_pem), Buffer.from(item.signature.sig, 'base64')));
    assert.ok(
        !verify(
            null,
            Buffer.from(signed.toString().replace('north', 'south')),
            createPublicKey(key.public_key_pem),
            Buffer.from(item.signature.sig, 'base64'),
        ),
    );
    for (const db of [app, delivery]) {
        await rejectsPermission(db.query('select seed from sgn.signing_key'));
        await rejectsPermission(db.query(`select sgn_internal.delivery_sign('x', 'y')`));
        await rejectsPermission(db.query('select body from sgn.delivery_op'));
    }
    await one(delivery, 'select api_delivery.delivery_report($1, $2, $3)', [item.op_id, item.lease_token, await dc.send(item)]);
    await drain(delivery, dc);
    assert.equal((await view(caseId)).state, 'active');
});

test('K-DELIVERY-REJECTED 交付內容被竄改（交付程式改了本文）：外部系統以簽章拒絕，平台開例外、不生效、撤回已送出的部分並通知升級對象', async () => {
    const caseId = await approved(2013);
    const tamper = wrap((item) => dc.send(item.kind === 'apply' ? { ...item, body: item.body.replace('"north"', '"south"') } : item));
    await drain(delivery, tamper);
    const v = await view(caseId);
    assert.equal(v.state, 'fulfilment_failed');
    assert.equal(v.grant, null);
    assert.deepEqual(
        v.delivery.ops.map((o) => [o.kind, o.status, o.last_http_status]),
        [
            ['apply', 'rejected', 401],
            ['withdraw', 'done', 404],
        ],
    );
    assert.ok((await exceptionCodes(caseId)).includes('K-DELIVERY-REJECTED'));
    assert.equal(v.stages.find((s) => s.code === 'fulfil').status, 'cancelled');
    const notified = await admin.query(
        `select person_id from sgn.notification_outbox where case_id = $1 and event_code = 'delivery.rejected'`,
        [caseId],
    );
    assert.ok(notified.rowCount >= 2, '升級對象（MIS、資安長）都收到通知');
    assert.ok(!dc.store.has(String(v.case_no)), '被竄改的規則沒有被套用');
});

test('K-VERIFY-AUTO 外部系統說套用成功卻沒有真的套用（或套用錯）：自動驗證不一致就不生效，開例外並撤回；回報少一個或重複的案例也算不一致', async () => {
    const caseId = await approved(2014);
    // 外部系統自己（帶著有效的證明）說套用成功，但實際查詢的那一邊沒有這份規則：另一個模擬外部系統收下套用、驗證問的是 dc
    const elsewhere = await mockDc(admin);
    const liar = wrap((item) => (item.kind === 'apply' ? elsewhere.send(item) : dc.send(item)));
    await drain(delivery, liar);
    const v = await view(caseId);
    assert.equal(v.state, 'fulfilment_failed');
    assert.equal(v.delivery.verifications[0].status, 'failed');
    assert.deepEqual(
        v.delivery.verifications[0].cases.filter((c) => c.expected !== c.actual).map((c) => c.code),
        ['sales_order:in'],
    );
    assert.ok((await exceptionCodes(caseId)).includes('K-VERIFY-AUTO'));
    assert.ok((await events(caseId)).includes('verification.failed'));
    assert.deepEqual(v.delivery.ops.at(-1).kind, 'withdraw');
    const m = await one(
        admin,
        `select sgn_internal.verification_mismatches($1, $2) as a, sgn_internal.verification_mismatches($1, $3) as b,
                sgn_internal.verification_mismatches($1, $4) as c, sgn_internal.verification_mismatches('[]', '[]') as d`,
        [
            JSON.stringify([
                { code: 'x', expected: 'allow' },
                { code: 'y', expected: 'deny' },
            ]),
            JSON.stringify([{ code: 'x', actual: 'allow' }]),
            JSON.stringify([
                { code: 'x', actual: 'allow' },
                { code: 'y', actual: 'deny' },
                { code: 'y', actual: 'deny' },
            ]),
            JSON.stringify([
                { code: 'x', actual: 'allow' },
                { code: 'y', actual: 'deny' },
            ]),
        ],
    );
    assert.deepEqual([m.a.length, m.b.length, m.c.length, m.d.length], [1, 2, 0, 1]);
});

test('K-DELIVERY-RETRY 外部系統停掉：連不上、5xx 以退避重送（冪等鍵與簽章不變）；恢復後送達生效；4xx 不重送；只收租約內的回報', async () => {
    await setSetting(admin, 'delivery.retry_base_seconds', 30, `channel:${CHANNEL}`);
    const caseId = await approved(2015);
    const down = wrap(() => Promise.resolve({ http_status: null, response: null, error: 'connect ECONNREFUSED 127.0.0.1:7001' }));
    assert.equal(await (await import('../../../../api/src/delivery.ts')).deliverChannel(delivery, CHANNEL, down), 1);
    let [op] = await ops(admin, caseId);
    assert.deepEqual([op.status, op.attempts], ['queued', 1]);
    const firstSignature = op.signature;
    const wait = await one(admin, 'select extract(epoch from next_attempt_at - now()) as s from sgn.delivery_op where id = $1', [op.id]);
    assert.ok(wait.s > 20 && wait.s <= 30, `第一次重送等 ${wait.s} 秒`);
    assert.equal(await (await import('../../../../api/src/delivery.ts')).deliverChannel(delivery, CHANNEL, dc), 0, '還沒到重送時間');
    await setSetting(admin, 'delivery.retry_base_seconds', 0, `channel:${CHANNEL}`);
    await admin.query('update sgn.delivery_op set next_attempt_at = now() where id = $1', [op.id]);
    const busy = wrap((it) => Promise.resolve(dc.reply(it, 503, { status: 'failed', error: 'busy' })));
    await (await import('../../../../api/src/delivery.ts')).deliverChannel(delivery, CHANNEL, busy);
    [op] = await ops(admin, caseId);
    assert.deepEqual([op.status, op.attempts], ['queued', 2]);
    assert.deepEqual(op.signature, firstSignature, '重送用同一份簽章與本文');
    const claimed = await one(delivery, 'select api_delivery.delivery_claim($1, 10) as r', [CHANNEL]);
    const item = claimed.r.find((x) => x.op_id === Number(op.id));
    await rejectsWith(
        one(delivery, 'select api_delivery.delivery_report($1, $2, $3)', [
            op.id,
            '00000000-0000-0000-0000-000000000000',
            { http_status: 200 },
        ]),
        'DELIVERY_LEASE',
    );
    await rejectsWith(
        one(delivery, 'select api_delivery.delivery_report($1, $2, $3)', [op.id, item.lease_token, JSON.stringify('nope')]),
        'DELIVERY_REPORT_INVALID',
    );
    await one(delivery, 'select api_delivery.delivery_report($1, $2, $3)', [op.id, item.lease_token, await dc.send(item)]);
    await rejectsWith(
        one(delivery, 'select api_delivery.delivery_report($1, $2, $3)', [op.id, item.lease_token, { http_status: 200 }]),
        'DELIVERY_LEASE',
    );
    await drain(delivery, dc);
    assert.equal((await view(caseId)).state, 'active');
    // 外部系統（帶證明）的各種回覆怎麼分類：4xx 拒絕、429 重送、2xx 但狀態不對拒絕、撤回時 404 算達成、撤回被拒重送
    const expect = {
        method: item.method,
        path: item.path,
        request_sha256: createHash('sha256').update(item.body).digest('hex'),
        nonce: item.nonce,
    };
    const kinds = [
        ['apply', 422, { status: 'failed' }, 'reject'],
        ['apply', 429, { status: 'failed' }, 'retry'],
        ['apply', 200, { status: 'weird' }, 'reject'],
        ['withdraw', 404, { status: 'failed' }, 'succeed'],
        ['withdraw', 409, { status: 'failed' }, 'reject'],
    ];
    for (const [kind, http, result, want] of kinds) {
        const v = await one(admin, `select sgn_internal.delivery_verdict($1, $2, $3, $4) ->> 'class' as c`, [
            CHANNEL,
            kind,
            expect,
            dc.reply(item, http, result),
        ]);
        assert.equal(v.c, want, `${kind} ${http}`);
    }
});

test('K-DELIVERY-STUCK 持續送不到：超過參數時間開例外（每筆一次）並通知升級對象；排程與交付程式的領取都會檢查', async () => {
    const caseId = await approved(2016);
    await setSetting(admin, 'delivery.stuck_alert_seconds', 0, `channel:${CHANNEL}`);
    const down = wrap(() => Promise.resolve({ http_status: null, response: null, error: 'timeout' }));
    await (await import('../../../../api/src/delivery.ts')).deliverChannel(delivery, CHANNEL, down);
    assert.ok((await exceptionCodes(caseId)).includes('K-DELIVERY-STUCK'));
    assert.equal((await one(job, 'select api_job.delivery_stuck_check() as r')).r.opened, 0, '同一筆不重複開');
    const notified = await admin.query(
        `select count(*)::int as n from sgn.notification_outbox where case_id = $1 and event_code = 'delivery.stuck'`,
        [caseId],
    );
    assert.ok(notified.rows[0].n >= 2);
    await setSetting(admin, 'delivery.stuck_alert_seconds', 3600, `channel:${CHANNEL}`);
    await drain(delivery, dc);
    assert.equal((await view(caseId)).state, 'active');
    assert.equal((await exceptionCodes(caseId)).filter((c) => c === 'K-DELIVERY-STUCK').length, 1);
});

test('K-GRANT-REVOKE 撤銷：不用簽核但要原因；申請人、負責人、簽核人、MIS 可以，其他人不行；外部系統上的規則自動撤回（DA-DC-WITHDRAW）', async () => {
    const caseId = await active(2017);
    await rejectsWith(call(app, 'case_revoke', users.p02.session, caseId, '不相干'), 'NOT_REVOKER');
    await rejectsWith(call(app, 'case_revoke', users.p11.session, caseId, '  '), 'REASON_REQUIRED');
    assert.ok((await view(caseId)).actions.includes('revoke'));
    const mis = await one(admin, `select sgn_internal.denial_reason($1, 'revoke', c) as d from sgn.request_case as c where c.id = $2`, [
        users.p18.personId,
        caseId,
    ]);
    assert.equal(mis.d, null, 'MIS（沒有經手這張單）也可以撤銷');
    const caseNo = String((await view(caseId)).case_no);
    assert.equal(dc.store.get(caseNo).withdrawn, false);
    const revoked = await call(app, 'case_revoke', users.p11.session, caseId, '專案提前結束');
    assert.equal(revoked.state, 'revoked');
    assert.equal(revoked.grant.status, 'revoked');
    assert.deepEqual(revoked.delivery.ops.at(-1).kind, 'withdraw');
    await drain(delivery, dc);
    assert.equal(dc.store.get(caseNo).withdrawn, true);
    assert.equal((await view(caseId)).delivery.ops.at(-1).status, 'done');
    await rejectsWith(call(app, 'case_revoke', users.p04.session, caseId, '再一次'), 'STATE_TRANSITION');
    const ev = await events(caseId);
    assert.ok(ev.includes('grant.revoked'));
    const n = await one(
        admin,
        `select count(*)::int as n from sgn.notification_outbox where case_id = $1 and event_code = 'case.revoked'`,
        [caseId],
    );
    assert.equal(n.n, 1, '申請人就是負責人：通知一次');
});

test('K-DELIVERY-ORDER 撤銷不得被較舊的套用蓋掉：還沒送出的套用作廢；正在送的套用有結果之後才送撤回；作廢的套用不能再回報', async () => {
    const queuedCase = await active(2018);
    await call(app, 'case_reduce', users.p04.session, queuedCase, so(2018, ['amount', 'order_no']), null, '少一個欄位');
    await call(app, 'case_revoke', users.p04.session, queuedCase, '改用別的資料');
    let list = await ops(admin, queuedCase);
    assert.deepEqual(
        list.slice(-2).map((o) => [o.kind, o.status]),
        [
            ['apply', 'superseded'],
            ['withdraw', 'queued'],
        ],
    );
    await drain(delivery, dc);
    assert.equal((await ops(admin, queuedCase)).filter((o) => o.kind === 'apply' && o.attempts > 0).length, 1, '作廢的第 2 版沒有送出');

    const inFlight = await active(2019);
    await call(app, 'case_reduce', users.p04.session, inFlight, so(2019, ['amount', 'order_no']), null, '少一個欄位');
    const claimed = (await one(delivery, 'select api_delivery.delivery_claim($1, 10) as r', [CHANNEL])).r;
    const apply2 = claimed.find((x) => x.kind === 'apply');
    await call(app, 'case_revoke', users.p04.session, inFlight, '改用別的資料');
    assert.deepEqual((await one(delivery, 'select api_delivery.delivery_claim($1, 10) as r', [CHANNEL])).r, [], '撤回排在正在送的套用後面');
    await one(delivery, 'select api_delivery.delivery_report($1, $2, $3)', [apply2.op_id, apply2.lease_token, await dc.send(apply2)]);
    await drain(delivery, dc);
    list = await ops(admin, inFlight);
    assert.deepEqual(
        list.slice(-2).map((o) => [o.kind, o.status]),
        [
            ['apply', 'done'],
            ['withdraw', 'done'],
        ],
    );
    assert.equal(dc.store.get(String((await view(inFlight)).case_no)).withdrawn, true);
    assert.equal(
        (await admin.query('select 1 from sgn.verification_run where apply_op_id = $1', [apply2.op_id])).rowCount,
        0,
        '撤銷後才送達的套用不驗證、不生效',
    );
});

test('K-GRANT-REDUCE 生效後只做縮小：不用重簽，新的一版自動送出並重新驗證；擴大被擋下', async () => {
    const caseId = await active(2020);
    await rejectsWith(
        call(app, 'case_reduce', users.p04.session, caseId, so(2020, ['amount', 'gross_margin', 'order_date', 'order_no']), null, '多要'),
        'CHANGE_NOT_REDUCE',
    );
    await rejectsWith(call(app, 'case_reduce', users.p02.session, caseId, so(2020, ['amount']), null, '不相干'), 'NOT_REVOKER');
    const reduced = await call(app, 'case_reduce', users.p11.session, caseId, so(2020, ['amount', 'order_no']), null, '用不到訂單日期');
    assert.equal(reduced.state, 'active');
    assert.equal(reduced.version, 2);
    assert.deepEqual(reduced.versions.at(-1).change_kind, 'reduce');
    await drain(delivery, dc);
    const v = await view(caseId);
    assert.deepEqual(
        v.delivery.verifications.map((r) => [r.version, r.status]),
        [
            [1, 'passed'],
            [2, 'passed'],
        ],
    );
    assert.deepEqual(dc.store.get(String(v.case_no)).set.rules[0].fields, ['amount', 'order_no']);
    assert.ok((await events(caseId)).includes('grant.reduced'));
});

test('K-GRANT-EXPIRE 授權迄日過了：排程結束授權並排清除（到期的權限從外部系統的目錄上拿掉）', async () => {
    // 年份和其他測試不相鄰：到期只改了平台的授權迄日，模擬的外部系統上這份規則的有效迄日沒變（聯集仍放行）
    const caseId = await active(2050);
    await admin.query(`update sgn.grant_record set valid_to = current_date - 1 where case_id = $1`, [caseId]);
    assert.ok((await one(job, 'select api_job.grant_expire_due() as r')).r.expired >= 1);
    const v = await view(caseId);
    assert.equal(v.state, 'expired');
    assert.equal(v.grant.status, 'expired');
    const purge = await one(
        admin,
        `select id, status from sgn.delivery_op where kind = 'purge' and channel = $1 order by id desc limit 1`,
        [CHANNEL],
    );
    assert.equal(purge.status, 'queued');
    await drain(delivery, dc);
    assert.equal((await one(admin, 'select status from sgn.delivery_op where id = $1', [purge.id])).status, 'done');
    assert.ok((await events(caseId)).includes('grant.expired'));
});

test('K-DELIVERY-MANUAL 交付方式是人工的受管系統（人資系統）：才由該系統的管理人執行，並開常設例外；撤銷時開例外並通知管理人', async () => {
    const content = {
        scope: [{ package: 'payroll', fields: ['employee_id', 'net_pay', 'pay_date'], row_filters: [] }],
        data_period: { from: '2019-01-01', to: '2019-12-31' },
        purpose_category: 'operations',
        purpose_description: '交付測試（人工）',
        export_allowed: false,
    };
    const t = { principal_id: P['ap-recon-bot'], valid_from: today(), valid_to: today(60) };
    const c = await call(app, 'case_submit_new', users.p04.session, DA, content, t, null);
    for (const who of ['p12', 'p03', 'p15', 'p19']) await decide(app, users[who], c.case_id);
    await call(app, 'task_claim', users.p16.session, c.case_id);
    await decide(app, users.p16, c.case_id);
    let v = await view(c.case_id);
    assert.deepEqual(v.waiting_on, ['江佩玲']);
    assert.deepEqual(v.delivery.ops, []);
    assert.ok((await exceptionCodes(c.case_id)).includes('K-DELIVERY-MANUAL'));
    await call(app, 'task_claim', users.p30.session, c.case_id);
    assert.equal(await decide(app, users.p30, c.case_id, 'fulfil'), 'active');
    await rejectsWith(
        call(
            app,
            'case_reduce',
            users.p04.session,
            c.case_id,
            { ...content, scope: [{ ...content.scope[0], fields: ['employee_id', 'net_pay'] }] },
            null,
            '縮小',
        ),
        'DELIVERY_MANUAL_ONLY',
    );
    v = await call(app, 'case_revoke', users.p04.session, c.case_id, '不需要了');
    assert.equal(v.state, 'revoked');
    assert.equal((await exceptionCodes(c.case_id)).filter((x) => x === 'K-DELIVERY-MANUAL').length, 2);
    const n = await admin.query(
        `select person_id from sgn.notification_outbox where case_id = $1 and event_code = 'delivery.manual_required'`,
        [c.case_id],
    );
    assert.ok(
        n.rows.some((r) => r.person_id === users.p30.personId),
        '人資系統的管理人收到通知',
    );
});

// ── 對帳：以平台認為該有的項目組出外部系統的回報（真的 sim/dc 回報在合約測試與端對端測試）──

async function expectedItems() {
    const { rows } = await admin.query(
        `select item from sgn_internal.reconciliation_expected($1, 'data_access') where standing = 'expected'`,
        [CHANNEL],
    );
    return rows.map(({ item }) => ({
        item_key: `${item.subject}|${item.resource}|${item.action}|${item.rule_id}`,
        subject: { type: 'principal', id: item.subject, properties: { provider: 'sgn' } },
        resource: { type: 'data_field', id: item.resource },
        action: { name: item.action },
        entitlement_id: null,
        constraints: {
            row_filter: item.constraints.row_filter,
            ...(item.constraints.data_period ? { data_period: item.constraints.data_period } : {}),
        },
        properties: { rule_id: item.rule_id, case_no: item.case_no, valid: item.valid },
    }));
}
const report = (items) => ({
    format: 'dc_reconciliation_report/1',
    observed_at: new Date().toISOString(),
    process_type: 'data_access',
    items,
});
const reconCodes = async (caseId) => (await exceptionCodes(caseId)).filter((c) => c.startsWith('K-RECON'));
/** 交一份由模擬外部系統簽過的對帳回報（對帳程式交上來的就是外部系統的回應原樣）。 */
const submit = async (items) =>
    (await one(job, 'select api_job.reconciliation_submit($1, $2) as r', [CHANNEL, dc.reconciliation(report(items))])).r;

test('K-RECON-MISSING 對帳：平台認為已生效、外部系統上卻沒有的權限開例外；兩邊相同時沒有發現', async () => {
    const caseId = await active(2022);
    const items = await expectedItems();
    await submit(items);
    const clean = await submit(items);
    assert.equal(clean.new_findings, 0);
    const caseNo = String((await view(caseId)).case_no);
    const result = await submit(items.filter((i) => !(i.properties.case_no === caseNo && i.resource.id === 'sales_order.amount')));
    assert.equal(result.new_findings, 1);
    assert.deepEqual(await reconCodes(caseId), ['K-RECON-MISSING']);
    assert.equal((await submit(items)).resolved, 1, '下一輪沒看到就結案');
});

test('K-RECON-EXTRA 對帳：多出來的權限（核准以外的欄位、已撤銷且撤回完成的單、不是平台建立的角色）開例外；同一個發現只開一次；撤回還沒完成的不算', async () => {
    const caseId = await active(2023);
    const items = await expectedItems();
    const caseNo = String((await view(caseId)).case_no);
    const mine = items.filter((i) => i.properties.case_no === caseNo);
    const extraField = { ...mine[0], item_key: 'x', resource: { type: 'data_field', id: 'sales_order.gross_margin' } };
    const stranger = {
        ...mine[0],
        item_key: 'y',
        subject: { type: 'principal', id: 'simdc_hand_made', properties: { provider: 'dc_db_role' } },
        properties: {},
    };
    const first = await submit([...items, extraField, stranger]);
    assert.equal(first.new_findings, 2);
    assert.equal((await submit([...items, extraField, stranger])).new_findings, 0, '同一個發現不重複開例外');
    assert.deepEqual(await reconCodes(caseId), ['K-RECON-EXTRA']);
    await call(app, 'case_revoke', users.p04.session, caseId, '對帳測試');
    // 撤銷在平台那一刻生效：撤回還在送時外部系統上的權限就是多出來的（紅隊第四輪 高-2；已經有撤回在排，不重複排）
    const withdrawsBefore = (await ops(admin, caseId)).filter((o) => o.kind === 'withdraw').length;
    assert.equal((await submit([...items, extraField, stranger])).new_findings, mine.length, '撤回還在送：每一項都是多出來的');
    assert.equal((await ops(admin, caseId)).filter((o) => o.kind === 'withdraw').length, withdrawsBefore, '撤回已經在排');
    await drain(delivery, dc);
    const after = await submit([...items, extraField, stranger]);
    assert.equal(after.new_findings, 0, '撤回完成後外部系統還有它的權限：同一批發現，不重複開');
    assert.equal(after.resolved, 0);
});

test('K-RECON-DIFFERENT 對帳：兩邊都有但列條件、資料期間或有效期間不同開例外', async () => {
    const caseId = await active(2024);
    const items = await expectedItems();
    const caseNo = String((await view(caseId)).case_no);
    const widened = items.map((i) =>
        i.properties.case_no === caseNo && i.resource.id === 'sales_order.order_no'
            ? { ...i, constraints: { ...i.constraints, row_filter: [{ filter: 'region', op: 'in', values: ['north', 'south'] }] } }
            : i,
    );
    const r = await submit(widened);
    assert.equal(r.new_findings, 1);
    assert.deepEqual(await reconCodes(caseId), ['K-RECON-DIFFERENT']);
    const runs = await one(admin, `select count(*)::int as n from sgn.audit_event where event_type = 'reconciliation.completed'`);
    assert.ok(runs.n >= 1, '每一輪對帳進鏈');
    const bad = await one(job, 'select api_job.reconciliation_submit($1, $2) as r', [CHANNEL, { items: 'x' }]);
    assert.deepEqual([bad.r.status, bad.r.reason], ['rejected', 'unverified'], '沒有外部系統證明的回報不收');
});

test('K-DELIVERY-REJECTED 撤回被外部系統拒絕不是終態：第一次開例外並升級，之後以退避繼續重送，外部系統接受後才算完成（紅隊第四輪 低-1、裁決 D81 (6)）', async () => {
    const caseId = await active(2030);
    await call(app, 'case_revoke', users.p04.session, caseId, '撤回被拒測試');
    const refuse = wrap((it) =>
        Promise.resolve(
            it.kind === 'withdraw' ? dc.reply(it, 409, { status: 'failed', code: 'conflict', error: 'busy elsewhere' }) : dc.send(it),
        ),
    );
    const { deliverChannel } = await import('../../../../api/src/delivery.ts');
    await deliverChannel(delivery, CHANNEL, refuse);
    await deliverChannel(delivery, CHANNEL, refuse);
    const withdraw = (await ops(admin, caseId)).find((o) => o.kind === 'withdraw');
    assert.equal(withdraw.status, 'queued', '不是 rejected：還會再送');
    assert.ok(withdraw.attempts >= 2);
    assert.equal((await exceptionCodes(caseId)).filter((c) => c === 'K-DELIVERY-REJECTED').length, 1, '例外只開一次');
    const notified = await admin.query(`select 1 from sgn.notification_outbox where case_id = $1 and event_code = 'delivery.rejected'`, [
        caseId,
    ]);
    assert.ok(notified.rowCount >= 2, '升級對象收到通知');
    await drain(delivery, dc);
    assert.equal((await ops(admin, caseId)).find((o) => o.kind === 'withdraw').status, 'done');
});

// ── 對帳回報的證明、上限、逾期、自動撤回與結案（裁決 D81 (3)；紅隊第四輪 中-3、高-2）──

const recon = (rows) => rows.map((r) => r.rule_code);
const channelExceptions = async (code) =>
    recon(
        (
            await admin.query(`select rule_code from sgn.exception_record where rule_code = $1 and detail ->> 'channel' = $2`, [
                code,
                CHANNEL,
            ])
        ).rows,
    );

test('K-RECON-UNVERIFIED 對帳程式改不了回報：只採信外部系統簽的內容（改可讀副本、拿掉項目都沒用）；沒有證明、證明被改、重送、過期的回報不收並開例外（限速）', async () => {
    const caseId = await active(2026);
    const caseNo = String((await view(caseId)).case_no);
    const items = await expectedItems();
    const backdoor = {
        ...items.find((i) => i.properties.case_no === caseNo),
        item_key: 'bd',
        resource: { type: 'data_field', id: 'sales_order.gross_margin' },
    };
    // 外部系統簽的回報裡有後門；對帳程式（D）把它從可讀副本拿掉再交 → 資料庫看的是簽過的那一份，照樣抓到
    const signed = dc.reconciliation(report([...items, backdoor]));
    const hidden = { ...signed, items: signed.items.filter((i) => i.item_key !== 'bd') };
    const r = (await one(job, 'select api_job.reconciliation_submit($1, $2) as r', [CHANNEL, hidden])).r;
    assert.equal(r.status, 'accepted');
    assert.equal(r.new_findings, 1);
    assert.deepEqual(await reconCodes(caseId), ['K-RECON-EXTRA']);
    // 同一份再交一次（重送）：不收
    const again = (await one(job, 'select api_job.reconciliation_submit($1, $2) as r', [CHANNEL, signed])).r;
    assert.deepEqual([again.status, again.reason], ['rejected', 'replay']);
    // 證明被改（把後門從被簽的內容裡拿掉）：不收；限速：同一通道在新鮮度的時間內只開一筆例外
    const att = signed.attestation;
    const forged = { ...signed, attestation: { ...att, payload: att.payload.replace('sales_order.gross_margin', 'sales_order.amount') } };
    const before = (await channelExceptions('K-RECON-UNVERIFIED')).length;
    assert.equal((await one(job, 'select api_job.reconciliation_submit($1, $2) as r', [CHANNEL, forged])).r.reason, 'unverified');
    assert.equal((await one(job, 'select api_job.reconciliation_submit($1, $2) as r', [CHANNEL, { items: [] }])).r.reason, 'unverified');
    assert.ok((await channelExceptions('K-RECON-UNVERIFIED')).length <= before + 1, '壞回報灌不爆例外');
    assert.ok((await channelExceptions('K-RECON-UNVERIFIED')).length >= 1);
    // 過期：外部系統簽發的時間離現在超過參數
    await setSetting(admin, 'reconciliation.max_report_age_seconds', 1, `channel:${CHANNEL}`);
    const old = dc.reconciliation(report(items));
    await new Promise((resolve) => setTimeout(resolve, 2100));
    assert.equal((await one(job, 'select api_job.reconciliation_submit($1, $2) as r', [CHANNEL, old])).r.reason, 'stale');
    await setSetting(admin, 'reconciliation.max_report_age_seconds', 120, `channel:${CHANNEL}`);
    // 沒通過的回報不會讓發現結案；有效的回報沒看到後門才結案，而且結案進鏈
    const open = await one(
        admin,
        `select count(*)::int as n from sgn.reconciliation_finding where case_id = $1 and resolved_run_id is null`,
        [caseId],
    );
    assert.equal(open.n, 1);
    await submit(items);
    const resolved = await admin.query(
        `select 1 from sgn.audit_event where event_type = 'reconciliation.finding_resolved' and case_id = $1`,
        [caseId],
    );
    assert.equal(resolved.rowCount, 1);
});

test('K-RECON-EXTRA 縮小之後新的一版送不出去（交付程式或網路擋下）：外部系統上仍是舊版，舊版多出來的欄位立刻是發現（縮小在平台那一刻生效，紅隊第四輪 腳本 21 b）', async () => {
    const caseId = await active(2031);
    const caseNo = String((await view(caseId)).case_no);
    const before = (await expectedItems()).filter((i) => i.properties.case_no === caseNo);
    await call(app, 'case_reduce', users.p04.session, caseId, so(2031, ['amount', 'order_date']), null, '縮小');
    // 新的一版還在排（交付程式擋著）：外部系統的回報仍是舊版的三個欄位
    const others = (await expectedItems()).filter((i) => i.properties.case_no !== caseNo);
    const r = await submit([...others, ...before]);
    assert.ok(r.new_findings >= 1);
    const kinds = (
        await admin.query(
            `select kind, detail ->> 'key' as key from sgn.reconciliation_finding where case_id = $1 and resolved_run_id is null`,
            [caseId],
        )
    ).rows;
    assert.ok(
        kinds.some((k) => k.kind === 'extra' && k.key.includes('sales_order.order_no')),
        JSON.stringify(kinds),
    );
    await drain(delivery, dc);
    assert.equal((await view(caseId)).state, 'active');
    await submit(await expectedItems());
    assert.equal(
        (await admin.query(`select 1 from sgn.reconciliation_finding where case_id = $1 and resolved_run_id is null`, [caseId])).rowCount,
        0,
    );
});

test('K-RECON-RESOLVED 發現只在之後一份有效的回報沒看到時結案，每一筆結案都進鏈（不會只靠下一份回報無人知曉地消失）', async () => {
    const caseId = await active(2027);
    const caseNo = String((await view(caseId)).case_no);
    const items = await expectedItems();
    await submit(items.filter((i) => !(i.properties.case_no === caseNo && i.resource.id === 'sales_order.amount')));
    assert.deepEqual(await reconCodes(caseId), ['K-RECON-MISSING']);
    const bad = (await one(job, 'select api_job.reconciliation_submit($1, $2) as r', [CHANNEL, report(items)])).r;
    assert.equal(bad.status, 'rejected');
    assert.equal(
        (
            await one(admin, `select count(*)::int as n from sgn.reconciliation_finding where case_id = $1 and resolved_run_id is null`, [
                caseId,
            ])
        ).n,
        1,
    );
    const ok = await submit(items);
    assert.equal(ok.resolved, 1);
    const chain = await admin.query(`select 1 from sgn.audit_event where event_type = 'reconciliation.finding_resolved' and case_id = $1`, [
        caseId,
    ]);
    assert.equal(chain.rowCount, 1, '結案進鏈');
});

test('K-RECON-LIMIT 單輪上限：項目超過上限整份不收；新發現超過上限時只逐筆開到上限、其餘合併成一筆例外並升級（發現照樣記錄）', async () => {
    const caseId = await active(2028);
    const caseNo = String((await view(caseId)).case_no);
    const items = await expectedItems();
    await setSetting(admin, 'reconciliation.max_items', items.length, `channel:${CHANNEL}`);
    const mine = items.find((i) => i.properties.case_no === caseNo);
    const fakes = ['gross_margin', 'unit_cost', 'discount'].map((f) => ({
        ...mine,
        item_key: f,
        resource: { type: 'data_field', id: `sales_order.${f}` },
    }));
    const big = await submit([...items, ...fakes]);
    assert.deepEqual([big.status, big.reason], ['rejected', 'too_many_items']);
    assert.ok((await channelExceptions('K-RECON-LIMIT')).length >= 1);
    await setSetting(admin, 'reconciliation.max_items', 5000, `channel:${CHANNEL}`);
    await setSetting(admin, 'reconciliation.max_new_findings', 1, `channel:${CHANNEL}`);
    const before = (await admin.query('select count(*)::int as n from sgn.exception_record')).rows[0].n;
    const r = await submit([...items, ...fakes]);
    await setSetting(admin, 'reconciliation.max_new_findings', 100, `channel:${CHANNEL}`);
    assert.equal(r.new_findings, 3, '發現都記下來');
    const after = (await admin.query('select count(*)::int as n from sgn.exception_record')).rows[0].n;
    assert.equal(after - before, 2, '逐筆開 1 筆，其餘合併成 1 筆 K-RECON-LIMIT');
    await submit(items);
});

test('K-RECON-OVERDUE 超過參數的時間沒有有效的對帳回報：由資料庫開例外並升級，每段逾期一筆；有效的回報之後重新計算', async () => {
    await setSetting(admin, 'reconciliation.max_interval_seconds', 0, `channel:${CHANNEL}`);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal((await one(job, 'select api_job.reconciliation_overdue_check() as n')).n, 1);
    assert.equal((await one(job, 'select api_job.reconciliation_overdue_check() as n')).n, 0, '同一段逾期不重複開');
    // 壞的回報不算
    await one(job, 'select api_job.reconciliation_submit($1, $2) as r', [CHANNEL, { items: [] }]);
    assert.equal((await one(job, 'select api_job.reconciliation_overdue_check() as n')).n, 0);
    await submit(await expectedItems());
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal((await one(job, 'select api_job.reconciliation_overdue_check() as n')).n, 1, '有效的回報之後又逾期');
    await setSetting(admin, 'reconciliation.max_interval_seconds', 300, `channel:${CHANNEL}`);
    const notified = await admin.query(`select 1 from sgn.notification_outbox where event_code = 'reconciliation.overdue'`);
    assert.ok(notified.rowCount >= 2, '通知升級對象');
});

test('K-RECON-EXTRA 多出來的屬於已撤銷（撤回已完成）的單：自動排撤回並進鏈；不屬於任何單的不排撤回（升級）', async () => {
    const caseId = await active(2029);
    const caseNo = String((await view(caseId)).case_no);
    const items = await expectedItems();
    const mine = items.filter((i) => i.properties.case_no === caseNo);
    await call(app, 'case_revoke', users.p04.session, caseId, '自動撤回測試');
    await drain(delivery, dc);
    const withdraws = async () => (await ops(admin, caseId)).filter((o) => o.kind === 'withdraw');
    assert.deepEqual(
        (await withdraws()).map((o) => o.status),
        ['done'],
    );
    // 撤回完成之後外部系統上又出現（例如撤銷後才送達的舊版本）：自動再排一筆撤回
    const r = await submit(items);
    assert.equal(r.new_findings, mine.length);
    assert.deepEqual(
        (await withdraws()).map((o) => o.status),
        ['done', 'queued'],
    );
    assert.ok((await events(caseId)).includes('reconciliation.withdraw_scheduled'));
    await drain(delivery, dc);
    await submit(await expectedItems());
});

test('架構：被入侵的後端（sgn_app）不能領取交付、不能謊報套用或驗證結果、不能交對帳回報；交付程式不能呼叫後端與排程的 function', async () => {
    await rejectsPermission(app.query(`select api_delivery.delivery_claim('dc', 1)`));
    await rejectsPermission(app.query(`select api_delivery.delivery_report(1, gen_random_uuid(), '{}')`));
    await rejectsPermission(app.query(`select api_job.reconciliation_submit('dc', '{}')`));
    await rejectsPermission(delivery.query(`select api.case_revoke('x', gen_random_uuid(), 'r')`));
    await rejectsPermission(delivery.query(`select api_job.reconciliation_submit('dc', '{}')`));
    await rejectsPermission(job.query(`select api_delivery.delivery_claim('dc', 1)`));
});
