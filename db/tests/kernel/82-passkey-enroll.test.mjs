// 通行金鑰的登記（裁決 D65；紅隊第二輪 高-3，redteam/exploits/03-backend-nonce-passkey-register.mjs）。
// 攻擊者模型：拿到後端，可以在使用者下一次登入時換掉送給身分提供者的 nonce，讓再驗證綁定攻擊者的公鑰。
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
    approveEnrollment,
    call,
    challengeFor,
    closePools,
    createSubmittedCase,
    decidePasskey,
    endorse,
    idToken,
    issueChallenge,
    login,
    newAuthenticator,
    one,
    pool,
    registerPasskey,
    registrationNonce,
    rejectsPermission,
    rejectsWith,
    requestPasskey,
    settlePasskey,
    shownOn,
} from './lib/harness.mjs';

const app = pool('APP');
const admin = pool('ADMIN');
const users = {};

before(async () => {
    for (const uid of ['p03', 'p04', 'p05', 'p06', 'p11', 'p13', 'p14', 'p22']) users[uid] = await login(app, uid);
    for (const uid of ['p03', 'p11', 'p13', 'p22']) users[uid].key = await registerPasskey(app, users[uid]);
});
after(closePools);

const eventsOf = async (credentialId) =>
    (
        await admin.query(
            `select event_type, actor_person_id from sgn.audit_event
             where convert_from(body, 'UTF8')::jsonb #>> '{data,credential_id}' = $1 order by seq`,
            [credentialId],
        )
    ).rows;
const raw = (a) => [a.credentialId, a.authenticatorData, a.clientDataJSON, a.signature];

test('K-PASSKEY-ENROLL 紅隊第二輪 高-3 回歸：後端換 nonce 讓再驗證綁定攻擊者的金鑰——只成為待核准，簽不了任何決定；本人與主管收到通知', async () => {
    const outboxBefore = (
        await one(admin, `select count(*)::int as n from sgn.notification_outbox where event_code = 'passkey.enrollment_requested'`)
    ).n;
    const keysBefore = (await call(app, 'me', users.p05.session)).passkeys;
    const attacker = newAuthenticator();
    const begin = await call(app, 'passkey_register_begin', users.p05.session);
    const token = await idToken('p05', registrationNonce(begin.challenge, attacker.spki)); // p05 的「下一次登入」，nonce 被換掉
    const reg = await one(app, 'select api.passkey_register($1, $2, $3, $4) as r', [
        begin.challenge_id,
        token,
        attacker.credentialIdB64,
        attacker.spkiB64,
    ]);
    assert.equal(reg.r.status, 'pending');
    // 攻擊者的金鑰對 p04 的單（p05 不是簽核人；換成 p05 自己的單的主管也一樣）簽不了：金鑰不在可簽章的清單裡
    const caseId = await createSubmittedCase(app, users.p04);
    const ch = await issueChallenge(app, users.p03, caseId);
    await rejectsWith(decidePasskey(app, ch.challenge_id, 'approve', attacker.assert(ch.challenge)), 'PASSKEY_UNKNOWN');
    const me = await call(app, 'me', users.p05.session);
    assert.equal(me.passkeys, keysBefore, '可以簽章的金鑰沒有多');
    assert.ok(
        me.passkey_pending.some((e) => e.credential_id === attacker.credentialIdB64),
        '本人的畫面看得到這筆待核准的登記',
    );
    const notified = await admin.query(
        `select person_id from sgn.notification_outbox where event_code = 'passkey.enrollment_requested' order by id desc limit $1`,
        [
            (await one(admin, `select count(*)::int as n from sgn.notification_outbox where event_code = 'passkey.enrollment_requested'`))
                .n - outboxBefore,
        ],
    );
    assert.deepEqual(notified.rows.map((r) => r.person_id).sort(), [users.p05.personId, users.p03.personId].sort(), '本人與主管');
    assert.deepEqual(
        (await eventsOf(attacker.credentialIdB64)).map((e) => e.event_type),
        ['passkey.enrollment_requested'],
    );
});

test('K-PASSKEY-ENROLL 第一把金鑰：本人不能自己核准；同事、稽核不能背書；本人的主管或登記人以通行金鑰背書，比對新裝置的完整指紋', async () => {
    const key = newAuthenticator();
    const pending = await requestPasskey(app, users.p14, key); // p14 還沒有任何金鑰，主管是 p11
    // 本人沒有已生效的金鑰
    await rejectsWith(
        call(app, 'passkey_endorse_challenge', users.p14.session, pending.enrollment_id, 'qr'),
        'PASSKEY_ENDORSER_NOT_ALLOWED',
    );
    // 同事（有自己的金鑰也不行）、稽核
    await rejectsWith(
        call(app, 'passkey_endorse_challenge', users.p13.session, pending.enrollment_id, 'qr'),
        'PASSKEY_ENDORSER_NOT_ALLOWED',
    );
    await rejectsWith(call(app, 'passkey_endorse_challenge', users.p22.session, pending.enrollment_id, 'qr'), 'DECIDER_ROLE_EXCLUDED');
    // 主管 p11 的清單裡看得到、可以背書；清單的顯示摘要帶完整指紋
    const listed = (await call(app, 'passkey_enrollment_list', users.p11.session)).find((e) => e.enrollment_id === pending.enrollment_id);
    assert.deepEqual(listed.actions, ['endorse']);
    assert.ok((await call(app, 'me', users.p11.session)).capabilities.includes('passkey.endorse'));
    const { fingerprint } = await shownOn(key);
    assert.equal(listed.display.public_key_sha256, fingerprint);
    // D76：背書人掃到的指紋（新裝置上的）和資料庫的紀錄不同：簽的內容和紀錄不符
    const ch = await call(app, 'passkey_endorse_challenge', users.p11.session, pending.enrollment_id, 'qr');
    const content = (fp) => ({ ...listed.display, public_key_sha256: fp, method: 'qr', code_cost: null });
    const forged = users.p11.key.assert(
        await challengeFor({
            purpose: 'passkey.enrollment',
            ref: pending.enrollment_id,
            content: content('ff'.repeat(32)),
            decision: 'endorse',
            nonce: ch.nonce,
        }),
    );
    await rejectsWith(call(app, 'passkey_endorse_passkey', ch.challenge_id, ...raw(forged)), 'SIGNED_CONTENT_MISMATCH');
    const honest = users.p11.key.assert(
        await challengeFor({
            purpose: 'passkey.enrollment',
            ref: pending.enrollment_id,
            content: content(fingerprint),
            decision: 'endorse',
            nonce: ch.nonce,
        }),
    );
    const done = await call(app, 'passkey_endorse_passkey', ch.challenge_id, ...raw(honest));
    assert.equal(done.status, 'approved');
    // 鏈上：登記、背書（主管）、生效（本人的金鑰）
    const events = await eventsOf(key.credentialIdB64);
    assert.deepEqual(
        events.map((e) => [e.event_type, e.actor_person_id]),
        [
            ['passkey.enrollment_requested', users.p14.personId],
            ['passkey.endorsed', users.p11.personId],
            ['passkey.registered', users.p14.personId],
        ],
    );
    // 冷卻期內不能簽；冷卻期是一個營業日之後（參數 passkey.cooling_workdays）
    const usable = await one(
        admin,
        'select usable_from > clock_timestamp() as later from sgn.passkey_credential where credential_id = $1',
        [key.credentialId],
    );
    assert.equal(usable.later, true);
    assert.ok((await call(app, 'me', users.p14.session)).passkey_cooling_until);
    // 已經處理過的登記不能再背書
    await rejectsWith(call(app, 'passkey_endorse_challenge', users.p11.session, pending.enrollment_id, 'qr'), 'PASSKEY_ENROLLMENT_STATE');
});

test('K-PASSKEY-ENROLL 已有金鑰的人：新金鑰用舊金鑰核准；核准出來的金鑰只代表本人，不能簽別人的關', async () => {
    const second = newAuthenticator();
    const pending = await requestPasskey(app, users.p03, second);
    await endorse(app, users.p03, pending.enrollment_id, await shownOn(second)); // 用舊金鑰
    const events = await eventsOf(second.credentialIdB64);
    assert.equal(events.find((e) => e.event_type === 'passkey.endorsed').actor_person_id, users.p03.personId);
    // 另一個部門的人（第一把由登記人背書，已有金鑰就本人用舊金鑰）：金鑰是他的，不能拿來簽 p03 的關
    const other = newAuthenticator();
    const p06pending = await requestPasskey(app, users.p06, other);
    await approveEnrollment(app, users.p06, p06pending.enrollment_id, await shownOn(other));
    await settlePasskey(app, other);
    const caseId = await createSubmittedCase(app, users.p04);
    const ch = await issueChallenge(app, users.p03, caseId);
    await rejectsWith(decidePasskey(app, ch.challenge_id, 'approve', other.assert(ch.challenge)), 'NOT_APPROVER');
});

test('K-PASSKEY-ENROLL 第一位登記人只能由資料庫擁有者在安裝時建立一次；後端帳號執行不到', async () => {
    const boot = await one(admin, `select count(*)::int as n from sgn.audit_event where event_type = 'passkey.bootstrapped'`);
    assert.equal(boot.n, 1);
    const key = newAuthenticator();
    await rejectsPermission(
        app.query('select sgn_internal.passkey_bootstrap($1, $2, $3, $4)', [users.p05.personId, key.credentialIdB64, key.spkiB64, 'x']),
    );
    await rejectsWith(
        admin.query('select sgn_internal.passkey_bootstrap($1, $2, $3, $4)', [
            users.p05.personId,
            key.credentialIdB64,
            key.spkiB64,
            'again',
        ]),
        'PASSKEY_BOOTSTRAP_DONE',
    );
});
