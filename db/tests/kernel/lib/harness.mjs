// 測試共用：各角色的連線、錯誤代碼斷言、登入、登記通行金鑰、建立送審中的申請單。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { decisionContent, keyFingerprint, shortCode, signingChallenge, toB64url } from '../../../../web/lib/signing.js';
import { RUN_DIR, adminUrl, loadConfig, roleUrl } from '../../../tools/lib/env.mjs';
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
    registrars.clear();
    await Promise.all(pools.splice(0).map((p) => p.end()));
}

export const app = () => pool('APP');

/**
 * 以管理者身分在 db（某個資料庫的連線池）同一個資料庫執行一句 SQL，用完就斷線（不留連線：有些測試要拿資料庫當範本複製）。
 * 只用來模擬「冷卻期已經過了」之類的時間推移；真實環境的時間不能倒退。
 */
async function adminOn(db, sql, params) {
    const database = new URL(db.options.connectionString).pathname.slice(1);
    const client = new pg.Client({ connectionString: adminUrl(config, database) });
    await client.connect();
    try {
        return await client.query(sql, params);
    } finally {
        await client.end();
    }
}

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

/** 測試行程的登入來源（D78：每個來源各自的上限）。 */
export const LOGIN_SOURCE = 'db-test';

/** 走完一次登入：資料庫發 nonce → Dex 登入 → 資料庫驗 token → 回傳工作階段代碼。 */
export async function login(db, uid) {
    const begin = await call(db, 'session_begin', LOGIN_SOURCE);
    const token = await idToken(uid, begin.nonce);
    const opened = await call(db, 'session_open', begin.challenge_id, token);
    return { session: opened.session_token, personId: opened.person_id, uid };
}

/** 這個行程建立過的軟體驗證器（依指紋），核准之後記成那個人的舊金鑰（見 rememberKey）。 */
const created = new Map();
const fingerprintOf = (spki) =>
    createHash('sha256')
        .update(spki.subarray(spki.length - 65))
        .digest('hex');

export function newAuthenticator(options = {}) {
    // WebAuthn 的 origin 是頁面的 origin（頁面與後端分開來源，裁決 D68）
    const authenticator = new SoftAuthenticator({ rpId: config.db.SGN_RP_ID, origin: config.db.SGN_WEB_ORIGIN, ...options });
    created.set(fingerprintOf(authenticator.spki), authenticator);
    return authenticator;
}

export function registrationNonce(challengeB64, spki) {
    return createHash('sha256')
        .update(Buffer.concat([Buffer.from(challengeB64, 'base64url'), spki]))
        .digest('base64url');
}

/** 扮演瀏覽器：從畫面上看得到的內容與資料庫給的 nonce 算出要簽的挑戰值（base64url；web/lib/signing.js）。 */
export const challengeFor = async (spec) => toB64url(await signingChallenge(spec));

/** 送出一個 assertion 的參數（credential_id、authenticator_data、client_data_json、signature 的順序）。 */
const assertionArgs = (a) => [a.credentialId, a.authenticatorData, a.clientDataJSON, a.signature];

/** 登記通行金鑰的第一步：資料庫發挑戰值 → Dex 再驗證（nonce 綁定公鑰）→ 資料庫建立待核准的登記。回傳登記。 */
export async function requestPasskey(db, user, authenticator = newAuthenticator()) {
    const begin = await call(db, 'passkey_register_begin', user.session);
    const token = await idToken(user.uid, registrationNonce(begin.challenge, authenticator.spki));
    const { rows } = await db.query('select api.passkey_register($1, $2, $3, $4) as result', [
        begin.challenge_id,
        token,
        authenticator.credentialIdB64,
        authenticator.spkiB64,
    ]);
    return rows[0].result;
}

/**
 * 扮演背書人的瀏覽器（D76）：看著新裝置的畫面核對。onDevice 是新裝置畫面上的東西：{ fingerprint }（完整指紋，
 * QR 碼的內容）。軟體驗證器用 shownOn(authenticator) 取得；端對端測試從新裝置的頁面讀。
 * method qr：背書人的裝置掃 QR 碼拿到完整指紋，簽進內容。
 * method code：兩邊各自從自己拿到的指紋算 12 位數核對碼，對得上才簽；簽的是清單（畫面）上的指紋與成本。
 */
export async function endorse(db, endorser, enrollmentId, onDevice, method = 'qr') {
    if (!onDevice?.fingerprint) throw new Error('背書要看著新裝置的畫面核對（onDevice.fingerprint）');
    const ch = await call(db, 'passkey_endorse_challenge', endorser.session, enrollmentId, method);
    const challenge = await endorsementChallenge(db, endorser, enrollmentId, ch, { method, onDevice });
    const done = await call(db, 'passkey_endorse_passkey', ch.challenge_id, ...assertionArgs(endorser.key.assert(challenge)));
    // 核准的是這個行程建立的軟體金鑰：記成那個人的舊金鑰（之後的測試要用它核准他的新金鑰）
    const device = created.get(done.display.public_key_sha256);
    if (device) rememberKey(done.display.person.id, device, device.toJSON());
    return done;
}

/** 軟體驗證器在新裝置畫面上會顯示的東西（完整指紋）。 */
export const shownOn = async (authenticator) => ({ fingerprint: await keyFingerprint(authenticator.spki) });

/**
 * 背書的挑戰值：待核准清單（畫面）上的顯示摘要，加上核對方式與成本。ch 是 passkey_endorse_challenge 的結果。
 * qr 時指紋換成掃到的那一個；code 時兩邊的核對碼對不上就不簽（誠實的背書人）。
 */
export async function endorsementChallenge(db, endorser, enrollmentId, ch, { method = 'qr', onDevice }) {
    const shown = (await call(db, 'passkey_enrollment_list', endorser.session)).find((e) => e.enrollment_id === enrollmentId);
    let fingerprint = shown.display.public_key_sha256;
    if (method === 'qr') fingerprint = onDevice.fingerprint;
    else if ((await shortCode(fingerprint, shown.code_cost)) !== (await shortCode(onDevice.fingerprint, shown.code_cost)))
        throw new Error('核對碼不同：誠實的背書人不會背書');
    const content = {
        ...shown.display,
        public_key_sha256: fingerprint,
        method,
        code_cost: method === 'code' ? shown.code_cost : null,
    };
    return challengeFor({ purpose: 'passkey.enrollment', ref: enrollmentId, content, decision: 'endorse', nonce: ch.nonce });
}

/** 不同行程依序使用同一把軟體金鑰：計數器取時間（每 0.1 秒遞增），任何一份複本簽的計數器都比之前的大。 */
const timeCounter = () => Math.floor((Date.now() - 1.7e12) / 100);

const registrars = new Map();
const registrarFile = () => JSON.parse(readFileSync(join(RUN_DIR, `registrar-${config.database}.json`), 'utf8'));
/**
 * 系統的第一位登記人（db/tools/bootstrap-registrar.mjs 在建置時由資料庫擁有者建立，金鑰存在 .run/）。
 */
export function registrar(db) {
    if (!registrars.has(db)) {
        const saved = registrarFile();
        registrars.set(
            db,
            login(db, saved.uid).then((user) => ({
                ...user,
                key: liveKeys.get(saved.uid) ?? newAuthenticator({ ...saved.key, counterFrom: timeCounter }),
            })),
        );
    }
    return registrars.get(db);
}

/**
 * 測試裡每個人的「舊金鑰」（D76：已有金鑰的人，新金鑰只能由本人用舊金鑰核准）。每個資料庫一個檔
 * （.run/passkeys-<資料庫>.json，db/build.sh 重建資料庫時刪除），以內部 id 記下這個人在這個資料庫第一把被核准的軟體金鑰，
 * 之後的測試（不同行程）要再登記新金鑰時，扮演本人用它核准。同一個行程裡用同一個物件（計數器接續）；
 * 從檔案讀回的複本計數器取時間，比之前任何一次都大。登記人的舊金鑰就是安裝時建立的那一把。
 */
const keyFile = () => join(RUN_DIR, `passkeys-${config.database}.json`);
const liveKeys = new Map();

function savedKeys() {
    try {
        return JSON.parse(readFileSync(keyFile(), 'utf8'));
    } catch {
        return {};
    }
}

/** 這個人（user：{uid, personId}）的舊金鑰（軟體驗證器）；沒有就是 null。 */
export async function oldKey(db, user) {
    const id = user.personId;
    if (liveKeys.has(id)) return liveKeys.get(id);
    const saved = savedKeys()[id];
    if (saved)
        liveKeys.set(
            id,
            new SoftAuthenticator({ rpId: config.db.SGN_RP_ID, origin: config.db.SGN_WEB_ORIGIN, ...saved, counterFrom: timeCounter }),
        );
    else {
        const reg = await registrar(db);
        if (reg.personId === id) liveKeys.set(id, reg.key);
        // 安裝時建立的其他登記人（bootstrap-registrar.mjs 的 others；裁決 D88 (2) 的第二位登記人）
        const other = registrarFile().others?.find((o) => o.uid === user.uid);
        if (other)
            liveKeys.set(
                id,
                new SoftAuthenticator({
                    rpId: config.db.SGN_RP_ID,
                    origin: config.db.SGN_WEB_ORIGIN,
                    ...other.key,
                    counterFrom: timeCounter,
                }),
            );
    }
    return liveKeys.get(id) ?? null;
}

/**
 * 記下這個人（內部 id）的舊金鑰（只記第一把）。authenticator 是這個行程裡的物件（沒有就傳 null）；keyJson 寫進檔案給之後的行程。
 * 端對端測試從瀏覽器的虛擬驗證器取出私鑰後也記在這裡。
 */
export function rememberKey(personId, authenticator, keyJson) {
    if (authenticator && !liveKeys.has(personId)) liveKeys.set(personId, authenticator);
    const all = savedKeys();
    if (all[personId]) return;
    all[personId] = keyJson;
    writeFileSync(keyFile(), `${JSON.stringify(all)}\n`, { mode: 0o600 });
}

/** 模擬「新金鑰的冷卻期已經過了」（passkey.cooling_workdays）。db 是登記時用的連線池（決定在哪個資料庫）。 */
export async function settlePasskey(db, authenticator) {
    await adminOn(db, `update sgn.passkey_credential set usable_from = clock_timestamp() - interval '1 second' where credential_id = $1`, [
        authenticator.credentialId,
    ]);
}

/**
 * 核准一筆登記（合法流程）：指定的 endorser；否則本人已有舊金鑰就由本人用舊金鑰核准（D76），沒有才由登記人背書。
 * onDevice 是新裝置畫面上的完整指紋（{ fingerprint }）。
 */
export async function approveEnrollment(db, user, enrollmentId, onDevice, endorser = null) {
    const own = endorser ? null : await oldKey(db, user);
    // 舊金鑰可能是剛登記、還在冷卻期的那一把：模擬冷卻期已過（時間推移，測試準備）
    if (own) await settlePasskey(db, own);
    return endorse(db, endorser ?? (own ? { ...user, key: own } : await registrar(db)), enrollmentId, onDevice);
}

/**
 * 登記一把可以用的通行金鑰（合法流程）：再驗證 → 待核准 → 核准 →（預設）模擬冷卻期已過。
 * 核准的人：指定的 endorser；否則本人已有舊金鑰就由本人用舊金鑰核准（D76），沒有才由登記人背書。
 * 背書人與本人都看著新裝置的畫面（完整指紋）核對。
 */
export async function registerPasskey(db, user, authenticator = newAuthenticator(), { endorser = null, settle = true } = {}) {
    const enrollment = await requestPasskey(db, user, authenticator);
    await approveEnrollment(db, user, enrollment.enrollment_id, await shownOn(authenticator), endorser);
    if (settle) await settlePasskey(db, authenticator);
    return authenticator;
}

/**
 * 扮演簽核人的瀏覽器：拿 nonce，讀畫面上的單（case_get）自己算版本雜湊與輸入，算出決定要簽的挑戰值。
 * 回傳 challenge_issue 的結果，加上算好的 challenge。原因用畫面上輸入的（頭尾空白去掉）；縮小後的內容用資料庫整理後給簽核人看的那一份。
 */
export async function issueChallenge(db, person, caseId, decision = 'approve', input = {}) {
    const ch = await call(db, 'challenge_issue', person.session, caseId, decision, input);
    return { ...ch, challenge: await decisionChallenge(db, person, caseId, decision, input, ch) };
}

/** 決定的挑戰值。ch 是 challenge_issue 的結果（只用它的 nonce 與縮小後的內容與顯示）。內容只取畫面上的顯示摘要（D75）。 */
export async function decisionChallenge(db, person, caseId, decision, input, ch) {
    const shown = await call(db, 'case_get', person.session, caseId);
    const typed = { reason: String(input.reason ?? '').replace(/^ +| +$/g, ''), payload: shown.fulfilment?.payload };
    const content = await decisionContent(
        shown.display,
        decision,
        decision === 'approve_reduced' ? { ...ch.input, display: ch.display } : typed,
    );
    return challengeFor({ purpose: 'case.decision', ref: shown.display.case_no, content, decision, nonce: ch.nonce });
}

/** 扮演提出人的瀏覽器：確認畫面只從資料庫回傳的顯示摘要畫出，簽的就是它（D75）。 */
export async function proposeRole(db, proposer, spec) {
    const { holderId, role, scope = null, change = 'grant', reason = '測試' } = spec;
    const ch = await call(db, 'role_change_propose_challenge', proposer.session, holderId, role, scope, change, reason);
    const challenge = await proposalChallenge(db, proposer, { holderId, role, scope, change, reason }, ch);
    return call(db, 'role_change_propose_passkey', ch.challenge_id, ...assertionArgs(proposer.key.assert(challenge)));
}

/** 提出的挑戰值。ch 是 role_change_propose_challenge 的結果（它的 display 就是確認畫面上的內容）。 */
export async function proposalChallenge(db, proposer, spec, ch) {
    return challengeFor({ purpose: 'role_change.propose', ref: 'new', content: ch.display, decision: 'propose', nonce: ch.nonce });
}

/** 扮演核准人（或冷卻期內擋下的人）的瀏覽器：從變更清單（畫面）上的顯示摘要算挑戰值。 */
export async function decideRole(db, person, requestId, decision = 'approve', key = person.key) {
    const ch = await call(db, 'role_change_challenge', person.session, requestId, decision);
    const challenge = await roleDecisionChallenge(db, person, requestId, decision, ch);
    return call(db, 'role_change_decide_passkey', ch.challenge_id, decision, ...assertionArgs(key.assert(challenge)));
}

/** 核准或擋下的挑戰值。ch 是 role_change_challenge 的結果。 */
export async function roleDecisionChallenge(db, person, requestId, decision, ch) {
    const shown = (await call(db, 'role_change_list', person.session)).find((q) => q.request_id === requestId);
    return challengeFor({ purpose: 'role_change.decision', ref: requestId, content: shown.display, decision, nonce: ch.nonce });
}

/** 核心測試用的流程類型（db/testing/60_probe_process.sql）：一關、申請人的主管簽，沒有 hook。 */
export const PROBE = 'probe';

export async function createSubmittedCase(db, applicant, content = { dataset: 'sales_monthly', purpose: 'test', n: Math.random() }) {
    const submitted = await call(db, 'case_submit_new', applicant.session, PROBE, content, {}, null);
    return submitted.case_id;
}

/** 新增一筆全域（或指定範圍）的參數值，立即生效。參數值只增不改，所以「改回去」也是再新增一筆。 */
export async function setSetting(admin, key, value, scopeRef = 'global') {
    await admin.query(
        `insert into sgn.setting_value (key, scope_ref, value, effective_from, recorded_at, reason)
         values ($1, $2, $3, clock_timestamp(), clock_timestamp(), 'test')`,
        [key, scopeRef, JSON.stringify(value)],
    );
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

/**
 * 以身分提供者再驗證的 ID token 做決定，走「後端帳號」（api.case_decide_idp）。正式建置與資料庫測試都沒有這條路徑
 * （紅隊 高-2）：攻擊腳本與回歸測試用它斷言「後端帳號做不到」。
 */
export async function decideIdp(db, challengeId, decision, token) {
    const decided = await call(db, 'case_decide_idp', challengeId, decision, token);
    return decided.state;
}

/** 比較用的架構 (b)：只裝在資料庫測試用的資料庫、只有測試專用帳號能執行（db/testing/70_idp_decide.sql）。 */
export async function decideStepUp(verifier, challengeId, decision, token) {
    const { rows } = await verifier.query('select api_verified.case_decide_idp($1, $2, $3) as result', [challengeId, decision, token]);
    return rows[0].result.state;
}

/**
 * 模擬「主管異動的冷卻期已經過了」：把這個人目前、由同步異動而來的主管關係的起點往前移 5 天。
 * 只給測試用的管理者連線使用（真實環境的時間不能倒退）。
 */
export async function settleManagerChange(admin, personId) {
    await admin.query(
        `update sgn.reporting_line set valid_from = valid_from - interval '5 days'
         where person_id = $1 and valid_to is null and origin = 'sync_change'`,
        [personId],
    );
}

/**
 * 模擬「人員同步的冷卻期已經過了」（directory.sync_cooling_workdays）：把這個人由同步而來、還沒生效的業務角色新增與
 * 排定的移除、延後的停用、延後的姓名／email／恢復在職，都往前移 5 天（到期的由下一次同步或排程套用）。只給測試用的管理者連線使用。
 */
export async function settleSyncChanges(admin, personId) {
    await admin.query(
        `update sgn.role_assignment set effective_from = effective_from - interval '5 days'
         where person_id = $1 and effective_from > clock_timestamp()`,
        [personId],
    );
    await admin.query(
        `update sgn.role_assignment set valid_to = valid_to - interval '5 days'
         where person_id = $1 and valid_to > clock_timestamp()`,
        [personId],
    );
    await admin.query(
        `update sgn.person_deactivation set effective_at = effective_at - interval '5 days'
         where person_id = $1 and applied_at is null and cancelled_at is null`,
        [personId],
    );
    await admin.query(
        `update sgn.person_change set effective_at = effective_at - interval '5 days'
         where person_id = $1 and applied_at is null and cancelled_at is null`,
        [personId],
    );
}
