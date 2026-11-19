// SSO adapter：OIDC authorization code flow（含 PKCE）。只負責拿到原始 ID token；驗章與「是誰」由資料庫決定。
import { createHash, randomBytes } from 'node:crypto';

export type OidcSettings = {
    issuer: string;
    clientId: string;
    clientSecret: string;
    scopes: string;
    redirectUri: string;
};

type Discovery = { authorization_endpoint: string; token_endpoint: string };

const b64url = (buf: Buffer): string => buf.toString('base64url');

export class OidcClient {
    readonly #settings: OidcSettings;
    #discovery: Discovery | undefined;

    constructor(settings: OidcSettings) {
        this.#settings = settings;
    }

    async #endpoints(): Promise<Discovery> {
        if (!this.#discovery) {
            const response = await fetch(`${this.#settings.issuer}/.well-known/openid-configuration`);
            if (!response.ok) throw new Error(`OIDC discovery: HTTP ${response.status}`);
            this.#discovery = (await response.json()) as Discovery;
        }
        return this.#discovery;
    }

    /** 產生授權網址；回傳要留在伺服器端的 state 與 PKCE verifier。 */
    async authorize(nonce: string): Promise<{ url: string; state: string; verifier: string }> {
        const { authorization_endpoint } = await this.#endpoints();
        const state = b64url(randomBytes(16));
        const verifier = b64url(randomBytes(32));
        const url = new URL(authorization_endpoint);
        url.search = new URLSearchParams({
            response_type: 'code',
            client_id: this.#settings.clientId,
            redirect_uri: this.#settings.redirectUri,
            scope: this.#settings.scopes,
            state,
            nonce,
            code_challenge: b64url(createHash('sha256').update(verifier).digest()),
            code_challenge_method: 'S256',
        }).toString();
        return { url: url.toString(), state, verifier };
    }

    async exchange(code: string, verifier: string): Promise<string> {
        const { token_endpoint } = await this.#endpoints();
        const { clientId, clientSecret, redirectUri } = this.#settings;
        const response = await fetch(token_endpoint, {
            method: 'POST',
            headers: {
                authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
                'content-type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier }),
        });
        const tokens = (await response.json()) as { id_token?: string };
        if (!tokens.id_token) throw new Error(`OIDC token endpoint: HTTP ${response.status}`);
        return tokens.id_token;
    }
}
