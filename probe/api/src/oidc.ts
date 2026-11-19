// OIDC authorization code flow（PKCE S256、state、nonce），並以 IdP 公布的 JWKS 驗 ID token 簽章。
// 只依賴 node:crypto 與 fetch。
import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify, type JsonWebKey } from 'node:crypto';
import type { OidcConfig } from './config.ts';

export interface Discovery {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    jwks_uri: string;
}

/** 開始登入時產生、要在 callback 時比對的值。只存在伺服器端。 */
export interface PendingLogin {
    state: string;
    nonce: string;
    codeVerifier: string;
    createdAt: number;
}

export interface IdTokenClaims {
    iss: string;
    sub: string;
    aud: string | string[];
    exp: number;
    iat: number;
    nonce?: string;
    at_hash?: string;
    email?: string;
    name?: string;
    preferred_username?: string;
    groups?: string[];
    federated_claims?: { connector_id: string; user_id: string };
}

export class OidcError extends Error {}

const b64url = (data: Buffer): string => data.toString('base64url');
const sha256 = (data: string | Buffer): Buffer => createHash('sha256').update(data).digest();
const MAX_CLOCK_SKEW_SECONDS = 60;

function check(condition: unknown, message: string): asserts condition {
    if (!condition) throw new OidcError(message);
}

function sameText(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, init);
    const body = await response.text();
    check(response.ok, `${url} 回應 ${response.status}：${body}`);
    return JSON.parse(body) as T;
}

export class OidcClient {
    private discovery?: Discovery;
    private keys = new Map<string, JsonWebKey>();
    private readonly config: OidcConfig;

    constructor(config: OidcConfig) {
        this.config = config;
    }

    private async discover(): Promise<Discovery> {
        if (!this.discovery) {
            const found = await getJson<Discovery>(`${this.config.issuer}/.well-known/openid-configuration`);
            check(found.issuer === this.config.issuer, `discovery 的 issuer 不符：${found.issuer}`);
            this.discovery = found;
        }
        return this.discovery;
    }

    /** 產生授權端點網址與要保留在伺服器端的 state、nonce、code verifier。 */
    async beginLogin(): Promise<{ url: string; pending: PendingLogin }> {
        const discovery = await this.discover();
        const pending: PendingLogin = {
            state: b64url(randomBytes(16)),
            nonce: b64url(randomBytes(16)),
            codeVerifier: b64url(randomBytes(32)),
            createdAt: Date.now(),
        };
        const url = new URL(discovery.authorization_endpoint);
        url.search = new URLSearchParams({
            response_type: 'code',
            client_id: this.config.clientId,
            redirect_uri: this.config.redirectUri,
            scope: this.config.scopes,
            state: pending.state,
            nonce: pending.nonce,
            code_challenge: b64url(sha256(pending.codeVerifier)),
            code_challenge_method: 'S256',
        }).toString();
        return { url: url.toString(), pending };
    }

    /** callback：比對 state、用授權碼換 token、驗 ID token。回傳驗過的 claims 與原始 ID token。 */
    async finishLogin(query: URLSearchParams, pending: PendingLogin): Promise<{ claims: IdTokenClaims; idToken: string }> {
        check(!query.get('error'), `IdP 回報錯誤：${query.get('error_description') ?? query.get('error')}`);
        check(sameText(query.get('state') ?? '', pending.state), 'state 不一致');
        const code = query.get('code');
        check(code, '沒有授權碼');
        const discovery = await this.discover();
        const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64');
        const tokens = await getJson<{ id_token: string; access_token: string }>(discovery.token_endpoint, {
            method: 'POST',
            headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                code,
                redirect_uri: this.config.redirectUri,
                code_verifier: pending.codeVerifier,
            }).toString(),
        });
        const claims = await this.verifyIdToken(tokens.id_token, pending.nonce, tokens.access_token);
        return { claims, idToken: tokens.id_token };
    }

    private async signingKey(kid: string): Promise<JsonWebKey> {
        if (!this.keys.has(kid)) {
            // 金鑰會輪替：遇到沒見過的 kid 就重抓一次 JWKS。
            const { keys } = await getJson<{ keys: (JsonWebKey & { kid: string })[] }>((await this.discover()).jwks_uri);
            this.keys = new Map(keys.map((key) => [key.kid, key]));
        }
        const key = this.keys.get(kid);
        check(key, `JWKS 裡沒有 kid ${kid}`);
        return key;
    }

    async verifyIdToken(idToken: string, nonce: string, accessToken?: string): Promise<IdTokenClaims> {
        const parts = idToken.split('.');
        check(parts.length === 3, 'ID token 格式不對');
        const [encodedHeader, encodedPayload, encodedSignature] = parts;
        const header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8')) as { alg: string; kid: string };
        // 只接受 RS256：擋掉 alg=none 與拿公鑰當 HMAC 金鑰的攻擊。
        check(header.alg === 'RS256', `不接受的簽章演算法：${header.alg}`);
        const key = await this.signingKey(header.kid);
        const valid = verify(
            'RSA-SHA256',
            Buffer.from(`${encodedHeader}.${encodedPayload}`),
            createPublicKey({ key, format: 'jwk' }),
            Buffer.from(encodedSignature, 'base64url'),
        );
        check(valid, 'ID token 簽章驗證失敗');
        const claims = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as IdTokenClaims;
        const now = Math.floor(Date.now() / 1000);
        check(claims.iss === this.config.issuer, `iss 不符：${claims.iss}`);
        check([claims.aud].flat().includes(this.config.clientId), 'aud 不含本 client');
        check(claims.exp > now - MAX_CLOCK_SKEW_SECONDS, 'ID token 已過期');
        check(claims.iat < now + MAX_CLOCK_SKEW_SECONDS, 'ID token 的 iat 在未來');
        check(sameText(claims.nonce ?? '', nonce), 'nonce 不一致');
        if (accessToken && claims.at_hash) {
            const digest = sha256(accessToken);
            check(claims.at_hash === b64url(digest.subarray(0, digest.length / 2)), 'at_hash 與 access token 不符');
        }
        return claims;
    }
}
