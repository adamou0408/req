import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DevMfa } from '../src/ports/adapters/mfaDev.ts';
import { TotpMfa } from '../src/ports/adapters/mfaTotp.ts';
import { base32Decode, hotp, totp, totpVerify } from '../src/ports/adapters/totp.ts';
import { CSRF, cookieFrom, FakeClock, login, makeApp, type TestApp } from './helpers.ts';

describe('TOTP 演算法（RFC 4226／RFC 6238 的測試向量）', () => {
  const sha1Key = Buffer.from('12345678901234567890');

  it('RFC 4226 附錄 D：HOTP', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    expected.forEach((code, counter) => expect(hotp(sha1Key, counter), `counter ${counter}`).toBe(code));
  });

  it('RFC 6238 附錄 B：TOTP（8 碼，SHA-1／SHA-256／SHA-512）', () => {
    const sha256Key = Buffer.from('12345678901234567890123456789012');
    const sha512Key = Buffer.from('1234567890123456789012345678901234567890123456789012345678901234');
    const vectors: Array<[number, string, string, string]> = [
      [59, '94287082', '46119246', '90693936'],
      [1111111109, '07081804', '68084774', '25091201'],
      [1111111111, '14050471', '67062674', '99943326'],
      [1234567890, '89005924', '91819424', '93441116'],
      [2000000000, '69279037', '90698825', '38618901'],
      [20000000000, '65353130', '77737706', '47863826'],
    ];
    for (const [sec, s1, s256, s512] of vectors) {
      expect(totp(sha1Key, sec * 1000, { digits: 8, algorithm: 'sha1' }), `sha1 @${sec}`).toBe(s1);
      expect(totp(sha256Key, sec * 1000, { digits: 8, algorithm: 'sha256' }), `sha256 @${sec}`).toBe(s256);
      expect(totp(sha512Key, sec * 1000, { digits: 8, algorithm: 'sha512' }), `sha512 @${sec}`).toBe(s512);
    }
  });

  it('base32 解碼', () => {
    expect(base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')?.toString()).toBe('12345678901234567890');
    expect(base32Decode('gezd gnbv-gy3t qojq')?.toString()).toBe('1234567890');
    expect(base32Decode('MZXW6YTBOI======')?.toString()).toBe('foobar');
    expect(base32Decode('not base32!')).toBeNull();
    expect(base32Decode('')).toBeNull();
  });

  it('驗證：容許前後一個步進，其餘拒絕', () => {
    const at = 1_700_000_000_000;
    const code = totp(sha1Key, at);
    expect(totpVerify(sha1Key, code, at)).toBe(Math.floor(at / 30000));
    expect(totpVerify(sha1Key, code, at + 30_000)).not.toBeNull();
    expect(totpVerify(sha1Key, code, at - 30_000)).not.toBeNull();
    expect(totpVerify(sha1Key, code, at + 90_000)).toBeNull();
    expect(totpVerify(sha1Key, '12345', at)).toBeNull();
    expect(totpVerify(sha1Key, 'abcdef', at)).toBeNull();
    expect(totpVerify(sha1Key, `${code}0`, at)).toBeNull();
  });
});

describe('MFA port', () => {
  it('dev：固定驗證碼', async () => {
    const mfa = new DevMfa('000000');
    expect(await mfa.verify('u1', '000000')).toBe('ok');
    expect(await mfa.verify('u1', ' 000000 ')).toBe('ok');
    expect(await mfa.verify('u1', '000001')).toBe('invalid');
    expect(await mfa.verify('u1', '0000000')).toBe('invalid');
  });

  it('totp：正確的碼可以過、同一組碼不能用第二次、沒設定的人回 not_enrolled', async () => {
    const clock = new FakeClock();
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const mfa = new TotpMfa({ getSecret: async (actor) => (actor === 'u1' ? secret : null), now: clock.now });
    const key = base32Decode(secret) as Buffer;
    const code = totp(key, clock.now());

    expect(await mfa.verify('u1', '123456')).toBe('invalid');
    expect(await mfa.verify('u1', code)).toBe('ok');
    expect(await mfa.verify('u1', code)).toBe('invalid'); // 重放
    clock.advanceSec(30);
    expect(await mfa.verify('u1', code)).toBe('invalid'); // 還在容許範圍內，但已經用過
    expect(await mfa.verify('u1', totp(key, clock.now()))).toBe('ok');
    expect(await mfa.verify('u2', code)).toBe('not_enrolled');
  });
});

describe('MFA step-up', () => {
  let t: TestApp;
  let clock: FakeClock;
  beforeAll(async () => {
    clock = new FakeClock();
    t = await makeApp({ now: clock.now, env: { MFA_TTL_SEC: '300', RATE_LIMIT_MAX: '100' } });
  });
  afterAll(() => t.close());

  const secure = (cookie: string) =>
    t.app.inject({ method: 'POST', url: '/api/secure', headers: { ...CSRF, cookie }, payload: { note: 'ok' } });
  const verify = (cookie: string | undefined, code: unknown, ip = '192.0.2.10') =>
    t.app.inject({
      method: 'POST',
      url: '/api/auth/mfa/verify',
      remoteAddress: ip,
      headers: { ...CSRF, ...(cookie ? { cookie } : {}) },
      payload: { code } as object,
    });

  it('需要 MFA 的路由：沒驗證回 403 mfa_required', async () => {
    const cookie = await login(t.app, 'u1');
    const res = await secure(cookie);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ code: 'mfa_required', message: '這個動作需要再驗證一次身分' });
  });

  it('沒登入先回 401，不是 mfa_required', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/secure', headers: CSRF, payload: {} });
    expect(res.statusCode).toBe(401);
    expect((await verify(undefined, '000000')).statusCode).toBe(401);
  });

  it('驗證成功後 5 分鐘內可以執行，過期後要重新驗證', async () => {
    let cookie = await login(t.app, 'u1');
    const ok = await verify(cookie, '000000');
    expect(ok.statusCode).toBe(200);
    const started = new Date(clock.now()).toISOString();
    expect(ok.json()).toEqual({
      mfa_verified: true,
      mfa_verified_at: started,
      mfa_expires_at: new Date(clock.now() + 300_000).toISOString(),
    });
    cookie = cookieFrom(ok, cookie);

    const done = await secure(cookie);
    expect(done.statusCode).toBe(200);
    expect(done.json()).toEqual({ done: true, by: 'u1', note: 'ok' });

    const me = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.json()).toMatchObject({ mfa_verified: true, mfa_verified_at: started });

    // 脈絡裡的 mfa_verified 也跟著變。
    const echo = await t.app.inject({ method: 'POST', url: '/api/echo', headers: { ...CSRF, cookie }, payload: {} });
    expect(echo.json().mfa).toBe(true);

    clock.advanceSec(299);
    const stillOk = await secure(cookie);
    expect(stillOk.statusCode).toBe(200);
    cookie = cookieFrom(stillOk, cookie);

    clock.advanceSec(1); // 剛好 300 秒
    const expired = await secure(cookie);
    expect(expired.statusCode).toBe(403);
    expect(expired.json().code).toBe('mfa_required');
    const meAfter = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(meAfter.json()).toMatchObject({ mfa_verified: false, mfa_verified_at: null, mfa_expires_at: null });
  });

  it('驗證只對那一個 session 有效', async () => {
    const a = await login(t.app, 'u1');
    const b = await login(t.app, 'u1');
    const ok = await verify(a, '000000');
    expect((await secure(cookieFrom(ok, a))).statusCode).toBe(200);
    expect((await secure(b)).statusCode).toBe(403);
    // 沒拿到新 cookie 的舊 cookie 也不算驗證過。
    expect((await secure(a)).statusCode).toBe(403);
  });

  it('驗證碼錯誤 → 422，session 不變', async () => {
    const cookie = await login(t.app, 'u2');
    const bad = await verify(cookie, '999999', '192.0.2.11');
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toEqual({ code: 'mfa_invalid', message: '驗證碼不正確' });
    expect((await secure(cookieFrom(bad, cookie))).statusCode).toBe(403);
    for (const code of [undefined, '', 123456, 'x'.repeat(17)]) {
      const res = await verify(cookie, code, '192.0.2.11');
      expect(res.statusCode, String(code)).toBe(400);
      expect(res.json().code).toBe('code_required');
    }
  });

  it('連續錯 5 次就鎖住這個人（換 IP、換 session 也一樣），過一段時間才解開', async () => {
    const lockClock = new FakeClock();
    const app = await makeApp({ now: lockClock.now, env: { RATE_LIMIT_MAX: '100' } });
    try {
      const cookie = await login(app.app, 'u1');
      const attempt = (code: string, ip: string, c = cookie) =>
        app.app.inject({
          method: 'POST',
          url: '/api/auth/mfa/verify',
          remoteAddress: ip,
          headers: { ...CSRF, cookie: c },
          payload: { code },
        });
      for (let i = 0; i < 5; i++) expect((await attempt('111111', `192.0.2.${i}`)).statusCode).toBe(422);
      const locked = await attempt('000000', '192.0.2.99');
      expect(locked.statusCode).toBe(429);
      expect(locked.json().code).toBe('mfa_locked');
      expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
      const otherSession = await login(app.app, 'u1');
      expect((await attempt('000000', '192.0.2.98', otherSession)).statusCode).toBe(429);
      // 別人不受影響。
      const other = await login(app.app, 'u2');
      expect((await attempt('000000', '192.0.2.97', other)).statusCode).toBe(200);
      lockClock.advanceSec(301);
      expect((await attempt('000000', '192.0.2.99')).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('同一個 IP 嘗試太多次 → 429', async () => {
    const app = await makeApp({ env: { RATE_LIMIT_MAX: '2' } });
    try {
      const cookie = await login(app.app, 'u1', {});
      const attempt = () =>
        app.app.inject({
          method: 'POST',
          url: '/api/auth/mfa/verify',
          remoteAddress: '192.0.2.200',
          headers: { ...CSRF, cookie },
          payload: { code: '000000' },
        });
      expect((await attempt()).statusCode).toBe(200);
      expect((await attempt()).statusCode).toBe(200);
      const blocked = await attempt();
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().code).toBe('too_many_requests');
    } finally {
      await app.close();
    }
  });

  it('MFA_MODE=totp：用資料庫裡的密鑰驗證；沒設定的人回 409', async () => {
    const totpClock = new FakeClock();
    const base = await makeApp({ now: totpClock.now, env: { MFA_MODE: 'totp' } });
    await base.close();
    // 用同一份設定、接上真的 TotpMfa（密鑰來自測試 schema 的 api.mfa_totp_secret）。
    const holder: { sys?: TestApp['sys'] } = {};
    const mfa = new TotpMfa({ getSecret: (actor) => holder.sys!.totpSecret(actor), now: totpClock.now });
    const app = await makeApp({ now: totpClock.now, env: { MFA_MODE: 'totp' }, mfa });
    holder.sys = app.sys;
    try {
      const key = base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ') as Buffer;
      const post = (cookie: string, code: string) =>
        app.app.inject({ method: 'POST', url: '/api/auth/mfa/verify', headers: { ...CSRF, cookie }, payload: { code } });

      const u1 = await login(app.app, 'u1');
      expect((await post(u1, '000000')).statusCode).toBe(422); // dev 的固定碼在 totp 模式無效
      const good = await post(u1, totp(key, totpClock.now()));
      expect(good.statusCode).toBe(200);

      const u2 = await login(app.app, 'u2');
      const notEnrolled = await post(u2, '123456');
      expect(notEnrolled.statusCode).toBe(409);
      expect(notEnrolled.json().code).toBe('mfa_not_enrolled');
    } finally {
      await app.close();
    }
  });
});
