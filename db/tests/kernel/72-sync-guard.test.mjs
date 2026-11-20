// 同步防護（K-DETECT-MANAGER-FLIP）的攻擊測試。攻擊者模型：拿到人員同步帳號（sgn_sync），可以送任意內容的快照；
// 也拿到某個同事（p05）的通行金鑰。目標：讓 p05 成為 p04 的簽核人，核准 p04 的申請。
// 防護不是「擋下」（資料庫無從分辨假快照與真的人事異動），而是：每筆異動進鏈、由這種關係解析出的簽核人
// 在送審時開例外、單上與稽核頁看得到、決定事件記下例外；進行中的單不受影響。
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { syncDirectory } from '../../tools/directory-sync.mjs';
import { verifyChain } from '../../tools/chain-lib.mjs';
import { roleUrl } from '../../tools/lib/env.mjs';
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
const syncDb = pool('SYNC');
const users = {};

const entry = (uid, manager, name) => ({
    external_id: uid,
    display_name: name,
    email: `${uid}@sim.example`,
    active: true,
    manager_external_id: manager,
    roles: [],
});
// 假快照：把 p04（林怡君）的主管改成 p05（王志明）。
const forgedSnapshot = [entry('p04', 'p05', '林怡君'), entry('p05', 'p03', '王志明')];
// 只列兩個人，所以宣告為增量同步（紅隊 中-1 之後，宣告成完整快照會因差異超過門檻被整批拒絕）
const forged = (source) => [
    'select api_sync.directory_apply($1, $2, $3, $4)',
    [source, 'incremental', forgedSnapshot.length, JSON.stringify(forgedSnapshot)],
];

before(async () => {
    for (const uid of ['p03', 'p04', 'p05', 'p22']) users[uid] = await login(app, uid);
    users.p03.key = await registerPasskey(app, users.p03);
    users.p05.key = await registerPasskey(app, users.p05);
    await syncDirectory(config);
});
after(async () => {
    await syncDirectory(config);
    await closePools();
});

const caseNoOf = async (caseId) => (await one(admin, 'select case_no from sgn.request_case where id = $1', [caseId])).case_no;
const lastEvent = async (type) =>
    one(
        admin,
        `select seq, convert_from(body, 'UTF8')::jsonb as body from sgn.audit_event where event_type = $1 order by seq desc limit 1`,
        [type],
    );

test('K-DETECT-MANAGER-FLIP 攻擊：同步帳號把指定的人設成主管 → 異動逐筆進鏈、送審開例外、申請人／簽核人／稽核都看得到、決定事件記下例外', async () => {
    try {
        const head = (await lastEvent('directory.synced')).seq;
        await syncDb.query(...forged('sim-ldap'));

        // 1. 這筆異動單獨在鏈上：誰、舊主管、新主管
        const { rows: changes } = await admin.query(
            `select seq, convert_from(body, 'UTF8')::jsonb as body from sgn.audit_event
             where event_type = 'directory.manager_changed' and seq > $1 order by seq`,
            [head],
        );
        const changed = changes.find((c) => c.body.data.person === users.p04.personId);
        assert.ok(changed, '假快照造成的主管異動沒有寫進鏈');
        assert.equal(changed.body.data.previous_manager, users.p03.personId);
        assert.equal(changed.body.data.new_manager, users.p05.personId);

        // 2. 冷卻期內（K-HR-SYNC）：攻擊者還不是簽核人，仍由原主管簽
        const cooling = await call(app, 'case_submit_new', users.p04.session, PROBE, { dataset: 'payroll', purpose: '攻擊' }, {}, null);
        assert.deepEqual(cooling.waiting_on, ['陳建宏']);
        assert.deepEqual(cooling.exceptions, []);
        // 時間「過了」冷卻期（測試用的管理者連線把新關係的起點往前移，模擬時間經過）：送審時開例外；申請人看得到
        await settleManagerChange(admin, users.p04.personId);
        const submitted = await call(app, 'case_submit_new', users.p04.session, PROBE, { dataset: 'payroll', purpose: '攻擊' }, {}, null);
        assert.deepEqual(submitted.waiting_on, ['王志明']);
        assert.deepEqual(
            submitted.exceptions.map((x) => x.rule_code),
            ['K-DETECT-MANAGER-FLIP'],
        );
        const exceptionEvent = await lastEvent('exception.opened');
        assert.equal(exceptionEvent.body.case_id, submitted.case_id);
        assert.equal(exceptionEvent.body.data.detail.change_event_seq, Number(changed.seq));

        // 3. 簽核人在待簽清單上看得到這張單帶著例外
        const inbox = await call(app, 'inbox_list', users.p05.session);
        const item = inbox.find((c) => c.case_id === submitted.case_id);
        assert.deepEqual(
            item.exceptions.map((x) => x.rule_code),
            ['K-DETECT-MANAGER-FLIP'],
        );

        // 4. 攻擊者仍然可以核准（資料庫分辨不出真假異動），但決定事件記下當時未結案的例外
        const ch = await issueChallenge(app, users.p05, submitted.case_id);
        assert.equal(await decidePasskey(app, ch.challenge_id, 'approve', users.p05.key.assert(ch.challenge)), 'completed');
        const decided = await one(
            admin,
            `select convert_from(body, 'UTF8')::jsonb as body from sgn.audit_event where event_type = 'case.approve' and case_id = $1`,
            [submitted.case_id],
        );
        assert.deepEqual(decided.body.data.open_exceptions, [submitted.exceptions[0].id]);

        // 5. 稽核人員不必知道單號就看得到例外；證據頁附上那筆主管異動事件
        const all = await call(app, 'audit_exceptions', users.p22.session);
        assert.ok(all.some((x) => x.case_no === submitted.case_no && x.rule_code === 'K-DETECT-MANAGER-FLIP'));
        const audit = await call(app, 'audit_case', users.p22.session, await caseNoOf(submitted.case_id));
        assert.ok(audit.events.some((e) => e.seq === Number(changed.seq) && e.event_type === 'directory.manager_changed'));
        assert.ok(audit.events.some((e) => e.event_type === 'exception.opened'));
        assert.deepEqual(
            audit.case.exceptions.map((x) => x.rule_code),
            ['K-DETECT-MANAGER-FLIP'],
        );

        // 6. 整條鏈仍然一致（例外與異動是正常事件，不是竄改）
        const chain = await verifyChain({ dbUrl: roleUrl(config, 'JOB') });
        assert.equal(chain.ok, true, JSON.stringify(chain.problems.slice(0, 3)));
    } finally {
        await syncDirectory(config);
        // 改回原主管也是一次同步異動；讓它也「過了」冷卻期，後面的測試才回到原本的主管
        await settleManagerChange(admin, users.p04.personId);
    }
});

test('K-DETECT-MANAGER-FLIP 進行中的單：送審後的同步異動不改變簽核人，攻擊者拿不到挑戰值', async () => {
    const caseId = await createSubmittedCase(app, users.p04);
    try {
        await syncDb.query(...forged('sim-ldap'));
        await rejectsWith(issueChallenge(app, users.p05, caseId), 'NOT_APPROVER');
        const view = await call(app, 'case_get', users.p04.session, caseId);
        assert.deepEqual(view.waiting_on, ['陳建宏']);
        const ch = await issueChallenge(app, users.p03, caseId);
        assert.equal(await decidePasskey(app, ch.challenge_id, 'approve', users.p03.key.assert(ch.challenge)), 'completed');
    } finally {
        await syncDirectory(config);
    }
});

test('K-DETECT-MANAGER-FLIP 基準只有一次：之後的同步一律不是基準；未登記的來源被拒，不能另開一個「新基準」', async () => {
    const result = await syncDirectory(config);
    assert.equal(result.baseline, false);
    const baselines = await one(
        admin,
        `select count(*)::int as n from sgn.audit_event
         where event_type = 'directory.synced' and convert_from(body, 'UTF8')::jsonb #>> '{data,baseline}' = 'true'`,
    );
    assert.equal(baselines.n, 1);
    await rejectsWith(syncDb.query(...forged('evil-source')), 'DIRECTORY_SOURCE_UNKNOWN');
    // 同步帳號碰不到例外與決定：它只能執行 api_sync
    const fns = await admin.query(
        `select distinct n.nspname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where has_function_privilege($1, p.oid, 'execute') and has_schema_privilege($1, n.oid, 'usage')
           and n.nspname not in ('pg_catalog', 'information_schema')`,
        [config.db.SGN_ROLE_SYNC],
    );
    assert.deepEqual(
        fns.rows.map((r) => r.nspname),
        ['api_sync'],
    );
});
