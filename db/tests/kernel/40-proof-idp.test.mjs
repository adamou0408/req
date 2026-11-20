// 架構 (b)：資料庫自己驗 Dex 簽發的 ID token（RS256），nonce 必須是資料庫為這個決定發的挑戰值。
// 只為了和 (a) 通行金鑰比較而保留：正式建置沒有這條路徑（db/kernel/240_decision_proof_only_passkey.sql）。
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { after, before, test } from 'node:test';
import {
    call,
    closePools,
    createSubmittedCase,
    decideStepUp,
    idToken,
    issueChallenge,
    login,
    one,
    pool,
    rejectsWith,
    setSetting,
} from './lib/harness.mjs';

const app = pool('APP');
const admin = pool('ADMIN');
// 架構 (b) 不在後端帳號的路徑上（紅隊 高-2）：只裝在資料庫測試用的資料庫，以測試專用帳號呼叫
const verifier = pool('TEST_VERIFIER');
let applicant;
let manager;

before(async () => {
    applicant = await login(app, 'p04');
    manager = await login(app, 'p03');
});
after(closePools);

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
function parts(token) {
    const [h, p, s] = token.split('.');
    return { header: JSON.parse(Buffer.from(h, 'base64url')), payload: JSON.parse(Buffer.from(p, 'base64url')), h, p, s };
}

test('K-DECISION-PROOF (b) 主管以身分提供者再驗證核准：資料庫驗章、檢查 nonce＝挑戰值，從 token 得出是誰', async () => {
    const caseId = await createSubmittedCase(app, applicant);
    const ch = await issueChallenge(app, manager, caseId);
    assert.equal(await decideStepUp(verifier, ch.challenge_id, 'approve', await idToken('p03', ch.challenge)), 'completed');
    const event = await one(admin, `select actor_person_id from sgn.audit_event where case_id = $1 and event_type = 'case.approve'`, [
        caseId,
    ]);
    assert.equal(event.actor_person_id, manager.personId);
});

test('攻擊 (b)：偽造 token（alg=none、HS256、攻擊者自己的 RSA 金鑰冒用 kid、改 payload）→ TOKEN_INVALID', async () => {
    const caseId = await createSubmittedCase(app, applicant);
    const ch = await issueChallenge(app, manager, caseId);
    const real = parts(await idToken('p05', ch.challenge));
    const payload = { ...real.payload, federated_claims: { connector_id: 'ldap', user_id: 'p03' }, preferred_username: 'p03' };
    const none = `${b64({ alg: 'none', kid: real.header.kid })}.${b64(payload)}.`;
    await rejectsWith(decideStepUp(verifier, ch.challenge_id, 'approve', none), 'TOKEN_INVALID');
    const hs = `${b64({ alg: 'HS256', kid: real.header.kid })}.${b64(payload)}.${real.s}`;
    await rejectsWith(decideStepUp(verifier, ch.challenge_id, 'approve', hs), 'TOKEN_INVALID');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const input = `${real.h}.${b64(payload)}`;
    const ownKey = `${input}.${sign('sha256', Buffer.from(input), privateKey).toString('base64url')}`;
    await rejectsWith(decideStepUp(verifier, ch.challenge_id, 'approve', ownKey), 'TOKEN_INVALID');
    const swapped = `${real.h}.${b64(payload)}.${real.s}`;
    await rejectsWith(decideStepUp(verifier, ch.challenge_id, 'approve', swapped), 'TOKEN_INVALID');
});

test('攻擊 (b)：同事自己登入、nonce 填主管的挑戰值 → NOT_APPROVER', async () => {
    const caseId = await createSubmittedCase(app, applicant);
    const ch = await issueChallenge(app, manager, caseId);
    await rejectsWith(decideStepUp(verifier, ch.challenge_id, 'approve', await idToken('p05', ch.challenge)), 'NOT_APPROVER');
});

test('攻擊 (b)：主管平常登入的 token（nonce 是登入用的）拿來做決定 → TOKEN_NONCE', async () => {
    const begin = await call(app, 'session_begin');
    const loginToken = await idToken('p03', begin.nonce);
    const caseId = await createSubmittedCase(app, applicant);
    const ch = await issueChallenge(app, manager, caseId);
    await rejectsWith(decideStepUp(verifier, ch.challenge_id, 'approve', loginToken), 'TOKEN_NONCE');
});

test('攻擊 (b)：重放 → CHALLENGE_USED；A 單的 token 用在 B 單 → TOKEN_NONCE', async () => {
    const caseA = await createSubmittedCase(app, applicant);
    const caseB = await createSubmittedCase(app, applicant);
    const chA = await issueChallenge(app, manager, caseA);
    const chB = await issueChallenge(app, manager, caseB);
    const tokenA = await idToken('p03', chA.challenge);
    await rejectsWith(decideStepUp(verifier, chB.challenge_id, 'approve', tokenA), 'TOKEN_NONCE');
    assert.equal(await decideStepUp(verifier, chA.challenge_id, 'approve', tokenA), 'completed');
    await rejectsWith(decideStepUp(verifier, chA.challenge_id, 'approve', tokenA), 'CHALLENGE_USED');
});

test('攻擊 (b)：內容改了之後用舊 token → CONTENT_CHANGED；決定種類不符 → DECISION_MISMATCH', async () => {
    const caseId = await createSubmittedCase(app, applicant, { dataset: 'hr', rows: 1 });
    const oldCh = await issueChallenge(app, manager, caseId, 'approve');
    const oldToken = await idToken('p03', oldCh.challenge);
    const back = await issueChallenge(app, manager, caseId, 'return', { reason: '請補充用途' });
    const backToken = await idToken('p03', back.challenge);
    await rejectsWith(decideStepUp(verifier, back.challenge_id, 'approve', backToken), 'DECISION_MISMATCH');
    assert.equal(await decideStepUp(verifier, back.challenge_id, 'return', backToken), 'returned');
    await app.query('select api.case_revise($1, $2, $3, $4)', [applicant.session, caseId, { dataset: 'hr', rows: 999 }, {}]);
    await app.query('select api.case_submit($1, $2, $3)', [applicant.session, caseId, null]);
    await rejectsWith(decideStepUp(verifier, oldCh.challenge_id, 'approve', oldToken), 'CONTENT_CHANGED');
});

test('攻擊 (b)：太舊的 token → TOKEN_STALE（把新鮮度參數調成 0 秒）', async () => {
    const caseId = await createSubmittedCase(app, applicant);
    const ch = await issueChallenge(app, manager, caseId);
    const token = await idToken('p03', ch.challenge);
    await setSetting(admin, 'idp.token_max_age_seconds', 0);
    try {
        await new Promise((r) => setTimeout(r, 1100));
        await rejectsWith(decideStepUp(verifier, ch.challenge_id, 'approve', token), 'TOKEN_STALE');
    } finally {
        await setSetting(admin, 'idp.token_max_age_seconds', 300);
    }
});
