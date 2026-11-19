#!/usr/bin/env node
// 以真正的 authorization code flow（含 PKCE）對 sim/idp 走完一次登入，
// 驗證 ID token 的簽章與必要的 claims，並把 claims 以 JSON 輸出。
// 不依賴任何套件；由 login-check.sh 載入設定後呼叫。
//
// 結束代碼：0＝登入成功且驗證通過；2＝帳號或密碼被拒絕；1＝其他錯誤。

import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';

const EXIT_REJECTED = 2;
const MAX_REDIRECTS = 10;

class CheckError extends Error {
    constructor(message, exitCode = 1) {
        super(message);
        this.exitCode = exitCode;
    }
}

function requireEnv(name) {
    const value = process.env[name];
    if (!value) throw new CheckError(`缺少環境變數 ${name}`);
    return value;
}

function expect(condition, message) {
    if (!condition) throw new CheckError(message);
}

const base64url = (buffer) => Buffer.from(buffer).toString('base64url');
const sha256 = (text) => createHash('sha256').update(text).digest();

async function getJson(url, init) {
    const response = await fetch(url, init);
    const body = await response.text();
    expect(response.ok, `${url} 回應 ${response.status}：${body}`);
    return JSON.parse(body);
}

/** 不自動跟隨轉址，逐步走到「不是轉址」或「轉回 client 的 redirect URI」為止。 */
async function follow(url, init, redirectUri) {
    let current = url;
    let request = init;
    for (let hop = 0; hop < MAX_REDIRECTS; hop += 1) {
        const response = await fetch(current, { ...request, redirect: 'manual' });
        const location = response.headers.get('location');
        if (response.status < 300 || response.status >= 400 || !location) {
            return { url: current, response };
        }
        current = new URL(location, current).toString();
        if (current.startsWith(redirectUri)) return { url: current, callback: new URL(current) };
        request = undefined;
    }
    throw new CheckError(`轉址超過 ${MAX_REDIRECTS} 次`);
}

async function authorize(config, discovery, login, password) {
    const state = base64url(randomBytes(16));
    const nonce = base64url(randomBytes(16));
    const codeVerifier = base64url(randomBytes(32));
    const authUrl = new URL(discovery.authorization_endpoint);
    authUrl.search = new URLSearchParams({
        response_type: 'code',
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        scope: config.scopes,
        state,
        nonce,
        code_challenge: base64url(sha256(codeVerifier)),
        code_challenge_method: 'S256',
    }).toString();

    const loginPage = await follow(authUrl.toString(), undefined, config.redirectUri);
    expect(loginPage.response?.status === 200, `沒有走到登入頁：${loginPage.url}`);
    const html = await loginPage.response.text();
    const action = /<form[^>]*method="post"[^>]*action="([^"]+)"/.exec(html);
    expect(action, '登入頁沒有表單');
    const postUrl = new URL(action[1].replaceAll('&amp;', '&'), loginPage.url).toString();

    const submitted = await follow(
        postUrl,
        {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ login, password }).toString(),
        },
        config.redirectUri,
    );
    if (!submitted.callback) {
        // 帳密不對時，身分提供者會再顯示一次登入頁，而不是轉回 client。
        throw new CheckError(`登入被拒絕：${login}`, EXIT_REJECTED);
    }
    const params = submitted.callback.searchParams;
    expect(!params.get('error'), `授權端點回報錯誤：${params.get('error_description') ?? params.get('error')}`);
    expect(params.get('state') === state, 'state 不一致');
    expect(params.get('code'), '沒有拿到授權碼');
    return { code: params.get('code'), nonce, codeVerifier };
}

function exchangeCode(config, discovery, { code, codeVerifier }) {
    const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
    return getJson(discovery.token_endpoint, {
        method: 'POST',
        headers: {
            authorization: `Basic ${basic}`,
            'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: config.redirectUri,
            code_verifier: codeVerifier,
        }).toString(),
    });
}

/** 用身分提供者公開的金鑰驗證 ID token，回傳 claims。 */
async function verifyIdToken(config, discovery, tokens, nonce) {
    const [encodedHeader, encodedPayload, encodedSignature] = tokens.id_token.split('.');
    const header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'));
    const claims = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    expect(header.alg === 'RS256', `未預期的簽章演算法：${header.alg}`);

    const { keys } = await getJson(discovery.jwks_uri);
    const jwk = keys.find((key) => key.kid === header.kid);
    expect(jwk, `公開金鑰裡找不到 kid ${header.kid}`);
    const signatureValid = verify(
        'RSA-SHA256',
        Buffer.from(`${encodedHeader}.${encodedPayload}`),
        createPublicKey({ key: jwk, format: 'jwk' }),
        Buffer.from(encodedSignature, 'base64url'),
    );
    expect(signatureValid, 'ID token 簽章驗證失敗');

    const now = Math.floor(Date.now() / 1000);
    const audiences = [claims.aud].flat();
    expect(claims.iss === config.issuer, `iss 不符：${claims.iss}`);
    expect(audiences.includes(config.clientId), `aud 不含 ${config.clientId}`);
    expect(claims.exp > now, 'ID token 已過期');
    expect(claims.nonce === nonce, 'nonce 不一致');
    const digest = sha256(tokens.access_token);
    expect(
        claims.at_hash === base64url(digest.subarray(0, digest.length / 2)),
        'at_hash 與 access token 不符',
    );
    return claims;
}

async function main() {
    const [login, password] = process.argv.slice(2);
    if (!login || !password) throw new CheckError('用法：login-check.mjs <uid 或 email> <密碼>');
    const config = {
        issuer: requireEnv('SIM_IDP_ISSUER'),
        clientId: requireEnv('SIM_IDP_CLIENT_ID'),
        clientSecret: requireEnv('SIM_IDP_CLIENT_SECRET'),
        scopes: requireEnv('SIM_IDP_SCOPES'),
        redirectUri: requireEnv('SIM_IDP_CLIENT_REDIRECT_URIS').split(/\s+/)[0],
    };

    const discovery = await getJson(`${config.issuer}/.well-known/openid-configuration`);
    expect(discovery.issuer === config.issuer, `discovery 的 issuer 不符：${discovery.issuer}`);

    const grant = await authorize(config, discovery, login, password);
    const tokens = await exchangeCode(config, discovery, grant);
    const claims = await verifyIdToken(config, discovery, tokens, grant.nonce);
    const userinfo = await getJson(discovery.userinfo_endpoint, {
        headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(userinfo.sub === claims.sub, 'userinfo 的 sub 與 ID token 不一致');

    process.stdout.write(`${JSON.stringify({ login, signature: 'verified', claims, userinfo }, null, 2)}\n`);
}

main().catch((error) => {
    process.stderr.write(`login-check: ${error.message}\n`);
    process.exit(error instanceof CheckError ? error.exitCode : 1);
});
