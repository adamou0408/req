/**
 * OpenidClientOidc 對一個假的身分提供者（本機 HTTP）走完整的 authorization code + PKCE 流程。
 * 假的身分提供者只做最少的事：discovery、JWKS、token endpoint（簽 RS256 的 ID token）。
 */
import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { OpenidClientOidc } from '../src/ports/adapters/oidcOpenidClient.ts';
import { baseEnv, cookieFrom, makeApp } from './helpers.ts';

const b64 = (v: Buffer | string): string => Buffer.from(v).toString('base64url');

interface Grant {
  challenge: string;
  nonce: string;
  redirectUri: string;
  user: { sub: string; email: string; name: string; preferred_username: string };
}

class FakeIdp {
  readonly keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  readonly grants = new Map<string, Grant>();
  server!: Server;
  issuer = '';
  /** 測試可以動手腳：改掉 ID token 裡的欄位。 */
  tamper: (claims: Record<string, unknown>) => void = () => {};
  tokenRequests = 0;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', this.issuer);
      const json = (status: number, body: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      };
      if (url.pathname === '/.well-known/openid-configuration') {
        return json(200, {
          issuer: this.issuer,
          authorization_endpoint: `${this.issuer}/authorize`,
          token_endpoint: `${this.issuer}/token`,
          jwks_uri: `${this.issuer}/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
        });
      }
      if (url.pathname === '/jwks') {
        return json(200, { keys: [{ ...this.keys.publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' }] });
      }
      if (url.pathname === '/token' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          this.tokenRequests += 1;
          const form = new URLSearchParams(body);
          const basic = req.headers.authorization?.startsWith('Basic ')
            ? Buffer.from(req.headers.authorization.slice(6), 'base64').toString().split(':')
            : [];
          const clientId = form.get('client_id') ?? decodeURIComponent(basic[0] ?? '');
          const clientSecret = form.get('client_secret') ?? decodeURIComponent(basic[1] ?? '');
          const grant = this.grants.get(form.get('code') ?? '');
          if (clientId !== 'das' || clientSecret !== 'idp-secret') return json(401, { error: 'invalid_client' });
          if (!grant || form.get('redirect_uri') !== grant.redirectUri) return json(400, { error: 'invalid_grant' });
          const challenge = b64(createHash('sha256').update(form.get('code_verifier') ?? '').digest());
          if (challenge !== grant.challenge) return json(400, { error: 'invalid_grant' });
          this.grants.delete(form.get('code') ?? '');
          const now = Math.floor(Date.now() / 1000);
          const claims: Record<string, unknown> = {
            iss: this.issuer,
            aud: 'das',
            iat: now,
            exp: now + 300,
            nonce: grant.nonce,
            ...grant.user,
          };
          this.tamper(claims);
          const signingInput = `${b64(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'k1' }))}.${b64(JSON.stringify(claims))}`;
          const signature = createSign('RSA-SHA256').update(signingInput).sign(this.keys.privateKey);
          return json(200, { access_token: 'at', token_type: 'Bearer', expires_in: 300, id_token: `${signingInput}.${b64(signature)}` });
        });
        return;
      }
      json(404, { error: 'not_found' });
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.issuer = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  /** 模擬使用者在身分提供者那邊登入成功：回傳要導回本站的查詢字串。 */
  authorize(authorizationUrl: string, user: Grant['user']): string {
    const url = new URL(authorizationUrl);
    expect(url.origin + url.pathname).toBe(`${this.issuer}/authorize`);
    expect(url.searchParams.get('client_id')).toBe('das');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const code = randomBytes(8).toString('hex');
    this.grants.set(code, {
      challenge: url.searchParams.get('code_challenge') ?? '',
      nonce: url.searchParams.get('nonce') ?? '',
      redirectUri: url.searchParams.get('redirect_uri') ?? '',
      user,
    });
    return `?code=${code}&state=${encodeURIComponent(url.searchParams.get('state') ?? '')}`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

describe('OIDC adapter（openid-client）', () => {
  const idp = new FakeIdp();
  const u1 = { sub: 'idp-sub-1', email: 'u1@example.test', name: '王小明', preferred_username: 'u1' };
  let oidcEnv: Record<string, string>;

  beforeAll(async () => {
    await idp.start();
    oidcEnv = {
      AUTH_MODE: 'oidc',
      OIDC_ISSUER: idp.issuer,
      OIDC_CLIENT_ID: 'das',
      OIDC_CLIENT_SECRET: 'idp-secret',
      OIDC_REDIRECT_URI: 'http://localhost:3999/api/auth/oidc/callback',
    };
  });
  afterAll(() => idp.stop());

  const adapter = (): OpenidClientOidc => {
    const config = loadConfig(baseEnv(oidcEnv));
    if (!config.oidc) throw new Error('OIDC 設定應該是齊全的');
    return new OpenidClientOidc(config.oidc);
  };

  it('startLogin 產生帶 state、nonce、PKCE 的授權網址；finishLogin 換回身分', async () => {
    const oidc = adapter();
    const start = await oidc.startLogin();
    const url = new URL(start.url);
    expect(url.searchParams.get('state')).toBe(start.state);
    expect(url.searchParams.get('nonce')).toBe(start.nonce);
    expect(url.searchParams.get('scope')).toBe('openid profile email');
    expect(url.searchParams.get('redirect_uri')).toBe(oidcEnv.OIDC_REDIRECT_URI);
    expect(url.searchParams.get('code_challenge')).toBe(b64(createHash('sha256').update(start.codeVerifier).digest()));

    const search = idp.authorize(start.url, u1);
    const identity = await oidc.finishLogin(new URL(`http://whatever.invalid/cb${search}`), start);
    expect(identity).toEqual({ subject: 'idp-sub-1', email: 'u1@example.test', username: 'u1', name: '王小明' });
  });

  it('每次登入的 state、nonce、code verifier 都不一樣', async () => {
    const oidc = adapter();
    const a = await oidc.startLogin();
    const b = await oidc.startLogin();
    expect(a.state).not.toBe(b.state);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
  });

  it('state 不符、code verifier 不符、nonce 不符、簽發者不符都會失敗', async () => {
    const oidc = adapter();

    const s1 = await oidc.startLogin();
    const q1 = idp.authorize(s1.url, u1);
    await expect(oidc.finishLogin(new URL(`http://x.invalid/cb${q1}`), { ...s1, state: 'other' })).rejects.toThrow();

    const s2 = await oidc.startLogin();
    const q2 = idp.authorize(s2.url, u1);
    await expect(oidc.finishLogin(new URL(`http://x.invalid/cb${q2}`), { ...s2, codeVerifier: 'x'.repeat(43) })).rejects.toThrow();

    const s3 = await oidc.startLogin();
    const q3 = idp.authorize(s3.url, u1);
    await expect(oidc.finishLogin(new URL(`http://x.invalid/cb${q3}`), { ...s3, nonce: 'other' })).rejects.toThrow();

    const s4 = await oidc.startLogin();
    const q4 = idp.authorize(s4.url, u1);
    idp.tamper = (claims) => void (claims.iss = 'https://evil.example');
    try {
      await expect(oidc.finishLogin(new URL(`http://x.invalid/cb${q4}`), s4)).rejects.toThrow();
    } finally {
      idp.tamper = () => {};
    }

    const s5 = await oidc.startLogin();
    const q5 = idp.authorize(s5.url, u1);
    idp.tamper = (claims) => void (claims.aud = 'someone-else');
    try {
      await expect(oidc.finishLogin(new URL(`http://x.invalid/cb${q5}`), s5)).rejects.toThrow();
    } finally {
      idp.tamper = () => {};
    }
  });

  it('同一個 code 不能用第二次；身分提供者回報錯誤時失敗', async () => {
    const oidc = adapter();
    const start = await oidc.startLogin();
    const search = idp.authorize(start.url, u1);
    await oidc.finishLogin(new URL(`http://x.invalid/cb${search}`), start);
    await expect(oidc.finishLogin(new URL(`http://x.invalid/cb${search}`), start)).rejects.toThrow();
    await expect(
      oidc.finishLogin(new URL(`http://x.invalid/cb?error=access_denied&state=${start.state}`), start),
    ).rejects.toThrow();
  });

  it('身分提供者連不上：startLogin 失敗，恢復後下一次可以成功（不快取失敗）', async () => {
    const config = loadConfig(baseEnv({ ...oidcEnv, OIDC_ISSUER: 'http://127.0.0.1:1' }));
    const dead = new OpenidClientOidc(config.oidc!);
    await expect(dead.startLogin()).rejects.toThrow();
    await expect(dead.startLogin()).rejects.toThrow();
  });

  it('走 http 的身分提供者要明確允許才會連', async () => {
    const config = loadConfig(baseEnv(oidcEnv));
    const strict = new OpenidClientOidc({ ...config.oidc!, allowInsecure: false });
    await expect(strict.startLogin()).rejects.toThrow();
  });

  it('接上 app：從 /auth/oidc/login 一路到拿到 session', async () => {
    const config = loadConfig(baseEnv(oidcEnv));
    const t = await makeApp({ env: oidcEnv, oidc: new OpenidClientOidc(config.oidc!) });
    try {
      const login = await t.app.inject({ method: 'GET', url: '/api/auth/oidc/login?return_to=/inbox' });
      expect(login.statusCode).toBe(302);
      const search = idp.authorize(login.headers.location as string, u1);
      const callback = await t.app.inject({
        method: 'GET',
        url: `/api/auth/oidc/callback${search}`,
        headers: { cookie: cookieFrom(login) },
      });
      expect(callback.statusCode).toBe(302);
      expect(callback.headers.location).toBe('/inbox');
      const me = await t.app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { cookie: cookieFrom(callback, cookieFrom(login)) },
      });
      expect(me.json()).toMatchObject({ actor_id: 'u1', auth_method: 'oidc', profile: { name: '王小明' } });

      // 身分提供者認得、但本站沒有這個人。
      const login2 = await t.app.inject({ method: 'GET', url: '/api/auth/oidc/login' });
      const search2 = idp.authorize(login2.headers.location as string, { ...u1, sub: 'x', email: 'stranger@example.test' });
      const callback2 = await t.app.inject({
        method: 'GET',
        url: `/api/auth/oidc/callback${search2}`,
        headers: { cookie: cookieFrom(login2) },
      });
      expect(callback2.headers.location).toBe('/?login_error=not_provisioned');
    } finally {
      await t.close();
    }
  });

  it('app：身分提供者連不上時 /auth/oidc/login 回 502，不洩漏細節', async () => {
    const env = { ...oidcEnv, OIDC_ISSUER: 'http://127.0.0.1:1' };
    const t = await makeApp({ env, oidc: new OpenidClientOidc(loadConfig(baseEnv(env)).oidc!) });
    try {
      const res = await t.app.inject({ method: 'GET', url: '/api/auth/oidc/login' });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual({ code: 'oidc_unavailable', message: '單一登入暫時無法使用，請稍後再試' });
    } finally {
      await t.close();
    }
  });
});
