// 測試端扮演「瀏覽器 + 後端」：對 sim 的 Dex 走真正的 authorization code flow（含 PKCE），
// 把資料庫給的 nonce 放進授權請求，拿回原始 ID token。這裡不驗 token，驗章是資料庫的事。
import { createHash, randomBytes } from 'node:crypto';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

async function follow(url, init, redirectUri) {
    let current = url;
    let request = init;
    for (let hop = 0; hop < 10; hop += 1) {
        const response = await fetch(current, { ...request, redirect: 'manual' });
        const location = response.headers.get('location');
        if (response.status < 300 || response.status >= 400 || !location) return { url: current, response };
        current = new URL(location, current).toString();
        if (current.startsWith(redirectUri)) return { url: current, callback: new URL(current) };
        request = undefined;
    }
    throw new Error('too many redirects');
}

let discoveryCache;

export async function dexIdToken(config, login, nonce, password = config.ldap.SIM_LDAP_USER_PASSWORD) {
    const { idp } = config;
    discoveryCache ??= await (await fetch(`${idp.SIM_IDP_ISSUER}/.well-known/openid-configuration`)).json();
    const redirectUri = idp.SIM_IDP_CLIENT_REDIRECT_URIS.split(' ')[0];
    const state = b64url(randomBytes(16));
    const verifier = b64url(randomBytes(32));
    const authUrl = new URL(discoveryCache.authorization_endpoint);
    authUrl.search = new URLSearchParams({
        response_type: 'code',
        client_id: idp.SIM_IDP_CLIENT_ID,
        redirect_uri: redirectUri,
        scope: idp.SIM_IDP_SCOPES,
        state,
        nonce,
        code_challenge: b64url(createHash('sha256').update(verifier).digest()),
        code_challenge_method: 'S256',
    }).toString();
    const page = await follow(authUrl.toString(), undefined, redirectUri);
    const html = await page.response.text();
    const action = /<form[^>]*method="post"[^>]*action="([^"]+)"/.exec(html);
    if (!action) throw new Error('no login form');
    const submitted = await follow(
        new URL(action[1].replaceAll('&amp;', '&'), page.url).toString(),
        {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ login, password }).toString(),
        },
        redirectUri,
    );
    if (!submitted.callback) throw new Error(`login rejected: ${login}`);
    const code = submitted.callback.searchParams.get('code');
    const basic = Buffer.from(`${idp.SIM_IDP_CLIENT_ID}:${idp.SIM_IDP_CLIENT_SECRET}`).toString('base64');
    const tokenResponse = await fetch(discoveryCache.token_endpoint, {
        method: 'POST',
        headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
            code_verifier: verifier,
        }).toString(),
    });
    const tokens = await tokenResponse.json();
    if (!tokens.id_token) throw new Error(`token endpoint: ${JSON.stringify(tokens)}`);
    return tokens.id_token;
}
