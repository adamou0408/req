// 身分提供者的金鑰更新程序（裁決 D81 (5)；紅隊第四輪 中-5，redteam/exploits/26-idp-key-rotation-lockout.mjs）。
// 專用帳號 sgn_idp_keys（db/tools/idp-keys.mjs）把身分提供者公布的 JWKS 交給 api_idp.idp_keys_sync。
// 「拿掉防法就失敗」：同步之前，新金鑰簽的 token 一律 TOKEN_INVALID（就是紅隊看到的全公司登不進來）。
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { after, test } from 'node:test';
import { call, closePools, config, idToken, LOGIN_SOURCE, one, pool, rejectsPermission, rejectsWith } from './lib/harness.mjs';

const app = pool('APP');
const admin = pool('ADMIN');
const keys = pool('IDP_KEYS');
after(closePools);

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const issuer = config.idp.SIM_IDP_ISSUER;
const published = async () => (await fetch(`${issuer}/keys`)).json();
const sync = async (jwks, iss = issuer) => (await one(keys, 'select api_idp.idp_keys_sync($1, $2) as r', [iss, jwks])).r;

// 身分提供者輪替出來的新金鑰（測試自己產生，模擬 Dex 換金鑰）
const rotated = generateKeyPairSync('rsa', { modulusLength: 2048 });
const kid = `rotated-${randomUUID().slice(0, 8)}`;
const jwk = { ...rotated.publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };

/** 開一次登入：Dex 簽的 token 換成新金鑰簽（內容相同、kid 換成新的），交給資料庫。 */
async function loginWithRotatedKey(uid) {
    const begin = await call(app, 'session_begin', LOGIN_SOURCE);
    const [, payload] = (await idToken(uid, begin.nonce)).split('.');
    const input = `${b64({ alg: 'RS256', kid, typ: 'JWT' })}.${payload}`;
    const token = `${input}.${sign('sha256', Buffer.from(input), rotated.privateKey).toString('base64url')}`;
    return call(app, 'session_open', begin.challenge_id, token);
}

const exceptions = async (code, k) =>
    (await admin.query(`select id from sgn.exception_record where rule_code = $1 and detail ->> 'kid' = $2`, [code, k])).rowCount;

test('K-IDP-KEY-NEW 身分提供者換了金鑰：同步之前新金鑰簽的 token 被拒（全公司登不進來）；同步之後立即可登入，不設冷卻，進鏈、開例外並通知治理角色', async () => {
    await rejectsWith(loginWithRotatedKey('p04'), 'TOKEN_INVALID');
    const jwks = await published();
    await sync(jwks);
    assert.deepEqual((await sync(jwks)).registered, [], '登記過的金鑰不重複登記');
    const r = await sync({ keys: [...jwks.keys, jwk] });
    assert.deepEqual(r.registered, [kid]);
    const opened = await loginWithRotatedKey('p04');
    assert.ok(opened.session_token, '新金鑰立即可用');
    assert.equal(await exceptions('K-IDP-KEY-NEW', kid), 1);
    const chain = await admin.query(`select 1 from sgn.audit_event where event_type = 'identity.idp_keys_synced'`);
    assert.ok(chain.rowCount >= 1, '進鏈');
    const notified = await admin.query(
        `select o.person_id from sgn.notification_outbox as o where o.event_code = 'identity.idp_key_changed' and o.payload ->> 'kid' = $1`,
        [kid],
    );
    assert.ok(notified.rowCount >= 1, '通知治理角色');
    assert.deepEqual((await sync({ keys: [...jwks.keys, jwk] })).registered, [], '同一把不重複登記');
    assert.equal(await exceptions('K-IDP-KEY-NEW', kid), 1);
});

test('K-IDP-KEY-UNTRUSTED 公布了平台不能信任的金鑰（不是 RS256、不是 RSA）：不信任、開例外並通知（每把一次）；不再公布的金鑰退役，之後用它簽的 token 被拒', async () => {
    const jwks = await published();
    const ec = {
        ...generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' }),
        kid: `ec-${randomUUID().slice(0, 8)}`,
    };
    const hs = { kty: 'RSA', kid: `hs-${randomUUID().slice(0, 8)}`, alg: 'HS256', n: jwk.n, e: jwk.e };
    const r = await sync({ keys: [...jwks.keys, jwk, ec, hs] });
    assert.deepEqual(r.registered, []);
    assert.deepEqual(r.rejected.sort(), [ec.kid, hs.kid].sort());
    assert.equal(await exceptions('K-IDP-KEY-UNTRUSTED', ec.kid), 1);
    assert.equal((await one(admin, 'select count(*)::int as n from sgn.idp_key where kid = any($1)', [[ec.kid, hs.kid]])).n, 0);
    await sync({ keys: [...jwks.keys, jwk, ec, hs] });
    assert.equal(await exceptions('K-IDP-KEY-UNTRUSTED', ec.kid), 1, '每把只開一次');
    // 身分提供者不再公布輪替出來的那把：退役
    const retired = await sync(jwks);
    assert.deepEqual(retired.retired, [kid]);
    await rejectsWith(loginWithRotatedKey('p04'), 'TOKEN_INVALID');
    // 身分提供者目前的金鑰仍可登入
    const begin = await call(app, 'session_begin', LOGIN_SOURCE);
    assert.ok((await call(app, 'session_open', begin.challenge_id, await idToken('p04', begin.nonce))).session_token);
});

test('K-IDP-KEY-NEW 只收平台設定的身分提供者；只有專用帳號能更新，後端不行，專用帳號也碰不到別的入口', async () => {
    await rejectsWith(sync(await published(), 'https://evil.example/dex'), 'IDP_ISSUER_MISMATCH');
    await rejectsWith(sync({ nope: true }), 'IDP_JWKS_INVALID');
    await rejectsPermission(app.query('select api_idp.idp_keys_sync($1, $2)', [issuer, { keys: [] }]));
    await rejectsPermission(keys.query(`select api_job.chain_head()`));
    await rejectsPermission(keys.query('select kid from sgn.idp_key'));
});
