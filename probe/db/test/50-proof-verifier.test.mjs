// 架構 (c)：簽章由獨立的驗證服務驗，服務以 sgn_probe_verifier 呼叫 api_verified；一般後端無權呼叫。
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startVerifierService } from '../tools/verifier-service.mjs';
import {
    closePools, createSubmittedCase, issueChallenge, login, newAuthenticator, one, pool, registerPasskey,
    rejectsPermission,
} from './lib/harness.mjs';

const app = pool('APP');
const verifierDb = pool('VERIFIER');
let service;
let applicant;
let manager;
let managerKey;

before(async () => {
    service = await startVerifierService({ port: 0 });
    applicant = await login(app, 'p04');
    manager = await login(app, 'p03');
    managerKey = await registerPasskey(app, manager);
});
after(async () => {
    await service.close();
    await closePools();
});

async function decideViaService(challengeId, decision, assertion) {
    const response = await fetch(`${service.url}/decide`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            challenge_id: challengeId,
            decision,
            credential_id: assertion.credentialId,
            authenticator_data: assertion.authenticatorData,
            client_data_json: assertion.clientDataJSON,
            signature: assertion.signature,
        }),
    });
    return response.json();
}

test('PRB-PROOF (c) 經驗證服務核准成功', async () => {
    const caseId = await createSubmittedCase(app, applicant);
    const ch = await issueChallenge(app, manager, caseId);
    assert.deepEqual(await decideViaService(ch.challenge_id, 'approve', managerKey.assert(ch.challenge)), { state: 'approved' });
});

test('攻擊 (c)：一般後端帳號呼叫 api_verified 被拒', async () => {
    const caseId = await createSubmittedCase(app, applicant);
    const ch = await issueChallenge(app, manager, caseId);
    await rejectsPermission(
        app.query(`select api_verified.case_decide_passkey($1, 'approve', $2, 99, '{}')`, [ch.challenge_id, managerKey.credentialIdB64]),
    );
});

test('攻擊 (c)：偽造簽章、重放、A 單證明用在 B 單、內容改過，服務或資料庫都擋下', async () => {
    const caseA = await createSubmittedCase(app, applicant);
    const caseB = await createSubmittedCase(app, applicant);
    const chA = await issueChallenge(app, manager, caseA);
    const chB = await issueChallenge(app, manager, caseB);
    const forged = { ...newAuthenticator().assert(chA.challenge), credentialId: managerKey.credentialIdB64 };
    assert.deepEqual(await decideViaService(chA.challenge_id, 'approve', forged), { error: 'PASSKEY_INVALID' });
    const proofA = managerKey.assert(chA.challenge);
    assert.deepEqual(await decideViaService(chB.challenge_id, 'approve', proofA), { error: 'PASSKEY_INVALID' });
    assert.deepEqual(await decideViaService(chA.challenge_id, 'approve', proofA), { state: 'approved' });
    assert.deepEqual(await decideViaService(chA.challenge_id, 'approve', proofA), { error: 'CHALLENGE_USED' });

    const caseC = await createSubmittedCase(app, applicant, { v: 1 });
    const oldCh = await issueChallenge(app, manager, caseC);
    const oldProof = managerKey.assert(oldCh.challenge);
    const back = await issueChallenge(app, manager, caseC, 'return');
    assert.deepEqual(await decideViaService(back.challenge_id, 'return', managerKey.assert(back.challenge)), { state: 'draft' });
    await app.query('select api.case_revise($1, $2, $3)', [applicant.session, caseC, { v: 2 }]);
    await app.query('select api.case_submit($1, $2)', [applicant.session, caseC]);
    assert.deepEqual(await decideViaService(oldCh.challenge_id, 'approve', oldProof), { error: 'CONTENT_CHANGED' });
});

test('(c) 殘餘風險（預期會成功）：拿到驗證服務的資料庫帳號，不必簽章就能以主管身分核准', async () => {
    const caseId = await createSubmittedCase(app, applicant);
    const ch = await issueChallenge(app, manager, caseId);
    const row = await one(verifierDb, `select api_verified.case_decide_passkey($1, 'approve', $2, 1000000, '{"forged":true}') as state`, [
        ch.challenge_id,
        managerKey.credentialIdB64,
    ]);
    assert.equal(row.state, 'approved');
});
