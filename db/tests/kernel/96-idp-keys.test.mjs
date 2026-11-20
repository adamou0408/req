// 身分提供者的金鑰更新程序（裁決 D81 (5)；紅隊第四輪 中-5，redteam/exploits/26-idp-key-rotation-lockout.mjs）。
// 專用帳號 sgn_idp_keys（db/tools/idp-keys.mjs）把身分提供者公布的 JWKS 交給 api_idp.idp_keys_sync。
// 「拿掉防法就失敗」：同步之前，新金鑰簽的 token 一律 TOKEN_INVALID（就是紅隊看到的全公司登不進來）。
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { after, test } from 'node:test';
import { call, closePools, config, idToken, LOGIN_SOURCE, one, pool, rejectsPermission, rejectsWith, setSetting } from './lib/harness.mjs';

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

/** 模擬冷卻期已過（資料庫擁有者，測試用）：把「開始沒公布」的時間往前推到冷卻期之前。 */
const coolDown = (k) =>
    admin.query(
        `update sgn.idp_key set missing_since = clock_timestamp() - make_interval(secs => sgn_internal.setting_int('identity.idp_key_retire_cooldown_seconds') + 1) where kid = $1`,
        [k],
    );

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
    // 身分提供者不再公布輪替出來的那把：先開例外、冷卻期滿才退役（K-IDP-KEY-RETIRE，裁決 D84 (3)；原本這裡立即退役）
    const missing = await sync(jwks);
    assert.deepEqual([missing.missing, missing.retired], [[kid], []]);
    assert.ok((await loginWithRotatedKey('p04')).session_token, '冷卻期間仍可用');
    await coolDown(kid);
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

// ── 紅隊第五輪 高-2（裁決 D84 (3)；redteam/exploits/34）──

const loginReal = async (uid) => {
    const begin = await call(app, 'session_begin', LOGIN_SOURCE);
    return call(app, 'session_open', begin.challenge_id, await idToken(uid, begin.nonce));
};

test('K-IDP-KEY-RETIRE 交一份空的（或少了真金鑰的）JWKS：不立即退役、開例外並通知，登入照常；誠實的同步交回真的就取消；冷卻期滿也不得退役到零把', async () => {
    const jwks = await published();
    await sync(jwks);
    const realKid = jwks.keys[0].kid;
    const empty = await sync({ keys: [] });
    assert.ok(empty.missing.includes(realKid));
    assert.deepEqual(empty.retired, []);
    assert.ok((await loginReal('p04')).session_token, '交了空的 JWKS 之後登入照常');
    const ex = await admin.query(`select detail from sgn.exception_record where rule_code = 'K-IDP-KEY-RETIRE' and detail ->> 'kid' = $1`, [
        realKid,
    ]);
    assert.ok(ex.rowCount >= 1, '開例外');
    assert.ok(ex.rows.at(-1).detail.settings['identity.idp_key_retire_cooldown_seconds'] > 0, '寫明冷卻期');
    const notified = await admin.query(
        `select 1 from sgn.notification_outbox where event_code = 'identity.idp_key_changed' and payload ->> 'kid' = $1`,
        [realKid],
    );
    assert.ok(notified.rowCount >= 1, '通知治理角色');
    // 誠實的同步程式下一輪交回真的：取消冷卻
    await sync(jwks);
    assert.equal((await one(admin, 'select missing_since from sgn.idp_key where kid = $1', [realKid])).missing_since, null);
    // 冷卻期滿、身分提供者「什麼都沒公布」：退役之後就沒有可用的金鑰 → 不退役（拿掉防法就全公司登不進來）
    await sync({ keys: [] });
    await coolDown(realKid);
    const none = await sync({ keys: [] });
    assert.deepEqual(none.retired, []);
    assert.ok((await loginReal('p04')).session_token);
    assert.ok(
        (
            await admin.query(
                `select 1 from sgn.exception_record where rule_code = 'K-IDP-KEY-RETIRE' and detail ->> 'kind' = 'would_leave_none'`,
            )
        ).rowCount >= 1,
    );
    await sync(jwks);
});

test('K-IDP-KEY-NEW 退役過的金鑰再次公布（公開金鑰相同）：經同一個程序恢復（進鏈、開例外、通知），之後又能登入；同一個 kid 換了公開金鑰不信任', async () => {
    const jwks = await published();
    const rotatedAgain = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const k2 = `rotated-${randomUUID().slice(0, 8)}`;
    const j2 = { ...rotatedAgain.publicKey.export({ format: 'jwk' }), kid: k2, alg: 'RS256', use: 'sig' };
    await setSetting(admin, 'identity.idp_key_new_max', 100, 'global');
    try {
        assert.deepEqual((await sync({ keys: [...jwks.keys, j2] })).registered, [k2]);
        await sync(jwks);
        await coolDown(k2);
        assert.deepEqual((await sync(jwks)).retired, [k2]);
        const back = await sync({ keys: [...jwks.keys, j2] });
        assert.deepEqual(back.restored, [k2], '退役過的再出現可以恢復（原本永遠 TOKEN_INVALID）');
        assert.equal((await one(admin, 'select retired_at from sgn.idp_key where kid = $1', [k2])).retired_at, null);
        assert.ok(
            (
                await admin.query(
                    `select 1 from sgn.exception_record where rule_code = 'K-IDP-KEY-NEW' and detail ->> 'kid' = $1 and detail ->> 'kind' = 'restored'`,
                    [k2],
                )
            ).rowCount === 1,
        );
        // 同一個 kid、別的公開金鑰：不信任
        const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'jwk' });
        const swapped = await sync({ keys: [...jwks.keys, { ...other, kid: k2, alg: 'RS256', use: 'sig' }] });
        assert.deepEqual(swapped.rejected, [k2]);
        assert.ok(
            (await admin.query(`select 1 from sgn.idp_key where kid = $1 and n = $2`, [k2, Buffer.from(j2.n, 'base64url')])).rowCount === 1,
            '信任的公開金鑰沒被換掉',
        );
    } finally {
        await setSetting(admin, 'identity.idp_key_new_max', 2, 'global');
        await sync(jwks);
    }
});

test('K-IDP-KEY-LIMIT 單一時間窗內新增的金鑰有上限：超過的不信任、開例外並通知；用它簽的 token 被拒', async () => {
    const jwks = await published();
    const recent = (
        await one(
            admin,
            `select count(*)::int as n from sgn.idp_key_trust where trusted_at > clock_timestamp() - make_interval(secs => sgn_internal.setting_int('identity.idp_key_new_window_seconds'))`,
        )
    ).n;
    await setSetting(admin, 'identity.idp_key_new_max', recent + 1, 'global');
    try {
        const make = () => {
            const k = generateKeyPairSync('rsa', { modulusLength: 2048 });
            return { ...k.publicKey.export({ format: 'jwk' }), kid: `flood-${randomUUID().slice(0, 8)}`, alg: 'RS256', use: 'sig' };
        };
        const [a, b] = [make(), make()];
        const r = await sync({ keys: [...jwks.keys, a, b] });
        assert.deepEqual(r.registered, [a.kid]);
        assert.deepEqual(r.limited, [b.kid]);
        assert.equal((await one(admin, 'select count(*)::int as n from sgn.idp_key where kid = $1', [b.kid])).n, 0, '沒有信任');
        assert.equal(await exceptions('K-IDP-KEY-LIMIT', b.kid), 1);
        await sync({ keys: [...jwks.keys, a, b] });
        assert.equal(await exceptions('K-IDP-KEY-LIMIT', b.kid), 1, '同一把在時間窗內只開一次');
    } finally {
        await setSetting(admin, 'identity.idp_key_new_max', 2, 'global');
        await sync(jwks);
    }
});
