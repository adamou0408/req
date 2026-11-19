// 測試共用：各角色的連線、錯誤代碼斷言、登入、登記通行金鑰、建立送審中的申請單。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { adminUrl, loadConfig, roleUrl } from '../../tools/lib/env.mjs';
import { SoftAuthenticator } from './authenticator.mjs';
import { dexIdToken } from './oidc.mjs';

export const config = loadConfig();

const pools = [];
export function pool(roleKey) {
    const connectionString = roleKey === 'ADMIN' ? adminUrl(config) : roleUrl(config, roleKey);
    const p = new pg.Pool({ connectionString, max: 25 });
    pools.push(p);
    return p;
}
export async function closePools() {
    await Promise.all(pools.splice(0).map((p) => p.end()));
}

export const app = () => pool('APP');

/** 斷言 promise 以指定的錯誤代碼失敗（資料庫訊息以「代碼:」開頭）。 */
export async function rejectsWith(promise, code) {
    await assert.rejects(promise, (err) => {
        assert.ok(String(err.message).startsWith(`${code}:`), `expected ${code}, got: ${err.message}`);
        return true;
    });
}

/** 斷言 promise 因權限不足失敗（SQLSTATE 42501）。 */
export async function rejectsPermission(promise) {
    await assert.rejects(promise, (err) => {
        assert.equal(err.code, '42501', `expected permission denied, got ${err.code}: ${err.message}`);
        return true;
    });
}

export async function one(db, sql, params = []) {
    const { rows } = await db.query(sql, params);
    return rows[0];
}

/** 呼叫一個 api function（每個都回傳 jsonb），回傳解析後的值。 */
export async function call(db, fn, ...args) {
    const placeholders = args.map((_, i) => `$${i + 1}`).join(', ');
    const { rows } = await db.query(`select api.${fn}(${placeholders}) as result`, args);
    return rows[0].result;
}

export async function idToken(login, nonce) {
    return dexIdToken(config, login, nonce);
}

/** 走完一次登入：資料庫發 nonce → Dex 登入 → 資料庫驗 token → 回傳工作階段代碼。 */
export async function login(db, uid) {
    const begin = await call(db, 'session_begin');
    const token = await idToken(uid, begin.nonce);
    const opened = await call(db, 'session_open', begin.challenge_id, token);
    return { session: opened.session_token, personId: opened.person_id, uid };
}

export function newAuthenticator(options = {}) {
    return new SoftAuthenticator({ rpId: config.db.SGN_RP_ID, origin: config.db.SGN_RP_ORIGIN, ...options });
}

export function registrationNonce(challengeB64, spki) {
    return createHash('sha256')
        .update(Buffer.concat([Buffer.from(challengeB64, 'base64url'), spki]))
        .digest('base64url');
}

/** 登記通行金鑰：資料庫發挑戰值 → Dex 再驗證（nonce 綁定公鑰）→ 資料庫驗 token 並登記。 */
export async function registerPasskey(db, user, authenticator = newAuthenticator()) {
    const begin = await call(db, 'passkey_register_begin', user.session);
    const token = await idToken(user.uid, registrationNonce(begin.challenge, authenticator.spki));
    await db.query('select api.passkey_register($1, $2, $3, $4)', [
        begin.challenge_id,
        token,
        authenticator.credentialIdB64,
        authenticator.spkiB64,
    ]);
    return authenticator;
}

export async function createSubmittedCase(db, applicant, content = { dataset: 'sales_monthly', purpose: 'test', n: Math.random() }) {
    const submitted = await call(db, 'case_submit_new', applicant.session, content);
    return submitted.case_id;
}

export async function issueChallenge(db, approver, caseId, decision = 'approve') {
    return call(db, 'challenge_issue', approver.session, caseId, decision);
}

export async function decidePasskey(db, challengeId, decision, assertion) {
    const decided = await call(
        db,
        'case_decide_passkey',
        challengeId,
        decision,
        assertion.credentialId,
        assertion.authenticatorData,
        assertion.clientDataJSON,
        assertion.signature,
    );
    return decided.state;
}

export async function decideIdp(db, challengeId, decision, token) {
    const decided = await call(db, 'case_decide_idp', challengeId, decision, token);
    return decided.state;
}
