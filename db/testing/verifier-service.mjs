#!/usr/bin/env node
// 架構 (c)：獨立的驗證服務。以 sgn_test_verifier 連線，只能執行 api_verified 的 function。
// 它驗 WebAuthn assertion（Node 的 OpenSSL），驗過才呼叫資料庫；資料庫仍檢查挑戰值、綁定、簽核人資格，
// 但「簽章是不是真的」改由這個服務保證。信任從資料庫移到「這個服務的程式碼、主機與 sgn_test_verifier 的密碼」。
import { createHash, createPublicKey, verify } from 'node:crypto';
import { createServer } from 'node:http';
import pg from 'pg';
import { loadConfig, roleUrl } from './lib/env.mjs';

const sha256 = (data) => createHash('sha256').update(data).digest();

class Rejected extends Error {}

function p256PublicKey(uncompressed) {
    return createPublicKey({
        key: { kty: 'EC', crv: 'P-256', x: uncompressed.subarray(1, 33).toString('base64url'), y: uncompressed.subarray(33, 65).toString('base64url') },
        format: 'jwk',
    });
}

async function verifyAssertion(db, settings, body) {
    const { rows: [challenge] } = await db.query('select * from api_verified.challenge_get($1)', [body.challenge_id]);
    if (!challenge?.challenge) throw new Rejected('CHALLENGE_UNKNOWN');
    const { rows: [cred] } = await db.query('select * from api_verified.passkey_get($1)', [body.credential_id]);
    if (!cred?.public_key) throw new Rejected('PASSKEY_UNKNOWN');
    const authData = Buffer.from(body.authenticator_data, 'base64url');
    const clientRaw = Buffer.from(body.client_data_json, 'base64url');
    const client = JSON.parse(clientRaw.toString('utf8'));
    if (
        client.type !== 'webauthn.get' ||
        client.challenge !== challenge.challenge ||
        client.origin !== settings.origin ||
        authData.length < 37 ||
        !authData.subarray(0, 32).equals(sha256(settings.rpId)) ||
        (authData[32] & 0x05) !== 0x05
    ) {
        throw new Rejected('PASSKEY_INVALID');
    }
    const ok = verify(
        'sha256',
        Buffer.concat([authData, sha256(clientRaw)]),
        p256PublicKey(Buffer.from(cred.public_key, 'base64')),
        Buffer.from(body.signature, 'base64url'),
    );
    if (!ok) throw new Rejected('PASSKEY_INVALID');
    return authData.readUInt32BE(33);
}

export function startVerifierService({ port, config = loadConfig() } = {}) {
    const db = new pg.Pool({ connectionString: roleUrl(config, 'TEST_VERIFIER'), max: 10 });
    const settings = { origin: config.db.SGN_RP_ORIGIN, rpId: config.db.SGN_RP_ID };
    const server = createServer(async (req, res) => {
        const reply = (status, payload) => {
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(payload));
        };
        if (req.method !== 'POST' || req.url !== '/decide') return reply(404, { error: 'NOT_FOUND' });
        try {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const signCount = await verifyAssertion(db, settings, body);
            const { rows: [row] } = await db.query(
                'select api_verified.case_decide_passkey($1, $2, $3, $4, $5) as state',
                [body.challenge_id, body.decision, body.credential_id, signCount, JSON.stringify(body)],
            );
            return reply(200, { state: row.state });
        } catch (err) {
            const code = err instanceof Rejected ? err.message : String(err.message).split(':')[0];
            return reply(422, { error: code });
        }
    });
    return new Promise((resolve) => {
        server.listen(port ?? Number(config.db.SGN_TEST_VERIFIER_PORT), '127.0.0.1', () =>
            resolve({
                url: `http://127.0.0.1:${server.address().port}`,
                close: async () => {
                    await new Promise((r) => server.close(r));
                    await db.end();
                },
            }),
        );
    });
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const service = await startVerifierService();
    console.log(`verifier service listening on ${service.url}`);
}
