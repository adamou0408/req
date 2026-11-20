// 金鑰登記的強度以「攻擊者可以離線試幾次」來算（裁決 D76；紅隊第三輪 高-2，redteam/exploits/03-backend-nonce-passkey-register.mjs）。
// 攻擊者模型：拿到後端。可以在受害者登記時把公鑰換成自己的（再驗證的 nonce 也跟著換）、可以改寫背書人畫面上的清單與參數、
// 可以離線產生任意多把金鑰；不能改頁面程式，也不知道受害者新裝置上的私鑰。
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { ENROLLMENT_CODE_COST, shortCode } from '../../../web/lib/signing.js';
import {
    call,
    challengeFor,
    closePools,
    endorse,
    endorsementChallenge,
    login,
    newAuthenticator,
    oldKey,
    one,
    pool,
    registerPasskey,
    registrar,
    rejectsWith,
    requestPasskey,
    setSetting,
    shownOn,
} from './lib/harness.mjs';

const app = pool('APP');
const admin = pool('ADMIN');
const users = {};

before(async () => {
    for (const uid of ['p02', 'p03', 'p08', 'p26']) users[uid] = await login(app, uid);
    for (const uid of ['p02', 'p03']) users[uid].key = await registerPasskey(app, users[uid]);
});
after(closePools);

const raw = (a) => [a.credentialId, a.authenticatorData, a.clientDataJSON, a.signature];
const listedFor = async (viewer, enrollmentId) =>
    (await call(app, 'passkey_enrollment_list', viewer.session)).find((e) => e.enrollment_id === enrollmentId);

test('K-PASSKEY-ENROLL 12 位數核對碼：慢速雜湊從完整指紋算出，成本是參數；頁面只接受窄範圍的成本（擋多目標碰撞）', async () => {
    const def = await one(
        admin,
        `select default_value::int as cost from sgn.setting_definition where key = 'passkey.enrollment_code_cost'`,
    );
    assert.ok(def.cost >= ENROLLMENT_CODE_COST.min && def.cost <= ENROLLMENT_CODE_COST.max, '參數的預設值在頁面接受的範圍內');
    const fp = 'ab'.repeat(32);
    const code = await shortCode(fp, def.cost);
    assert.match(code, /^\d{12}$/);
    // 指紋差一個位元、成本不同，碼就不同（成本也是鹽，每個成本各是一個獨立的目標）
    assert.notEqual(await shortCode(`${'ab'.repeat(31)}aa`, def.cost), code);
    assert.notEqual(await shortCode(fp, def.cost - 1), code);
    // 後端給新裝置的頁面範圍外的成本（便宜的、或任意多種）：頁面立即拒絕，不顯示碼
    for (const bad of [1, 10, ENROLLMENT_CODE_COST.min - 1, ENROLLMENT_CODE_COST.max + 1, '22', undefined])
        assert.throws(() => shortCode(fp, bad), RangeError, String(bad));
});

test('K-PASSKEY-ENROLL 紅隊第三輪 高-2 R2 回歸：後端把受害者的公鑰換成自己的——背書人比對新裝置的完整指紋（QR）或核對碼，簽了也對不上', async () => {
    // 受害者：還沒有任何金鑰的人（第一把，背書人是登記人）
    const victim = await one(
        admin,
        `select i.external_id as uid from sgn.person p join sgn.person_identity i on i.person_id = p.id
         where p.active and i.external_id ~ '^p[0-9]+$' and not exists (select 1 from sgn.passkey_credential k where k.person_id = p.id)
           and not exists (select 1 from sgn.role_assignment a where a.person_id = p.id and a.role_code in ('auditor', 'tech_ops'))
         order by i.external_id limit 1`,
    );
    const victimUser = await login(app, victim.uid);
    const victimDevice = newAuthenticator();
    const attacker = newAuthenticator({ credentialId: victimDevice.credentialIdB64 });
    const pending = await requestPasskey(app, victimUser, attacker); // 受害者登記，後端換成攻擊者的公鑰
    const manager = await registrar(app);
    // QR：背書人的裝置掃到的是受害者新裝置上的指紋，資料庫的紀錄是攻擊者的
    await rejectsWith(endorse(app, manager, pending.enrollment_id, await shownOn(victimDevice), 'qr'), 'SIGNED_CONTENT_MISMATCH');
    // 核對碼：背書人的頁面從清單的指紋（攻擊者的）算、本人念的是自己裝置上的碼——誠實的背書人不會簽
    await assert.rejects(endorse(app, manager, pending.enrollment_id, await shownOn(victimDevice), 'code'), /核對碼不同/);
    // 後端把清單的指紋改成受害者的（讓兩邊的碼一樣）：簽的內容是受害者的指紋，資料庫的紀錄是攻擊者的
    const ch = await call(app, 'passkey_endorse_challenge', manager.session, pending.enrollment_id, 'code');
    const listed = await listedFor(manager, pending.enrollment_id);
    const forged = {
        ...listed.display,
        public_key_sha256: (await shownOn(victimDevice)).fingerprint,
        method: 'code',
        code_cost: listed.code_cost,
    };
    const a = manager.key.assert(
        await challengeFor({
            purpose: 'passkey.enrollment',
            ref: pending.enrollment_id,
            content: forged,
            decision: 'endorse',
            nonce: ch.nonce,
        }),
    );
    await rejectsWith(call(app, 'passkey_endorse_passkey', ch.challenge_id, ...raw(a)), 'SIGNED_CONTENT_MISMATCH');
    // 後端把背書人頁面的成本改便宜（讓離線碰撞可行）：簽進去的成本和參數不符
    const ch2 = await call(app, 'passkey_endorse_challenge', manager.session, pending.enrollment_id, 'code');
    const cheap = { ...listed.display, method: 'code', code_cost: ENROLLMENT_CODE_COST.min };
    const b = manager.key.assert(
        await challengeFor({
            purpose: 'passkey.enrollment',
            ref: pending.enrollment_id,
            content: cheap,
            decision: 'endorse',
            nonce: ch2.nonce,
        }),
    );
    await rejectsWith(call(app, 'passkey_endorse_passkey', ch2.challenge_id, ...raw(b)), 'SIGNED_CONTENT_MISMATCH');
    // 換核對方式（挑戰值發給 qr，頁面簽 code）也對不上
    const ch3 = await call(app, 'passkey_endorse_challenge', manager.session, pending.enrollment_id, 'qr');
    const c = manager.key.assert(
        await challengeFor({
            purpose: 'passkey.enrollment',
            ref: pending.enrollment_id,
            content: { ...listed.display, method: 'code', code_cost: listed.code_cost },
            decision: 'endorse',
            nonce: ch3.nonce,
        }),
    );
    await rejectsWith(call(app, 'passkey_endorse_passkey', ch3.challenge_id, ...raw(c)), 'SIGNED_CONTENT_MISMATCH');
    await rejectsWith(call(app, 'passkey_endorse_challenge', manager.session, pending.enrollment_id, 'short'), 'PASSKEY_METHOD_INVALID');
    assert.equal((await one(admin, 'select status from sgn.passkey_enrollment where id = $1', [pending.enrollment_id])).status, 'pending');
});

test('K-PASSKEY-ENROLL 誠實的核對碼流程：兩邊從各自的指紋算出同一組 12 位數，背書人簽的是指紋與參數的成本', async () => {
    const device = newAuthenticator();
    const pending = await requestPasskey(app, users.p08, device);
    // 第一把由登記人背書；p08 已經有金鑰（前面的測試登記過）就由本人在舊裝置上核對
    const own = await oldKey(app, users.p08);
    const by = own ? { ...users.p08, key: own } : await registrar(app);
    const listed = await listedFor(by, pending.enrollment_id);
    const ch = await call(app, 'passkey_endorse_challenge', by.session, pending.enrollment_id, 'code');
    const challenge = await endorsementChallenge(app, by, pending.enrollment_id, ch, { method: 'code', onDevice: await shownOn(device) });
    const done = await call(app, 'passkey_endorse_passkey', ch.challenge_id, ...raw(by.key.assert(challenge)));
    assert.equal(done.status, 'approved');
    const event = await one(
        admin,
        `select convert_from(body, 'UTF8')::jsonb -> 'data' as data from sgn.audit_event where event_type = 'passkey.endorsed' order by seq desc limit 1`,
    );
    assert.equal(event.data.method, 'code');
    assert.equal(event.data.settings['passkey.enrollment_code_cost'], listed.code_cost);
});

test('K-PASSKEY-ENROLL 紅隊第三輪 高-2 R3、R4 回歸：已有金鑰的人，主管與登記人都不能背書（只能本人用舊金鑰），清單也不給他們', async () => {
    const extra = await requestPasskey(app, users.p02, newAuthenticator()); // 後端在 p02 登入時造出的登記
    const reg = await registrar(app);
    for (const by of [users.p03, reg]) {
        assert.equal(await listedFor(by, extra.enrollment_id), undefined);
        await rejectsWith(call(app, 'passkey_endorse_challenge', by.session, extra.enrollment_id, 'qr'), 'PASSKEY_SELF_ONLY');
    }
    assert.equal((await one(admin, `select http_status from sgn.error_catalog where code = 'PASSKEY_SELF_ONLY'`)).http_status, 403);
});

test('K-PASSKEY-ENROLL 每人 24 小時內沒被核准的登記有上限：超過就拒絕（限制線上嘗試的次數）', async () => {
    await setSetting(admin, 'passkey.enrollment_daily_max', 2);
    try {
        const pendingNow = (
            await one(admin, `select count(*)::int as n from sgn.passkey_enrollment where person_id = $1 and status = 'pending'`, [
                users.p26.personId,
            ])
        ).n;
        for (let i = pendingNow; i < 2; i++) await requestPasskey(app, users.p26, newAuthenticator());
        await rejectsWith(requestPasskey(app, users.p26, newAuthenticator()), 'PASSKEY_ENROLLMENT_LIMIT');
    } finally {
        await setSetting(admin, 'passkey.enrollment_daily_max', 5);
    }
});
