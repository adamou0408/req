// 真的瀏覽器（Chromium + CDP 虛擬驗證器）產生的 WebAuthn 憑證與 assertion，資料庫驗得過。
// 確認資料庫端的解析（SPKI、authenticatorData、clientDataJSON、DER 簽章）和真實瀏覽器的輸出相容，
// 不只和測試自己寫的軟體驗證器相容。
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import {
    closePools, config, createSubmittedCase, decidePasskey, idToken, issueChallenge, login, one, pool,
    registrationNonce,
} from './lib/harness.mjs';

const { chromium } = await import(`${execSync('npm root -g').toString().trim()}/playwright/index.mjs`);
const app = pool('APP');
const origin = new URL(config.db.SGN_RP_ORIGIN);
let server;
let browser;
let page;

before(async () => {
    server = createServer((_, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><title>probe</title>');
    });
    await new Promise((resolve) => server.listen(Number(origin.port), origin.hostname, resolve));
    browser = await chromium.launch();
    page = await browser.newPage();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true },
    });
    await page.goto(origin.toString());
});
after(async () => {
    await browser?.close();
    await new Promise((r) => server.close(r));
    await closePools();
});

test('PRB-PROOF (a) 真的瀏覽器：Chromium 登記通行金鑰、簽挑戰值，資料庫驗章後核准', async () => {
    const applicant = await login(app, 'p04');
    const manager = await login(app, 'p03');
    const created = await page.evaluate(async (rpId) => {
        const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
        const cred = await navigator.credentials.create({
            publicKey: {
                challenge: crypto.getRandomValues(new Uint8Array(32)),
                rp: { id: rpId, name: 'probe' },
                user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'p03', displayName: 'p03' },
                pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
                authenticatorSelection: { userVerification: 'required', residentKey: 'required' },
                attestation: 'none',
            },
        });
        return { id: b64(cred.rawId), spki: b64(cred.response.getPublicKey()) };
    }, config.db.SGN_RP_ID);

    const begin = await call(app, 'passkey_register_begin', manager.session);
    const token = await idToken('p03', registrationNonce(begin.challenge, Buffer.from(created.spki, 'base64url')));
    await app.query('select api.passkey_register($1, $2, $3, $4)', [begin.challenge_id, token, created.id, created.spki]);

    const caseId = await createSubmittedCase(app, applicant, { dataset: 'browser', rows: 1 });
    const ch = await issueChallenge(app, manager, caseId);
    const assertion = await page.evaluate(
        async ({ challenge, id, rpId }) => {
            const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
            const unb64 = (s) => Uint8Array.from(atob(s.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0));
            const got = await navigator.credentials.get({
                publicKey: { challenge: unb64(challenge), rpId, allowCredentials: [{ type: 'public-key', id: unb64(id) }], userVerification: 'required' },
            });
            return {
                credentialId: b64(got.rawId),
                authenticatorData: b64(got.response.authenticatorData),
                clientDataJSON: b64(got.response.clientDataJSON),
                signature: b64(got.response.signature),
            };
        },
        { challenge: ch.challenge, id: created.id, rpId: config.db.SGN_RP_ID },
    );
    assert.equal(await decidePasskey(app, ch.challenge_id, 'approve', assertion), 'approved');
});
