import * as oidc from 'openid-client';
import type { OidcConfig } from '../../config.ts';
import type { LoginIdentity } from '../../contract/systemCalls.ts';
import type { OidcLoginStart, OidcPort } from '../oidc.ts';

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/**
 * 以 openid-client 實作。身分提供者的設定（discovery）在第一次登入時才去抓並快取，
 * 所以身分提供者暫時連不上不會讓後端起不來。
 */
export class OpenidClientOidc implements OidcPort {
  private readonly config: OidcConfig;
  private discovered: Promise<oidc.Configuration> | null = null;

  constructor(config: OidcConfig) {
    this.config = config;
  }

  private discover(): Promise<oidc.Configuration> {
    if (this.discovered === null) {
      const pending = oidc.discovery(
        new URL(this.config.issuer),
        this.config.clientId,
        this.config.clientSecret,
        undefined,
        // 預設只接受 https；接本機的模擬器時才放寬（正式環境在設定檢查就擋掉了）。
        this.config.allowInsecure ? { execute: [oidc.allowInsecureRequests] } : undefined,
      );
      // 失敗就不快取，下次再試。
      pending.catch(() => {
        if (this.discovered === pending) this.discovered = null;
      });
      this.discovered = pending;
    }
    return this.discovered;
  }

  async startLogin(): Promise<OidcLoginStart> {
    const cfg = await this.discover();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const url = oidc.buildAuthorizationUrl(cfg, {
      redirect_uri: this.config.redirectUri,
      scope: this.config.scope,
      state,
      nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: 'S256',
    });
    return { url: url.href, state, nonce, codeVerifier };
  }

  async finishLogin(
    callbackUrl: URL,
    expected: { state: string; nonce: string; codeVerifier: string },
  ): Promise<LoginIdentity> {
    const cfg = await this.discover();
    // 交換 code 時送出的 redirect_uri 必須和登入時的一模一樣，所以以設定值為準，只取回傳的查詢參數。
    const current = new URL(this.config.redirectUri);
    current.search = callbackUrl.search;
    const tokens = await oidc.authorizationCodeGrant(cfg, current, {
      expectedState: expected.state,
      expectedNonce: expected.nonce,
      pkceCodeVerifier: expected.codeVerifier,
      idTokenExpected: true,
    });
    const claims = tokens.claims();
    if (!claims) throw new Error('身分提供者沒有回傳 ID token');
    return {
      subject: claims.sub,
      email: str(claims.email),
      username: str(claims.preferred_username),
      name: str(claims.name),
    };
  }
}
