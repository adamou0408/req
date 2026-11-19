import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OidcPort } from '../src/ports/oidc.ts';
import { openSession, sealSession, sign, verify, type SessionData } from '../src/session.ts';
import { safeReturnTo } from '../src/http/authRoutes.ts';
import { CSRF, cookieFrom, FakeClock, login, makeApp, setCookieLines, TEST_SECRET, type TestApp } from './helpers.ts';

describe('dev-login 與 session', () => {
  let t: TestApp;
  let clock: FakeClock;
  beforeAll(async () => {
    clock = new FakeClock();
    t = await makeApp({ now: clock.now, env: { SESSION_TTL_SEC: '3600', SESSION_IDLE_SEC: '600' } });
  });
  afterAll(() => t.close());

  it('GET /auth/config 告訴前端目前的登入方式', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/auth/config' });
    expect(res.json()).toEqual({
      auth_mode: 'dev',
      oidc_enabled: false,
      oidc_login_url: null,
      mfa_mode: 'dev',
      mfa_ttl_sec: 300,
    });
  });

  it('dev-login 設定簽章 cookie：HttpOnly、SameSite=Lax、Path=/', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/dev-login',
      headers: CSRF,
      payload: { actor_id: 'u1' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      actor_id: 'u1',
      auth_method: 'dev',
      mfa_verified: false,
      mfa_expires_at: null,
      profile: { id: 'u1', name: '王小明' },
    });
    const [line] = setCookieLines(res);
    expect(line).toMatch(/^das_session=v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=3600$/);
    expect(line).not.toMatch(/Secure/);
  });

  it('COOKIE_SECURE=true 時 cookie 帶 Secure 與 __Host- 前綴，並送出 HSTS', async () => {
    const secure = await makeApp({ env: { COOKIE_SECURE: 'true' } });
    try {
      const res = await secure.app.inject({
        method: 'POST',
        url: '/api/auth/dev-login',
        headers: CSRF,
        payload: { actor_id: 'u1' },
      });
      expect(setCookieLines(res)[0]).toMatch(/^__Host-das_session=.*; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/);
      expect(res.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
    } finally {
      await secure.close();
    }
  });

  it('actor_id 沒給或不合法 → 400；不存在的人 → SQL 端定義的錯誤', async () => {
    const post = (payload: unknown) =>
      t.app.inject({ method: 'POST', url: '/api/auth/dev-login', headers: CSRF, payload: payload as object });
    for (const payload of [{}, { actor_id: '' }, { actor_id: '   ' }, { actor_id: ['u1'] }, { actor_id: 'x'.repeat(201) }]) {
      const res = await post(payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().code).toBe('actor_id_required');
      expect(setCookieLines(res)).toEqual([]);
    }
    const unknown = await post({ actor_id: 'nobody' });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ code: 'unknown_actor', message: '找不到這個人' });
    expect(setCookieLines(unknown)).toEqual([]);
  });

  it('GET /auth/me：沒登入 401，登入後回目前的人', async () => {
    const anon = await t.app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(anon.statusCode).toBe(401);
    expect(anon.json()).toEqual({ code: 'unauthenticated', message: '請先登入' });

    const cookie = await login(t.app, 'u2');
    const me = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ actor_id: 'u2', auth_method: 'dev', device: 'desktop', profile: { name: '陳小華' } });
    expect(me.headers['cache-control']).toBe('no-store');
  });

  it('logout 清掉 cookie；之後就是未登入', async () => {
    const cookie = await login(t.app, 'u1');
    const out = await t.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { ...CSRF, cookie } });
    expect(out.statusCode).toBe(204);
    const lines = setCookieLines(out);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^das_session=; Path=\/; HttpOnly; SameSite=Lax; Max-Age=0$/);
    const after = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: cookieFrom(out, cookie) } });
    expect(after.statusCode).toBe(401);
  });

  it('被竄改或用別的金鑰簽的 cookie 不被接受', async () => {
    const cookie = await login(t.app, 'u1');
    const token = cookie.slice('das_session='.length);
    const [v, payload, sig] = token.split('.') as [string, string, string];
    const forgedPayload = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), sub: 'u2' }),
    ).toString('base64url');
    const nowSec = Math.floor(clock.now() / 1000);
    const session: SessionData = { sid: 'x', sub: 'u2', amr: 'dev', iat: nowSec, exp: nowSec + 3600, seen: nowSec, mfa: nowSec };
    const candidates = [
      `${v}.${forgedPayload}.${sig}`, // 改內容、沿用舊簽章
      `${v}.${payload}.${sig.slice(0, -2)}AA`, // 改簽章
      `${v}.${payload}`, // 少一段
      sealSession(session, 'another-secret-another-secret-another-secret'), // 別把金鑰
      sign('oidc-login', session, TEST_SECRET), // 同一把金鑰但用途不同
      'garbage',
      '',
    ];
    for (const value of candidates) {
      const res = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: `das_session=${value}` } });
      expect(res.statusCode, value).toBe(401);
    }
    // 對照組：原本的 cookie 可以用。
    const ok = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(ok.statusCode).toBe(200);
  });

  it('閒置逾時：超過 SESSION_IDLE_SEC 沒有活動就失效', async () => {
    const cookie = await login(t.app, 'u1');
    clock.advanceSec(599);
    const still = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(still.statusCode).toBe(200);
    // 有活動就會重發 cookie、延長閒置計時。
    const refreshed = cookieFrom(still, cookie);
    expect(refreshed).not.toBe(cookie);
    clock.advanceSec(599);
    const viaNew = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: refreshed } });
    expect(viaNew.statusCode).toBe(200);
    const viaOld = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(viaOld.statusCode).toBe(401);
  });

  it('絕對到期：不管有沒有活動，超過 SESSION_TTL_SEC 就失效', async () => {
    let cookie = await login(t.app, 'u1');
    for (let i = 0; i < 7; i++) {
      clock.advanceSec(500);
      const res = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
      expect(res.statusCode, `第 ${i + 1} 次`).toBe(200);
      cookie = cookieFrom(res, cookie);
    }
    clock.advanceSec(200); // 累計 3700 秒 > 3600
    const expired = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(expired.statusCode).toBe(401);
  });

  it('短時間內的請求不會每次都重發 cookie', async () => {
    const cookie = await login(t.app, 'u1');
    clock.advanceSec(10);
    const res = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(setCookieLines(res)).toEqual([]);
  });

  it('金鑰輪替：舊金鑰簽的 cookie 仍可驗證，新的用第一把簽', async () => {
    const oldKey = 'old-secret-old-secret-old-secret-old-secret';
    const newKey = 'new-secret-new-secret-new-secret-new-secret';
    const before = await makeApp({ env: { SESSION_SECRET: oldKey } });
    const after = await makeApp({ env: { SESSION_SECRET: `${newKey},${oldKey}` } });
    try {
      const cookie = await login(before.app, 'u1');
      const res = await after.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
      expect(res.statusCode).toBe(200);
      const fresh = await login(after.app, 'u1');
      expect(verify('session', fresh.slice('das_session='.length), [newKey])).not.toBeNull();
      expect(verify('session', fresh.slice('das_session='.length), [oldKey])).toBeNull();
    } finally {
      await before.close();
      await after.close();
    }
  });

  it('登入有 rate limit', async () => {
    const limited = await makeApp({ env: { RATE_LIMIT_MAX: '3' } });
    try {
      const attempt = () =>
        limited.app.inject({
          method: 'POST',
          url: '/api/auth/dev-login',
          headers: CSRF,
          remoteAddress: '192.0.2.50',
          payload: { actor_id: 'u1' },
        });
      for (let i = 0; i < 3; i++) expect((await attempt()).statusCode).toBe(200);
      const blocked = await attempt();
      expect(blocked.statusCode).toBe(429);
      expect(blocked.headers['retry-after']).toBeDefined();
      expect(setCookieLines(blocked)).toEqual([]);
    } finally {
      await limited.close();
    }
  });
});

describe('session 內容檢查', () => {
  it('欄位不對的內容就算簽章正確也不接受', () => {
    const now = 1_800_000_000;
    const good: SessionData = { sid: 's', sub: 'u1', amr: 'dev', iat: now, exp: now + 100, seen: now, mfa: null };
    expect(openSession(sealSession(good, TEST_SECRET), [TEST_SECRET], now, 60)).toEqual(good);
    for (const bad of [
      { ...good, sub: '' },
      { ...good, sub: 42 },
      { ...good, amr: 'magic' },
      { ...good, exp: 'never' },
      { ...good, mfa: 'yes' },
      { ...good, exp: now }, // 剛好到期
      { ...good, seen: now - 61 }, // 閒置太久
    ]) {
      const token = sign('session', bad, TEST_SECRET);
      expect(openSession(token, [TEST_SECRET], now, 60), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('AUTH_MODE=oidc', () => {
  const fakeOidc = (): OidcPort & { calls: unknown[] } => {
    const calls: unknown[] = [];
    return {
      calls,
      async startLogin() {
        return { url: 'https://idp.example.test/authorize?client_id=das', state: 'st-1', nonce: 'no-1', codeVerifier: 'cv-1' };
      },
      async finishLogin(callbackUrl, expected) {
        calls.push({ search: callbackUrl.search, expected });
        if (callbackUrl.searchParams.get('state') !== expected.state) throw new Error('state mismatch');
        const code = callbackUrl.searchParams.get('code');
        if (code === 'bad') throw new Error('invalid_grant');
        return { subject: `sub-${code}`, email: `${code}@example.test`, username: code, name: null };
      },
    };
  };

  it('dev-login 不存在（404），不是被拒絕而已', async () => {
    const t = await makeApp({ env: { AUTH_MODE: 'oidc' }, oidc: fakeOidc() });
    try {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/auth/dev-login',
        headers: CSRF,
        payload: { actor_id: 'u1' },
      });
      expect(res.statusCode).toBe(404);
      expect(setCookieLines(res)).toEqual([]);
    } finally {
      await t.close();
    }
  });

  it('設定不全（沒有 OIDC port）：登入回 503，其餘照常', async () => {
    const t = await makeApp({ env: { AUTH_MODE: 'oidc' }, oidc: null });
    try {
      expect(t.config.oidc).toBeNull();
      const res = await t.app.inject({ method: 'GET', url: '/api/auth/oidc/login' });
      expect(res.statusCode).toBe(503);
      expect(res.json().code).toBe('oidc_not_configured');
      const config = await t.app.inject({ method: 'GET', url: '/api/auth/config' });
      expect(config.json()).toMatchObject({ auth_mode: 'oidc', oidc_enabled: false, oidc_login_url: null });
      expect((await t.app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    } finally {
      await t.close();
    }
  });

  it('完整流程：login 導向身分提供者 → callback 建立 session → 導回原本要去的頁面', async () => {
    const oidc = fakeOidc();
    const t = await makeApp({ env: { AUTH_MODE: 'oidc' }, oidc });
    try {
      const start = await t.app.inject({ method: 'GET', url: '/api/auth/oidc/login?return_to=/requests/42' });
      expect(start.statusCode).toBe(302);
      expect(start.headers.location).toBe('https://idp.example.test/authorize?client_id=das');
      const stateCookie = cookieFrom(start);
      expect(stateCookie).toMatch(/^das_session_oidc=v1\./);
      expect(setCookieLines(start)[0]).toMatch(/HttpOnly; SameSite=Lax; Max-Age=600$/);

      const back = await t.app.inject({
        method: 'GET',
        url: '/api/auth/oidc/callback?code=u1&state=st-1',
        headers: { cookie: stateCookie },
      });
      expect(back.statusCode).toBe(302);
      expect(back.headers.location).toBe('/requests/42');
      expect(oidc.calls).toEqual([
        { search: '?code=u1&state=st-1', expected: { state: 'st-1', nonce: 'no-1', codeVerifier: 'cv-1' } },
      ]);
      const cookie = cookieFrom(back, stateCookie);
      expect(cookie).toMatch(/^das_session=/); // 暫存的 state cookie 已清掉
      const me = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
      expect(me.json()).toMatchObject({ actor_id: 'u1', auth_method: 'oidc' });
    } finally {
      await t.close();
    }
  });

  it('callback 失敗的各種情況都不會建立 session', async () => {
    const t = await makeApp({ env: { AUTH_MODE: 'oidc' }, oidc: fakeOidc() });
    try {
      const start = await t.app.inject({ method: 'GET', url: '/api/auth/oidc/login' });
      const stateCookie = cookieFrom(start);
      const callback = (query: string, cookie?: string) =>
        t.app.inject({ method: 'GET', url: `/api/auth/oidc/callback?${query}`, headers: cookie ? { cookie } : {} });
      const hasSession = (res: Awaited<ReturnType<typeof callback>>) =>
        setCookieLines(res).some((l) => l.startsWith('das_session=') && !/Max-Age=0/.test(l));

      const noCookie = await callback('code=u1&state=st-1');
      expect(noCookie.headers.location).toBe('/?login_error=login_expired');
      expect(hasSession(noCookie)).toBe(false);

      const wrongState = await callback('code=u1&state=attacker', stateCookie);
      expect(wrongState.headers.location).toBe('/?login_error=login_failed');
      expect(hasSession(wrongState)).toBe(false);

      const badCode = await callback('code=bad&state=st-1', stateCookie);
      expect(badCode.headers.location).toBe('/?login_error=login_failed');
      expect(hasSession(badCode)).toBe(false);

      const stranger = await callback('code=stranger&state=st-1', stateCookie);
      expect(stranger.headers.location).toBe('/?login_error=not_provisioned');
      expect(hasSession(stranger)).toBe(false);
    } finally {
      await t.close();
    }
  });

  it('暫存的 state 過期就不能用', async () => {
    const clock = new FakeClock();
    const t = await makeApp({ env: { AUTH_MODE: 'oidc' }, oidc: fakeOidc(), now: clock.now });
    try {
      const start = await t.app.inject({ method: 'GET', url: '/api/auth/oidc/login' });
      clock.advanceSec(601);
      const back = await t.app.inject({
        method: 'GET',
        url: '/api/auth/oidc/callback?code=u1&state=st-1',
        headers: { cookie: cookieFrom(start) },
      });
      expect(back.headers.location).toBe('/?login_error=login_expired');
    } finally {
      await t.close();
    }
  });

  it('return_to 只接受本站的相對路徑', () => {
    expect(safeReturnTo('/requests/42?tab=history')).toBe('/requests/42?tab=history');
    for (const bad of ['https://evil.example', '//evil.example', '/\\evil.example', 'requests', '', undefined, 42, '/a\nb']) {
      expect(safeReturnTo(bad), String(bad)).toBe('/');
    }
  });
});
