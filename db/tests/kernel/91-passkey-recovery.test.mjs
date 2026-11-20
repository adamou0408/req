// 紅隊第七輪 高-1、中-1、低-1（裁決 D88 (1)(2)(4)；redteam/exploits/49、48）。威脅小表見 docs/handoff/redteam-fixes-7.md 第 1 節，
// 每一列對應這裡的一個斷言（列號寫在註解）。「拿掉防線就失敗」：
//   - 撤銷的人可以背書替換的金鑰 → K-PASSKEY-RECOVERY 第一段失敗（列 R1）
//   - 復原的金鑰用一般冷卻期、不開例外 → 第二段失敗（列 R2）
//   - 「不是我」沒有上限、或別人背書以外的金鑰也能回報 → K-PASSKEY-NOT-ME 失敗（列 N1–N4）
//   - 登記人少於下限沒有例外、安裝儀式在下限以上也能執行 → K-REGISTRAR-MIN 失敗（列 G1–G4）
//   - 全公司只憑登入的停用沒有上限 → K-PASSKEY-SUSPEND-FLOOD 失敗（列 F1–F3）
//   - 例外以「歷來有沒有開過」去重、沒有結案 → K-EXCEPTION-CLOSE 失敗（列 E1–E4）
// 用的人（p20、p23、p25、p26、p29）其他資料庫測試用不到他們的金鑰；p24 是第二位登記人（安裝時建立，harness 的 oldKey 認得）。
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
    approveEnrollment,
    call,
    challengeFor,
    closePools,
    config,
    endorse,
    login,
    newAuthenticator,
    oldKey,
    one,
    pool,
    registerPasskey,
    registrar,
    rejectsPermission,
    rejectsWith,
    requestPasskey,
    setSetting,
    settlePasskey,
    shownOn,
} from './lib/harness.mjs';

const app = pool('APP');
const admin = pool('ADMIN');
const scheduler = pool('SCHEDULER');
const users = {};
let reg;
let second;

before(async () => {
    for (const uid of ['p20', 'p23', 'p25', 'p26', 'p29']) {
        users[uid] = await login(app, uid);
        users[uid].key = await registerPasskey(app, users[uid]);
    }
    reg = await registrar(app);
    second = await login(app, config.db.SGN_SEED_REGISTRAR_2);
    second.key = await oldKey(app, second);
    assert.ok(second.key, '第二位登記人的金鑰（安裝時建立）');
});
after(closePools);

const raw = (a) => [a.credentialId, a.authenticatorData, a.clientDataJSON, a.signature];
const maxId = async (table) => (await one(admin, `select coalesce(max(id), 0)::bigint as x from ${table}`)).x;
const exceptionsSince = (rule, x0) =>
    admin
        .query(`select id, detail, closed_at, close_detail from sgn.exception_record where rule_code = $1 and id > $2 order by id`, [
            rule,
            x0,
        ])
        .then((r) => r.rows);
const notifiedSince = (event, n0) =>
    admin
        .query(`select person_id from sgn.notification_outbox where event_code = $1 and id > $2 order by person_id`, [event, n0])
        .then((r) => r.rows.map((x) => x.person_id));
const holders = (sql, params = []) => one(admin, sql, params).then((r) => r.people ?? []);
const governanceHolders = () =>
    holders(`select sgn_internal.category_holders(sgn_internal.setting('passkey.recovery_notify_categories')) as people`);

/** 用自己的通行金鑰撤銷 target 的全部金鑰（畫面：撤銷清單上的顯示摘要加上原因）。 */
async function revokeSigned(revoker, target, reason) {
    const row = (await call(app, 'passkey_revocation_list', revoker.session)).find((r) => r.display.person.id === target.personId);
    const ch = await call(app, 'passkey_revoke_challenge', revoker.session, target.personId, reason);
    const challenge = await challengeFor({
        purpose: 'passkey.revocation',
        ref: target.personId,
        content: { ...row.display, reason },
        decision: 'revoke',
        nonce: ch.nonce,
    });
    return call(app, 'passkey_revoke_passkey', ch.challenge_id, ...raw(revoker.key.assert(challenge)));
}

/** 停用中的金鑰：本人用原金鑰簽、背書人背書。 */
async function restore(owner, endorser) {
    const [row] = await call(app, 'passkey_suspension_list', owner.session);
    for (const [who, key, purpose, decision] of [
        [owner, owner.key, 'passkey.restore', 'restore'],
        [endorser, endorser.key, 'passkey.restore_endorse', 'endorse'],
    ]) {
        const ch = await call(app, 'passkey_restore_challenge', who.session, row.display.suspension_id);
        const challenge = await challengeFor({ purpose, ref: row.display.suspension_id, content: ch.display, decision, nonce: ch.nonce });
        await call(app, 'passkey_restore_passkey', ch.challenge_id, ...raw(key.assert(challenge)));
    }
}

const usableFromExpected = (at, key) =>
    one(admin, `select sgn_internal.add_workdays($1::timestamptz, sgn_internal.setting_int($2)) as u`, [at, key]).then((r) =>
        new Date(r.u).getTime(),
    );
const endorsedAt = (enrollmentId) =>
    one(admin, 'select endorsed_at from sgn.passkey_enrollment where id = $1', [enrollmentId]).then((r) => r.endorsed_at);

test('K-PASSKEY-RECOVERY 撤銷某人金鑰的人（主管或登記人）期間內不得背書同一人的新金鑰；別人背書的復原金鑰冷卻期加長、當場開例外並通知本人、主管與治理角色', async () => {
    const boss = users.p25;
    const target = users.p26;
    assert.equal(
        (await one(admin, 'select (sgn_internal.resolve_manager($1)).manager_person_id as m', [target.personId])).m,
        boss.personId,
    );
    // 列 R1：主管撤銷下屬，再替冒用登入排進來的新金鑰背書（findings-7 高-1 的步驟）→ 擋下（挑戰值發不出來，清單上沒有背書的動作）
    await revokeSigned(boss, target, '紅隊第七輪：主管撤銷下屬');
    const attacker = newAuthenticator();
    const pending = await requestPasskey(app, target, attacker);
    await rejectsWith(call(app, 'passkey_endorse_challenge', boss.session, pending.enrollment_id, 'qr'), 'PASSKEY_ENDORSER_REVOKER');
    assert.equal(
        (await call(app, 'passkey_enrollment_list', boss.session)).find((e) => e.enrollment_id === pending.enrollment_id)?.actions.length ??
            0,
        0,
    );
    // 列 R2：另一位有權的人（登記人）背書：冷卻期改用 passkey.recovery_cooling_workdays、開 K-PASSKEY-RECOVERY、通知
    const x0 = await maxId('sgn.exception_record');
    const n0 = await maxId('sgn.notification_outbox');
    const done = await endorse(app, reg, pending.enrollment_id, await shownOn(attacker));
    const at = await endorsedAt(pending.enrollment_id);
    assert.equal(new Date(done.usable_from).getTime(), await usableFromExpected(at, 'passkey.recovery_cooling_workdays'));
    assert.ok(new Date(done.usable_from).getTime() > (await usableFromExpected(at, 'passkey.cooling_workdays')), '比一般的冷卻期長');
    const [ex] = await exceptionsSince('K-PASSKEY-RECOVERY', x0);
    assert.equal(ex.detail.person, target.personId);
    assert.equal(ex.detail.revoked_by, boss.personId);
    assert.equal(ex.detail.endorsed_by, reg.personId);
    assert.equal(ex.detail.settings['passkey.recovery_cooling_workdays'], 5);
    const expected = [...new Set([target.personId, boss.personId, ...(await governanceHolders())])].sort();
    assert.deepEqual([...new Set(await notifiedSince('passkey.recovery_registered', n0))].sort(), expected);
    // 冷卻期內不能簽
    assert.equal((await call(app, 'me', target.session)).passkeys, 0);
    // 列 R1（登記人也適用）：登記人撤銷之後也不能背書；第二位登記人可以
    await revokeSigned(reg, target, '紅隊第七輪：登記人撤銷');
    const again = newAuthenticator();
    const p2 = await requestPasskey(app, target, again);
    await rejectsWith(call(app, 'passkey_endorse_challenge', reg.session, p2.enrollment_id, 'qr'), 'PASSKEY_ENDORSER_REVOKER');
    await endorse(app, second, p2.enrollment_id, await shownOn(again));
    target.recoveryKey = again;
});

test('K-PASSKEY-NOT-ME 冷卻期內本人只憑登入回報「不是我登記的」：別人背書的那把立即撤銷、排著的登記作廢、開例外並通知；只會收回、有上限；期間過後回到一般的背書', async () => {
    const target = users.p26;
    const boss = users.p25;
    const me = await call(app, 'me', target.session);
    assert.equal(me.passkey_disownable, 1);
    const [row] = await call(app, 'passkey_not_me_list', target.session);
    assert.deepEqual(row.actions, ['report_not_me']);
    assert.equal(row.display.endorsed_by.id, second.personId);
    // 列 N2：別人不能替他回報（主管沒有可以回報的金鑰）
    await rejectsWith(call(app, 'passkey_report_not_me', boss.session, row.display.credential_id), 'PASSKEY_NOT_ME_NONE');
    // 冒用登入的人趁機排進來的登記一併作廢
    await requestPasskey(app, target, newAuthenticator());
    const x0 = await maxId('sgn.exception_record');
    const n0 = await maxId('sgn.notification_outbox');
    const done = await call(app, 'passkey_report_not_me', target.session, row.display.credential_id);
    assert.equal(done.revoked, 1);
    assert.equal(done.cancelled_enrollments, 1);
    assert.equal(done.reports_left, 1);
    const cred = await one(admin, 'select revoked_at from sgn.passkey_credential where credential_id = $1', [
        Buffer.from(row.display.credential_id, 'base64url'),
    ]);
    assert.ok(cred.revoked_at, '立即撤銷');
    const [ex] = await exceptionsSince('K-PASSKEY-NOT-ME', x0);
    assert.equal(ex.detail.person, target.personId);
    assert.equal(ex.detail.reports_in_window, 1);
    const expected = [...new Set([target.personId, boss.personId, second.personId, ...(await governanceHolders())])].sort();
    assert.deepEqual([...new Set(await notifiedSince('passkey.disowned', n0))].sort(), expected);
    // 列 N1：沒有可以回報的了；之後重新登記只能當面掃（本人只憑登入撤銷）
    await rejectsWith(call(app, 'passkey_report_not_me', target.session, row.display.credential_id), 'PASSKEY_NOT_ME_NONE');
    const p3 = await requestPasskey(app, target, newAuthenticator());
    const listed = (await call(app, 'passkey_enrollment_list', second.session)).find((e) => e.enrollment_id === p3.enrollment_id);
    assert.deepEqual(listed.methods, ['qr']);
    // 列 R3（期間過後）：撤銷已經超過 passkey.recovery_window_days，主管又可以背書，冷卻期回到一般的、不開例外
    await admin.query(
        `update sgn.passkey_revocation set revoked_at = revoked_at - make_interval(days => sgn_internal.setting_int('passkey.recovery_window_days') + 1)
         where person_id = $1`,
        [target.personId],
    );
    const fresh = newAuthenticator();
    const p4 = await requestPasskey(app, target, fresh);
    const x1 = await maxId('sgn.exception_record');
    const d4 = await endorse(app, boss, p4.enrollment_id, await shownOn(fresh));
    assert.equal(
        new Date(d4.usable_from).getTime(),
        await usableFromExpected(await endorsedAt(p4.enrollment_id), 'passkey.cooling_workdays'),
    );
    assert.deepEqual(await exceptionsSince('K-PASSKEY-RECOVERY', x1), []);
    // 列 N3：上限（passkey.not_me_max；這裡設成 1，時間窗內已經回報過 1 次）
    await setSetting(admin, 'passkey.not_me_max', 1);
    try {
        await rejectsWith(call(app, 'passkey_report_not_me', target.session, fresh.credentialIdB64), 'PASSKEY_NOT_ME_LIMIT');
    } finally {
        await setSetting(admin, 'passkey.not_me_max', 2);
    }
    // 列 N4：本人用自己已生效的舊金鑰核准的新金鑰、或已過冷卻期的，都不能回報（不是「別人背書、冷卻中」）
    await settlePasskey(app, fresh);
    target.key = fresh;
    await registerPasskey(app, target, newAuthenticator(), { endorser: target, settle: false });
    assert.deepEqual(await call(app, 'passkey_not_me_list', target.session), []);
    await rejectsWith(call(app, 'passkey_report_not_me', target.session, fresh.credentialIdB64), 'PASSKEY_NOT_ME_NONE');
});

test('K-REGISTRAR-MIN 可用的登記人少於下限（預設 2）就開例外並通知，回到下限結案；持有不能做決定的角色不算；安裝儀式（破窗）只在少於下限時能執行；K-PASSKEY-SUSPEND-HOLDER 恢復時當場結案', async () => {
    const available = () => one(admin, 'select sgn_internal.registrar_available() as a').then((r) => r.a);
    const open = () =>
        admin
            .query(`select id, detail from sgn.exception_record where rule_code = 'K-REGISTRAR-MIN' and closed_at is null`)
            .then((r) => r.rows);
    assert.deepEqual((await available()).sort(), [reg.personId, second.personId].sort(), '種子：兩位登記人（裁決 D88 (2)）');
    assert.deepEqual(await open(), []);
    // 列 G4：登記人在下限以上時，安裝儀式不能執行；後端帳號執行不到
    const ceremony = newAuthenticator();
    const install = (db) =>
        db.query('select sgn_internal.passkey_bootstrap($1, $2, $3, $4)', [
            users.p25.personId,
            ceremony.credentialIdB64,
            ceremony.spkiB64,
            '破窗',
        ]);
    await rejectsWith(install(admin), 'PASSKEY_BOOTSTRAP_DONE');
    await rejectsPermission(install(app));
    // 列 G1：第二位登記人被冒用登入停用 → 當場開例外並通知
    const x0 = await maxId('sgn.exception_record');
    const n0 = await maxId('sgn.notification_outbox');
    assert.equal((await call(app, 'passkey_revoke_self', second.session, '紅隊第七輪：停用登記人')).suspended, 1);
    const [ex] = await open();
    assert.deepEqual(ex.detail.available, [reg.personId]);
    assert.equal(ex.detail.settings['passkey.registrar_min'], 2);
    const people = await holders(`select sgn_internal.roles_holders(sgn_internal.setting('passkey.registrar_min_notify_roles')) as people`);
    assert.deepEqual([...new Set(await notifiedSince('passkey.registrar_min', n0))].sort(), [...new Set(people)].sort());
    // 登記人持有控制類角色：K-PASSKEY-SUSPEND-HOLDER 也開了
    const [holder] = await exceptionsSince('K-PASSKEY-SUSPEND-HOLDER', x0);
    assert.equal(holder.detail.person, second.personId);
    // 列 G2：排程再跑不重複開
    await scheduler.query('select api_job.governance_check()');
    assert.equal((await open()).length, 1);
    // 列 G3：恢復之後（本人原金鑰＋登記人背書）兩筆都當場結案
    await restore(second, reg);
    assert.deepEqual(await open(), []);
    const closed = await one(admin, 'select closed_at, close_detail from sgn.exception_record where id = $1', [holder.id]);
    assert.ok(closed.closed_at, 'K-PASSKEY-SUSPEND-HOLDER 結案');
    assert.equal(closed.close_detail.resolved, 'usable_key');
    // 持有不能做決定的角色的登記人不算（背書會被授權入口擋下）
    const excluded = (await one(admin, `select sgn_internal.setting('approval.excluded_decider_roles') ->> 0 as r`)).r;
    await admin.query(
        `insert into sgn.role_assignment (person_id, role_code, valid_from, source) values ($1, $2, clock_timestamp(), 'manual')`,
        [second.personId, excluded],
    );
    try {
        await scheduler.query('select api_job.governance_check()');
        assert.equal((await open()).length, 1, '只剩一位可用');
        // 列 G4：少於下限時，資料庫擁有者的安裝儀式可以執行（破窗），進鏈；回到下限就結案
        await install(admin);
        const boot = await one(
            admin,
            `select convert_from(body, 'UTF8')::jsonb as body from sgn.audit_event where event_type = 'passkey.bootstrapped' order by seq desc limit 1`,
        );
        assert.equal(boot.body.data.person, users.p25.personId);
        assert.deepEqual(boot.body.data.available_before, [reg.personId]);
        assert.deepEqual(await open(), []);
    } finally {
        await admin.query(
            `update sgn.role_assignment set valid_to = clock_timestamp()
             where valid_to is null and source = 'manual' and ((person_id = $1 and role_code = $2) or (person_id = $3 and role_code = 'passkey_registrar'))`,
            [second.personId, excluded, users.p25.personId],
        );
        await scheduler.query('select api_job.governance_check()');
    }
    assert.deepEqual(await open(), []);
});

test('K-PASSKEY-SUSPEND-FLOOD 全公司只憑登入的停用在時間窗內有上限：超過就不停用、開例外並通知（窗內一筆）；回到上限以下結案', async () => {
    const recent = (
        await one(
            admin,
            `select count(*)::int as n from sgn.passkey_suspension where suspended_at > clock_timestamp() - interval '24 hours'`,
        )
    ).n;
    const open = () =>
        admin
            .query(`select id, detail from sgn.exception_record where rule_code = 'K-PASSKEY-SUSPEND-FLOOD' and closed_at is null`)
            .then((r) => r.rows);
    // 列 F1：這次之後就到上限
    await setSetting(admin, 'passkey.suspend_global_max', recent + 1);
    try {
        const ok = await call(app, 'passkey_revoke_self', users.p20.session, '紅隊第七輪：大量停用');
        assert.equal(ok.suspended, 1);
        assert.equal(ok.refused, null);
        const n0 = await maxId('sgn.notification_outbox');
        const keysBefore = (await call(app, 'me', users.p23.session)).passkeys;
        assert.ok(keysBefore >= 1);
        const refused = await call(app, 'passkey_revoke_self', users.p23.session, '紅隊第七輪：大量停用');
        assert.equal(refused.suspended, 0);
        assert.equal(refused.refused.code, 'PASSKEY_SUSPEND_GLOBAL_LIMIT');
        assert.equal((await call(app, 'me', users.p23.session)).passkeys, keysBefore, '沒有停用');
        const [ex] = await open();
        assert.equal(ex.detail.refused_person, users.p23.personId);
        assert.deepEqual(ex.detail.settings, { 'passkey.suspend_global_max': recent + 1, 'passkey.suspend_global_window_hours': 24 });
        const people = await holders(
            `select sgn_internal.roles_holders(sgn_internal.setting('passkey.suspend_global_notify_roles')) as people`,
        );
        assert.deepEqual([...new Set(await notifiedSince('passkey.suspend_flood', n0))].sort(), [...new Set(people)].sort());
        // 列 F2：再被拒絕也不重複開
        assert.equal((await call(app, 'passkey_revoke_self', users.p23.session, '再一次')).refused.code, 'PASSKEY_SUSPEND_GLOBAL_LIMIT');
        assert.equal((await open()).length, 1);
    } finally {
        // 參數值只增不改：「改回去」是再新增一筆；這個資料庫裡前面的測試已經停用過不少人，留足空間給之後的測試
        await setSetting(admin, 'passkey.suspend_global_max', Math.max(10, recent + 10));
    }
    // 列 F3：回到上限以下，排程結案
    await scheduler.query('select api_job.governance_check()');
    assert.deepEqual(await open(), []);
});

test('K-EXCEPTION-CLOSE K-GOVERNANCE-KEY 在持有人有可用金鑰或不再持有治理類角色時結案（種子階段留下的也是）；去重只看未結案的，同一個人第二次出事再開；結案只有一個入口', async () => {
    const person = users.p29;
    const governance = (await one(admin, `select code from sgn.role where category = 'governance' order by code limit 1`)).code;
    const rows = (x0) => exceptionsSince('K-GOVERNANCE-KEY', x0).then((r) => r.filter((x) => x.detail.person === person.personId));
    await admin.query(
        `insert into sgn.role_assignment (person_id, role_code, valid_from, source) values ($1, $2, clock_timestamp(), 'manual')`,
        [person.personId, governance],
    );
    try {
        const x0 = await maxId('sgn.exception_record');
        // 列 E1：種子階段（還沒有人登記金鑰時）開的那種：持有人現在有可用的金鑰 → 排程結案，進鏈
        await one(admin, `select sgn_internal.exception_open('K-GOVERNANCE-KEY', null, $1) as id`, [
            { kind: 'governance_holder_without_key', person: person.personId, roles: [governance] },
        ]);
        await scheduler.query('select api_job.governance_check()');
        let list = await rows(x0);
        assert.equal(list.length, 1);
        assert.ok(list[0].closed_at);
        assert.equal(list[0].close_detail.resolved, 'usable_key');
        const event = await one(
            admin,
            `select convert_from(body, 'UTF8')::jsonb as body from sgn.audit_event
             where event_type = 'exception.closed' and convert_from(body, 'UTF8')::jsonb #>> '{data,exception}' = $1::text`,
            [list[0].id],
        );
        assert.deepEqual(event.body.data.detail.rules, ['K-GOVERNANCE-KEY'], '結案進鏈');
        // 列 E2：之後真的出事（登記人撤光金鑰）→ 撤銷當下就再開一筆（去重只看未結案的）
        await revokeSigned(reg, person, '紅隊第七輪：撤光治理類持有人');
        list = await rows(x0);
        assert.equal(list.length, 2);
        assert.equal(list[1].closed_at, null);
        await scheduler.query('select api_job.governance_check()');
        assert.equal((await rows(x0)).length, 2, '未結案的不重複開');
        // 列 E3：補登金鑰（撤銷的登記人不能背書，由第二位）並過冷卻期 → 結案；再出事再開第三筆
        const key = newAuthenticator();
        const pending = await requestPasskey(app, person, key);
        await approveEnrollment(app, person, pending.enrollment_id, await shownOn(key), second);
        await settlePasskey(app, key);
        person.key = key;
        await scheduler.query('select api_job.governance_check()');
        list = await rows(x0);
        assert.ok(list[1].closed_at);
        assert.equal(list[1].close_detail.resolved, 'usable_key');
        await call(app, 'passkey_revoke_self', person.session, '紅隊第七輪：第二次');
        assert.equal((await rows(x0)).filter((x) => x.closed_at === null).length, 1, '第二次出事：開新的一筆');
        // 列 E2（舊但仍有效）：這筆還沒結案時狀況已經用別的方式解除（例如管理者解除停用），排程還沒來得及結；
        // 這時再出事（登記人撤光）→ 先結掉舊的、再開新的一筆，不會被舊的那筆吃掉
        await admin.query('update sgn.passkey_credential set suspended_at = null, suspension_id = null where person_id = $1', [
            person.personId,
        ]);
        await revokeSigned(reg, person, '紅隊第七輪：第三次');
        list = await rows(x0);
        assert.equal(list.length, 4);
        assert.ok(list[2].closed_at, '舊的那筆結案');
        assert.equal(list[3].closed_at, null, '新的一筆');
    } finally {
        await admin.query(
            `update sgn.role_assignment set valid_to = clock_timestamp() where person_id = $1 and role_code = $2 and valid_to is null`,
            [person.personId, governance],
        );
    }
    // 列 E4：不再持有治理類角色 → 結案（依據 no_role）
    await scheduler.query('select api_job.governance_check()');
    const last = await one(
        admin,
        `select closed_at, close_detail from sgn.exception_record where rule_code = 'K-GOVERNANCE-KEY' and detail ->> 'person' = $1 order by id desc limit 1`,
        [person.personId],
    );
    assert.ok(last.closed_at);
    assert.equal(last.close_detail.resolved, 'no_role');
    // 結案只有一個入口：除了 sgn_internal.exception_close，沒有 function 改寫例外
    const writers = await admin.query(
        `select n.nspname || '.' || p.proname as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname in ('sgn_internal', 'api', 'api_job', 'api_delivery', 'api_idp', 'api_sync') and p.prosrc ~* 'update\\s+sgn\\.exception_record'`,
    );
    assert.deepEqual(
        writers.rows.map((r) => r.fn),
        ['sgn_internal.exception_close'],
    );
});
