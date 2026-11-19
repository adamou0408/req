// 純 PL/pgSQL 的 ES256、RS256 驗章：和 OpenSSL（Node crypto）交叉比對，含竄改、錯鑰、邊界值。
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { after, test } from 'node:test';
import { closePools, one, pool } from './lib/harness.mjs';

const admin = pool('ADMIN');
after(closePools);

const P256_N = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');

function derToRs(der) {
    const rLen = der[3];
    const r = BigInt(`0x${der.subarray(4, 4 + rLen).toString('hex')}`);
    const s = BigInt(`0x${der.subarray(6 + rLen).toString('hex')}`);
    return { r, s };
}
function intToDer(value) {
    let hex = value.toString(16);
    if (hex.length % 2) hex = `0${hex}`;
    let buf = Buffer.from(hex, 'hex');
    if (buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0]), buf]);
    return Buffer.concat([Buffer.from([2, buf.length]), buf]);
}
function rsToDer(r, s) {
    const body = Buffer.concat([intToDer(r), intToDer(s)]);
    return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}
function ecKey() {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
    return { privateKey, point };
}
const es256 = async (msg, sig, point) =>
    (await one(admin, 'select sgn_internal.es256_verify($1, $2, $3) as ok', [msg, sig, point])).ok;

test('ES256：50 組隨機金鑰與訊息，OpenSSL 簽的都驗得過，改任何一處都驗不過', async () => {
    for (let i = 0; i < 50; i += 1) {
        const key = ecKey();
        const other = ecKey();
        const msg = randomBytes(1 + (i % 200));
        const sig = sign('sha256', msg, key.privateKey);
        assert.equal(await es256(msg, sig, key.point), true, `vector ${i}`);
        const badMsg = Buffer.from(msg);
        badMsg[0] ^= 1;
        assert.equal(await es256(badMsg, sig, key.point), false);
        const badSig = Buffer.from(sig);
        badSig[badSig.length - 1] ^= 1;
        assert.equal(await es256(msg, badSig, key.point), false);
        assert.equal(await es256(msg, sig, other.point), false);
    }
});

test('ES256：邊界值（r=0、s=n、曲線外的公鑰、壞掉的 DER）一律不通過；s 與 n-s 都是合法的 ECDSA', async () => {
    const key = ecKey();
    const msg = Buffer.from('boundary');
    const { r, s } = derToRs(sign('sha256', msg, key.privateKey));
    assert.equal(await es256(msg, rsToDer(r, P256_N - s), key.point), true);
    assert.equal(await es256(msg, rsToDer(0n, s), key.point), false);
    assert.equal(await es256(msg, rsToDer(r, P256_N), key.point), false);
    const offCurve = Buffer.from(key.point);
    offCurve[64] ^= 1;
    assert.equal(await es256(msg, rsToDer(r, s), offCurve), false);
    assert.equal(await es256(msg, Buffer.from('3000', 'hex'), key.point), false);
    assert.equal(await es256(msg, Buffer.concat([rsToDer(r, s), Buffer.from([0])]), key.point), false);
});

test('RS256：10 組 2048 位元、5 組 3072 位元金鑰，驗得過正確的、驗不過竄改的', async () => {
    for (const bits of [...Array(10).fill(2048), ...Array(5).fill(3072)]) {
        const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: bits });
        const jwk = publicKey.export({ format: 'jwk' });
        const n = Buffer.from(jwk.n, 'base64url');
        const e = Buffer.from(jwk.e, 'base64url');
        const msg = randomBytes(100);
        const sig = sign('sha256', msg, privateKey);
        const verify = async (m, s) => (await one(admin, 'select sgn_internal.rs256_verify($1, $2, $3, $4) as ok', [m, s, n, e])).ok;
        assert.equal(await verify(msg, sig), true);
        const badSig = Buffer.from(sig);
        badSig[10] ^= 1;
        assert.equal(await verify(msg, badSig), false);
        assert.equal(await verify(Buffer.concat([msg, Buffer.from([0])]), sig), false);
        assert.equal(await verify(msg, sig.subarray(1)), false);
    }
});

test('RS256：拒絕小於 2048 位元的金鑰', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
    const jwk = publicKey.export({ format: 'jwk' });
    const msg = Buffer.from('short key');
    const row = await one(admin, 'select sgn_internal.rs256_verify($1, $2, $3, $4) as ok', [
        msg,
        sign('sha256', msg, privateKey),
        Buffer.from(jwk.n, 'base64url'),
        Buffer.from(jwk.e, 'base64url'),
    ]);
    assert.equal(row.ok, false);
});
