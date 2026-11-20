// 挑戰值由瀏覽器從畫面上的內容自己算（裁決 D68；紅隊第二輪 高-2，redteam/exploits/04-backend-challenge-swap.mjs）。
// 攻擊者模型：拿到後端（sgn_app 連線、所有使用者的工作階段代碼），但頁面程式不是它送的：使用者按什麼，
// 瀏覽器就依畫面上的內容與按下的決定算挑戰值，後端只能轉送 nonce 與簽章。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';
import { lowS, signingChallenge, toB64url } from '../../../web/lib/signing.js';
import {
    call,
    challengeFor,
    closePools,
    createSubmittedCase,
    decidePasskey,
    decisionChallenge,
    issueChallenge,
    login,
    newAuthenticator,
    one,
    pool,
    proposalChallenge,
    registerPasskey,
    rejectsWith,
} from './lib/harness.mjs';

const app = pool('APP');
const admin = pool('ADMIN');
const users = {};
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

before(async () => {
    for (const uid of ['p03', 'p04', 'p16', 'p19']) users[uid] = await login(app, uid);
    for (const uid of ['p03', 'p16', 'p19']) users[uid].key = await registerPasskey(app, users[uid]);
});
after(closePools);

const caseState = async (caseId) => (await one(admin, 'select state from sgn.request_case where id = $1', [caseId])).state;

test('K-DECISION-PROOF 挑戰值的公式：資料庫的 signing_challenge 與瀏覽器的 web/lib/signing.js 算出相同的位元組', async () => {
    const nonce = createHash('sha256').update('nonce').digest();
    const samples = [
        {
            purpose: 'case.decision',
            ref: '42',
            content: { version_sha256: 'ab'.repeat(32), input: { reason: '請補充\n用途 "x" 😀' } },
            decision: 'reject',
        },
        {
            purpose: 'role_change.propose',
            ref: 'new',
            content: { holder_id: '00000000-0000-0000-0000-000000000001', scope_ref: null, n: 1.5 },
            decision: 'propose',
        },
        { purpose: 'passkey.enrollment', ref: 'e', content: {}, decision: 'endorse' },
    ];
    for (const sample of samples) {
        const browser = toB64url(await signingChallenge({ ...sample, nonce: nonce.toString('base64url') }));
        const db = await one(admin, `select sgn_internal.b64url_encode(sgn_internal.signing_challenge($1, $2, $3, $4, $5)) as v`, [
            sample.purpose,
            sample.ref,
            sample.content,
            sample.decision,
            nonce,
        ]);
        assert.equal(browser, db.v, sample.purpose);
    }
});

test('K-DECISION-PROOF 紅隊第二輪 高-2 情境 1 回歸：使用者按「駁回」，後端改要「核准」的 nonce——瀏覽器簽的是駁回，核准對不上', async () => {
    const caseId = await createSubmittedCase(app, users.p04);
    // 被入侵的後端：使用者按了駁回，後端改發核准的 nonce；challenge_issue 的回傳沒有可以直接簽的值
    const swapped = await call(app, 'challenge_issue', users.p03.session, caseId, 'approve', {});
    // display 是縮小後核准要給簽核人看的縮小內容（D75），其他決定為 null；都不是可以直接簽的值
    assert.deepEqual(Object.keys(swapped).sort(), ['challenge_id', 'display', 'expires_at', 'input', 'nonce']);
    assert.equal(swapped.display, null);
    // 使用者的瀏覽器依畫面與按下的決定（駁回、原因）自己算挑戰值
    const userSees = await decisionChallenge(app, users.p03, caseId, 'reject', { reason: '不同意' }, swapped);
    const signed = users.p03.key.assert(userSees);
    await rejectsWith(decidePasskey(app, swapped.challenge_id, 'approve', signed), 'SIGNED_CONTENT_MISMATCH');
    // 後端照實送「駁回」也不行：nonce 是發給核准的
    await rejectsWith(decidePasskey(app, swapped.challenge_id, 'reject', signed), 'DECISION_MISMATCH');
    assert.equal(await caseState(caseId), 'in_approval');
});

test('K-DECISION-PROOF 後端換掉畫面上的內容（版本、原因、單號）：瀏覽器依它顯示的內容算，資料庫用自己的紀錄重算，對不上', async () => {
    const caseA = await createSubmittedCase(app, users.p04);
    const caseB = await createSubmittedCase(app, users.p04);
    const ch = await call(app, 'challenge_issue', users.p03.session, caseA, 'return', { reason: '請補充用途' });
    const shownA = await call(app, 'case_get', users.p03.session, caseA);
    const variants = [
        // 原因被換掉（畫面顯示的不是使用者打的）
        {
            purpose: 'case.decision',
            ref: shownA.case_no,
            decision: 'return',
            content: { version_sha256: shownA.version_sha256, input: { reason: '別的原因' } },
        },
        // 單號被換掉（畫面上看的是 B 單）
        {
            purpose: 'case.decision',
            ref: (await call(app, 'case_get', users.p03.session, caseB)).case_no,
            decision: 'return',
            content: { version_sha256: shownA.version_sha256, input: { reason: '請補充用途' } },
        },
        // 內容版本被換掉
        {
            purpose: 'case.decision',
            ref: shownA.case_no,
            decision: 'return',
            content: { version_sha256: '00'.repeat(32), input: { reason: '請補充用途' } },
        },
        // 用途被換掉（同一把金鑰剛剛在別的用途按過）
        {
            purpose: 'role_change.decision',
            ref: shownA.case_no,
            decision: 'return',
            content: { version_sha256: shownA.version_sha256, input: { reason: '請補充用途' } },
        },
    ];
    for (const v of variants) {
        const a = users.p03.key.assert(await challengeFor({ ...v, nonce: ch.nonce }));
        await rejectsWith(decidePasskey(app, ch.challenge_id, 'return', a), 'SIGNED_CONTENT_MISMATCH');
    }
    const honest = users.p03.key.assert(await decisionChallenge(app, users.p03, caseA, 'return', { reason: '請補充用途' }, ch));
    assert.equal(await decidePasskey(app, ch.challenge_id, 'return', honest), 'returned');
});

test('K-DECISION-PROOF 紅隊第二輪 高-2 情境 2 回歸：提出角色變更也要提出人的通行金鑰；別人按金鑰簽的決定不能挪去核准角色變更', async () => {
    // 只有工作階段（後端）不能提出：舊的提出入口不存在，提出要 passkey
    await assert.rejects(
        app.query('select api.role_change_propose($1, $2, $3, $4, $5, $6)', [
            users.p16.session,
            users.p04.personId,
            'control_owner',
            null,
            'grant',
            'x',
        ]),
        (err) => err.code === '42883',
    );
    const spec = { holderId: users.p04.personId, role: 'security_responder', scope: null, change: 'grant', reason: '紅隊回歸' };
    const proposal = await call(
        app,
        'role_change_propose_challenge',
        users.p16.session,
        spec.holderId,
        spec.role,
        null,
        'grant',
        spec.reason,
    );
    // 後端把 p19（控制負責人）這一次對申請單按的金鑰，挪去簽這張提出
    const caseId = await createSubmittedCase(app, users.p04);
    const decision = await call(app, 'challenge_issue', users.p03.session, caseId, 'approve', {});
    const p19Touch = users.p19.key.assert(await decisionChallenge(app, users.p03, caseId, 'approve', {}, decision));
    const raw = (a) => [a.credentialId, a.authenticatorData, a.clientDataJSON, a.signature];
    await rejectsWith(call(app, 'role_change_propose_passkey', proposal.challenge_id, ...raw(p19Touch)), 'SIGNED_CONTENT_MISMATCH');
    // 被指派的人被換掉：後端改寫確認畫面的顯示摘要（D75），頁面照它畫、照它簽；資料庫依挑戰值記下的變更重算
    const forgedDisplay = { ...proposal, display: { ...proposal.display, holder: { id: users.p19.personId, name: '賴政達' } } };
    const swapped = users.p16.key.assert(await proposalChallenge(app, users.p16, spec, forgedDisplay));
    await rejectsWith(call(app, 'role_change_propose_passkey', proposal.challenge_id, ...raw(swapped)), 'SIGNED_CONTENT_MISMATCH');
    // 提出人自己按、內容是他看到的：成立
    const honest = users.p16.key.assert(await proposalChallenge(app, users.p16, spec, proposal));
    const proposed = await call(app, 'role_change_propose_passkey', proposal.challenge_id, ...raw(honest));
    assert.equal(proposed.status, 'pending');
    await admin.query('delete from sgn.role_change_request where id = $1', [proposed.request_id]);
});

test('K-DECISION-PROOF 簽章只收 low-s（D71）：同一個簽章換成 n−s 被擋，low-s 才接受', async () => {
    const caseId = await createSubmittedCase(app, users.p04);
    const ch = await issueChallenge(app, users.p03, caseId);
    const a = users.p03.key.assert(ch.challenge);
    const der = Buffer.from(a.signature, 'base64url');
    const rl = der[3];
    const r = BigInt(`0x${der.subarray(4, 4 + rl).toString('hex')}`);
    const s = BigInt(`0x${der.subarray(6 + rl, 6 + rl + der[5 + rl]).toString('hex')}`);
    assert.ok(s * 2n <= N, '測試的驗證器送出前已經換成 low-s');
    const int = (v) => {
        let h = v.toString(16);
        if (h.length % 2) h = `0${h}`;
        let b = Buffer.from(h, 'hex');
        if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
        return Buffer.concat([Buffer.from([0x02, b.length]), b]);
    };
    const body = Buffer.concat([int(r), int(N - s)]);
    const high = Buffer.concat([Buffer.from([0x30, body.length]), body]);
    assert.deepEqual(Buffer.from(lowS(new Uint8Array(high))), der, '瀏覽器端的換算與驗證器一致');
    await rejectsWith(decidePasskey(app, ch.challenge_id, 'approve', { ...a, signature: high.toString('base64url') }), 'PASSKEY_INVALID');
    assert.equal(await decidePasskey(app, ch.challenge_id, 'approve', a), 'completed');
});

test('K-DECISION-PROOF 還在冷卻期的金鑰不能簽章 → PASSKEY_NOT_ACTIVE', async () => {
    const fresh = await registerPasskey(app, users.p03, newAuthenticator(), { settle: false });
    const caseId = await createSubmittedCase(app, users.p04);
    const ch = await issueChallenge(app, users.p03, caseId);
    await rejectsWith(decidePasskey(app, ch.challenge_id, 'approve', fresh.assert(ch.challenge)), 'PASSKEY_NOT_ACTIVE');
    assert.equal(await caseState(caseId), 'in_approval');
});

test('K-DECISION-PROOF 紅隊 08 的競態改用新的挑戰值重打：同一份簽章同時送 5 次只生效一次；核准與駁回同時送只有一個生效', async () => {
    const attempt = (p) => p.then(() => 'ok').catch((err) => String(err.message).split(':')[0]);
    const caseA = await createSubmittedCase(app, users.p04);
    const ch = await issueChallenge(app, users.p03, caseA);
    const signed = users.p03.key.assert(ch.challenge);
    const replay = await Promise.all(Array.from({ length: 5 }, () => attempt(decidePasskey(app, ch.challenge_id, 'approve', signed))));
    assert.equal(replay.filter((r) => r === 'ok').length, 1, JSON.stringify(replay));
    assert.equal((await one(admin, 'select count(*)::int as n from sgn.decision_proof where challenge_id = $1', [ch.challenge_id])).n, 1);
    const caseB = await createSubmittedCase(app, users.p04);
    const approve = await issueChallenge(app, users.p03, caseB, 'approve');
    const reject = await issueChallenge(app, users.p03, caseB, 'reject', { reason: 'race' });
    const both = await Promise.all([
        attempt(decidePasskey(app, approve.challenge_id, 'approve', users.p03.key.assert(approve.challenge))),
        attempt(decidePasskey(app, reject.challenge_id, 'reject', users.p03.key.assert(reject.challenge))),
    ]);
    assert.equal(both.filter((r) => r === 'ok').length, 1, JSON.stringify(both));
});
