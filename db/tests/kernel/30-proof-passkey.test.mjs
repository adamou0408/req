// 架構 (a)：資料庫自己驗通行金鑰的簽章。攻擊者模型：拿到一般後端連線帳號（sgn_app），
// 甚至拿到主管的工作階段代碼（後端本來就看得到），試著以主管身分核准。
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
    call, closePools, createSubmittedCase, decidePasskey, idToken, issueChallenge, login, newAuthenticator, one, pool,
    registerPasskey, registrationNonce, rejectsPermission, rejectsWith,
} from './lib/harness.mjs';

const app = pool('APP');
const admin = pool('ADMIN');
let applicant; // p04
let manager; // p03（p04 的主管）
let attacker; // p05（同部門同事，有自己的通行金鑰）
let managerKey;
let attackerKey;

before(async () => {
    applicant = await login(app, 'p04');
    manager = await login(app, 'p03');
    attacker = await login(app, 'p05');
    managerKey = await registerPasskey(app, manager);
    attackerKey = await registerPasskey(app, attacker);
});
after(closePools);

test('PRB-PROOF (a) 主管以自己的通行金鑰核准：資料庫驗章後從憑證得出是誰，事件記下證明雜湊', async () => {
    const caseId = await createSubmittedCase(app, applicant);
    const ch = await issueChallenge(app, manager, caseId);
    assert.equal(await decidePasskey(app, ch.challenge_id, 'approve', managerKey.assert(ch.challenge)), 'approved');
    const event = await one(admin, `select actor_person_id, convert_from(body, 'UTF8')::jsonb -> 'data' as data from sgn.audit_event where case_id = $1 and event_type = 'case.approve'`, [caseId]);
    assert.equal(event.actor_person_id, manager.personId);
    assert.equal(event.data.proof_kind, 'passkey');
    assert.match(event.data.proof_sha256, /^[0-9a-f]{64}$/);
});

test('攻擊 (a)：一般後端帳號直接呼叫內部的決定 function 被拒', async () => {
    const caseId = await createSubmittedCase(app, applicant);
    const ch = await issueChallenge(app, manager, caseId);
    await rejectsPermission(app.query(`select sgn_internal.decision_prepare($1, 'approve')`, [ch.challenge_id]));
});

test('攻擊 (a)：持有主管的工作階段代碼，用自己產生（未登記）的金鑰簽 → PASSKEY_UNKNOWN', async () => {
    const caseId = await createSubmittedCase(app, applicant);
    const ch = await issueChallenge(app, manager, caseId);
    await rejectsWith(decidePasskey(app, ch.challenge_id, 'approve', newAuthenticator().assert(ch.challenge)), 'PASSKEY_UNKNOWN');
});

test('攻擊 (a)：拿主管的憑證 id 配上偽造的簽章 → PASSKEY_INVALID', async () => {
    const caseId = await createSubmittedCase(app, applicant);
    const ch = await issueChallenge(app, manager, caseId);
    const forged = newAuthenticator().assert(ch.challenge);
    await rejectsWith(decidePasskey(app, ch.challenge_id, 'approve', { ...forged, credentialId: managerKey.credentialIdB64 }), 'PASSKEY_INVALID');
});

test('攻擊 (a)：同事用自己合法登記的通行金鑰簽主管的挑戰值 → NOT_APPROVER', async () => {
    const caseId = await createSubmittedCase(app, applicant);
    const ch = await issueChallenge(app, manager, caseId);
    await rejectsWith(decidePasskey(app, ch.challenge_id, 'approve', attackerKey.assert(ch.challenge)), 'NOT_APPROVER');
});

test('攻擊 (a)：持有主管的工作階段代碼，想替主管登記攻擊者的金鑰 → 自己的 ID token 不被接受', async () => {
    const begin = await call(app, 'passkey_register_begin', manager.session);
    const rogue = newAuthenticator();
    const token = await idToken('p05', registrationNonce(begin.challenge, rogue.spki));
    await rejectsWith(
        app.query('select api.passkey_register($1, $2, $3, $4)', [begin.challenge_id, token, rogue.credentialIdB64, rogue.spkiB64]),
        'PERSON_UNKNOWN',
    );
});

test('攻擊 (a)：主管登記 A 金鑰的 ID token 被拿去登記攻擊者的 B 金鑰 → TOKEN_NONCE', async () => {
    const begin = await call(app, 'passkey_register_begin', manager.session);
    const legit = newAuthenticator();
    const token = await idToken('p03', registrationNonce(begin.challenge, legit.spki));
    const rogue = newAuthenticator();
    await rejectsWith(
        app.query('select api.passkey_register($1, $2, $3, $4)', [begin.challenge_id, token, rogue.credentialIdB64, rogue.spkiB64]),
        'TOKEN_NONCE',
    );
});

test('攻擊 (a)：重放同一份證明 → CHALLENGE_USED；舊證明配新挑戰值 → PASSKEY_INVALID', async () => {
    const caseId = await createSubmittedCase(app, applicant);
    const ch = await issueChallenge(app, manager, caseId);
    const assertion = managerKey.assert(ch.challenge);
    assert.equal(await decidePasskey(app, ch.challenge_id, 'approve', assertion), 'approved');
    await rejectsWith(decidePasskey(app, ch.challenge_id, 'approve', assertion), 'CHALLENGE_USED');
    const caseB = await createSubmittedCase(app, applicant);
    const chB = await issueChallenge(app, manager, caseB);
    await rejectsWith(decidePasskey(app, chB.challenge_id, 'approve', assertion), 'PASSKEY_INVALID');
});

test('攻擊 (a)：計數器恆為 0 的同步型通行金鑰，重放仍由一次性挑戰值擋下 → CHALLENGE_USED', async () => {
    const syncedKey = await registerPasskey(app, manager, newAuthenticator({ zeroCounter: true }));
    const caseId = await createSubmittedCase(app, applicant);
    const ch = await issueChallenge(app, manager, caseId);
    const assertion = syncedKey.assert(ch.challenge);
    assert.equal(await decidePasskey(app, ch.challenge_id, 'approve', assertion), 'approved');
    await rejectsWith(decidePasskey(app, ch.challenge_id, 'approve', assertion), 'CHALLENGE_USED');
});

test('攻擊 (a)：A 單的證明用在 B 單 → PASSKEY_INVALID，A、B 都沒被核准', async () => {
    const caseA = await createSubmittedCase(app, applicant);
    const caseB = await createSubmittedCase(app, applicant);
    const chA = await issueChallenge(app, manager, caseA);
    const chB = await issueChallenge(app, manager, caseB);
    await rejectsWith(decidePasskey(app, chB.challenge_id, 'approve', managerKey.assert(chA.challenge)), 'PASSKEY_INVALID');
    const states = await admin.query('select state from sgn.request_case where id = any($1)', [[caseA, caseB]]);
    assert.deepEqual(states.rows.map((r) => r.state), ['submitted', 'submitted']);
});

test('攻擊 (a)：內容改了之後用舊證明 → CONTENT_CHANGED', async () => {
    const caseId = await createSubmittedCase(app, applicant, { dataset: 'payroll', rows: 10 });
    const oldCh = await issueChallenge(app, manager, caseId, 'approve');
    const oldProof = managerKey.assert(oldCh.challenge);
    const back = await issueChallenge(app, manager, caseId, 'return');
    assert.equal(await decidePasskey(app, back.challenge_id, 'return', managerKey.assert(back.challenge)), 'draft');
    await app.query('select api.case_revise($1, $2, $3)', [applicant.session, caseId, { dataset: 'payroll', rows: 100000 }]);
    await app.query('select api.case_submit($1, $2)', [applicant.session, caseId]);
    await rejectsWith(decidePasskey(app, oldCh.challenge_id, 'approve', oldProof), 'CONTENT_CHANGED');
});

test('攻擊 (a)：使用者簽的是「退回」，後端改送「核准」 → DECISION_MISMATCH', async () => {
    const caseId = await createSubmittedCase(app, applicant);
    const ch = await issueChallenge(app, manager, caseId, 'return');
    await rejectsWith(decidePasskey(app, ch.challenge_id, 'approve', managerKey.assert(ch.challenge)), 'DECISION_MISMATCH');
});

test('攻擊 (a)：沒有使用者驗證（UV）、錯的 origin、錯的 rpId 一律 PASSKEY_INVALID', async () => {
    const caseId = await createSubmittedCase(app, applicant);
    const ch = await issueChallenge(app, manager, caseId);
    await rejectsWith(decidePasskey(app, ch.challenge_id, 'approve', managerKey.assert(ch.challenge, { flags: 0x01 })), 'PASSKEY_INVALID');
    await rejectsWith(decidePasskey(app, ch.challenge_id, 'approve', managerKey.assert(ch.challenge, { origin: 'https://evil.example' })), 'PASSKEY_INVALID');
    await rejectsWith(decidePasskey(app, ch.challenge_id, 'approve', managerKey.assert(ch.challenge, { rpId: 'evil.example' })), 'PASSKEY_INVALID');
    await rejectsWith(decidePasskey(app, ch.challenge_id, 'approve', managerKey.assert(ch.challenge, { type: 'webauthn.create' })), 'PASSKEY_INVALID');
});

test('攻擊 (a)：複製出來的驗證器（計數器倒退） → PASSKEY_COUNTER', async () => {
    const caseId = await createSubmittedCase(app, applicant);
    const ch = await issueChallenge(app, manager, caseId);
    const clone = Object.assign(Object.create(Object.getPrototypeOf(managerKey)), managerKey, { counter: 0 });
    await rejectsWith(decidePasskey(app, ch.challenge_id, 'approve', clone.assert(ch.challenge)), 'PASSKEY_COUNTER');
});

test('攻擊 (a)：過期的挑戰值 → CHALLENGE_EXPIRED（把有效期參數調成 1 秒）', async () => {
    await admin.query(`update sgn.setting set value = '1' where key = 'challenge.ttl_seconds'`);
    try {
        const caseId = await createSubmittedCase(app, applicant);
        const ch = await issueChallenge(app, manager, caseId);
        await new Promise((r) => setTimeout(r, 1500));
        await rejectsWith(decidePasskey(app, ch.challenge_id, 'approve', managerKey.assert(ch.challenge)), 'CHALLENGE_EXPIRED');
    } finally {
        await admin.query(`update sgn.setting set value = '300' where key = 'challenge.ttl_seconds'`);
    }
});
