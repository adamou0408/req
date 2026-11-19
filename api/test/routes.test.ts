import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateRoutes } from '../src/routing/register.ts';
import type { RouteDef } from '../src/routing/types.ts';
import { testContract } from './fixtures/testContract.ts';
import { CSRF, login, makeApp, type TestApp } from './helpers.ts';

describe('路由表驅動的通用 handler', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeApp();
  });
  afterAll(() => t.close());

  it('public 路由不需登入，p_actor 是 null', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/ping' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(res.json()).toEqual({ pong: true, actor: null });
  });

  it('user 路由沒登入回 401 {code,message}', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/whoami' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ code: 'unauthenticated', message: '請先登入' });
  });

  it('登入後 p_actor 來自 session，不是請求內容', async () => {
    const cookie = await login(t.app, 'u1');
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/whoami?actor=u2&p_actor=u2',
      headers: { cookie, 'x-actor': 'u2' },
    });
    expect(res.json()).toEqual({ actor: 'u1' });
  });

  it('args 可以取用 body 與請求脈絡（ip、device、mfa）', async () => {
    const cookie = await login(t.app, 'u1');
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/echo',
      remoteAddress: '203.0.113.7',
      headers: {
        ...CSRF,
        cookie,
        'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
      },
      payload: { list: [1, 2, 3], note: "it's fine" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      actor: 'u1',
      payload: { list: [1, 2, 3], note: "it's fine" },
      ip: '203.0.113.7',
      device: 'mobile',
      mfa: false,
    });
  });

  it('桌機的 User-Agent 判成 desktop；Client Hints 優先', async () => {
    const cookie = await login(t.app, 'u1');
    const post = (headers: Record<string, string>) =>
      t.app.inject({ method: 'POST', url: '/api/echo', headers: { ...CSRF, cookie, ...headers }, payload: {} });
    const desktop = await post({ 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0 Safari/537.36' });
    expect(desktop.json().device).toBe('desktop');
    const hinted = await post({ 'user-agent': 'Mozilla/5.0 (Linux; Android 10; K) Chrome/140.0', 'sec-ch-ua-mobile': '?0' });
    expect(hinted.json().device).toBe('desktop');
    const none = await post({});
    expect(none.json().device).toBe('desktop');
  });

  it('rows 與 row', async () => {
    const rows = await t.app.inject({ method: 'GET', url: '/api/items?n=2' });
    expect(rows.json()).toEqual([
      { n: 1, label: 'item-1' },
      { n: 2, label: 'item-2' },
    ]);
    const row = await t.app.inject({ method: 'GET', url: '/api/items/first?n=2' });
    expect(row.json()).toEqual({ n: 1, label: 'item-1' });
    const empty = await t.app.inject({ method: 'GET', url: '/api/items/first?n=0' });
    expect(empty.statusCode).toBe(200);
    expect(empty.body).toBe('null');
  });

  it('自訂成功狀態（201）與不回內容（204）', async () => {
    const cookie = await login(t.app, 'u1');
    const created = await t.app.inject({ method: 'POST', url: '/api/things', headers: { ...CSRF, cookie }, payload: { id: 7 } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({ id: 7 });
    const deleted = await t.app.inject({ method: 'DELETE', url: '/api/things/7', headers: { ...CSRF, cookie } });
    expect(deleted.statusCode).toBe(204);
    expect(deleted.body).toBe('');
    const again = await t.app.inject({ method: 'DELETE', url: '/api/things/7', headers: { ...CSRF, cookie } });
    expect(again.statusCode).toBe(404);
    expect(again.json()).toEqual({ code: 'thing_not_found', message: '找不到這個東西' });
  });

  it('文字結果也回成 JSON；沒給的參數當 null', async () => {
    const text = await t.app.inject({ method: 'POST', url: '/api/echo-text', headers: CSRF, payload: { value: '哈囉' } });
    expect(text.body).toBe('"哈囉"');
    const missing = await t.app.inject({ method: 'POST', url: '/api/echo-text', headers: CSRF, payload: {} });
    expect(missing.body).toBe('null');
    const noBody = await t.app.inject({ method: 'POST', url: '/api/echo-text', headers: CSRF });
    expect(noBody.statusCode).toBe(200);
    expect(noBody.body).toBe('null');
  });

  it('body 頂層不是物件 → 400', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/echo-text', headers: CSRF, payload: [1, 2] });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('bad_request');
  });

  it('respond 可以自訂回應（下載檔案）', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/download' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe('attachment; filename="x.csv"');
    expect(res.body).toBe('a,b\n1,2\n');
  });

  it('沒有的路徑回 JSON 404；路徑不由請求決定要呼叫哪個 function', async () => {
    for (const url of ['/api/nope', '/api/not_whitelisted', '/api/ping/../not_whitelisted', '/ping']) {
      const res = await t.app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
      expect(res.json(), url).toEqual({ code: 'not_found', message: '找不到這個網址' });
    }
  });

  describe('錯誤對應', () => {
    const fail = (payload: Record<string, unknown>) =>
      t.app.inject({ method: 'POST', url: '/api/fail', headers: CSRF, payload });

    it('自訂 SQLSTATE → 對應的狀態與 {code,message}', async () => {
      const res = await fail({ sqlstate: 'DT403', message: 'not_your_turn', detail: '還沒輪到你簽' });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ code: 'not_your_turn', message: '還沒輪到你簽' });
      const conflict = await fail({ sqlstate: 'DT409', message: 'already_decided' });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toEqual({ code: 'already_decided', message: '狀態已改變' });
      const other = await fail({ sqlstate: 'DT777', message: 'whatever' });
      expect(other.statusCode).toBe(400);
    });

    it('轉型失敗（22P02）→ 400，原始訊息不外露', async () => {
      const res = await t.app.inject({ method: 'GET', url: '/api/to-int/abc' });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ code: 'invalid_input', message: '輸入的格式不正確' });
    });

    it('未知錯誤 → 500、不洩漏內部訊息、有記 log', async () => {
      const before = t.logs.length;
      const res = await t.app.inject({ method: 'GET', url: '/api/boom' });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ code: 'internal_error', message: '系統發生錯誤，請稍後再試' });
      expect(res.body).not.toContain('internal-secret-value');
      expect(res.body).not.toContain('das.people');
      const logged = t.logs.slice(before).map((l) => JSON.parse(l));
      const entry = logged.find((l) => l.msg === '請求失敗（內部錯誤）');
      expect(entry).toMatchObject({ level: 50, status: 500, sqlstate: 'P0001', reqId: res.headers['x-request-id'] });
      expect(entry.err.message).toContain('leaked');
    });

    it('沒對應到的 SQLSTATE 就算訊息寫得像代碼也不外露', async () => {
      const res = await fail({ sqlstate: 'ZZ001', message: 'looks_like_a_code', detail: '內部細節' });
      expect(res.statusCode).toBe(500);
      expect(res.body).not.toContain('looks_like_a_code');
      expect(res.body).not.toContain('內部細節');
    });

    it('args() 自己丟例外 → 500，不洩漏', async () => {
      const res = await t.app.inject({ method: 'GET', url: '/api/broken-args' });
      expect(res.statusCode).toBe(500);
      expect(res.body).not.toContain('寫壞了');
    });

    it('業務性的拒絕不記成 error', async () => {
      const before = t.logs.length;
      await fail({ sqlstate: 'DT403', message: 'not_your_turn' });
      const levels = t.logs.slice(before).map((l) => JSON.parse(l).level as number);
      expect(Math.max(...levels)).toBeLessThan(50);
    });
  });

  it('請求 log 不含 query string、cookie、body', async () => {
    const cookie = await login(t.app, 'u1');
    const before = t.logs.length;
    await t.app.inject({
      method: 'POST',
      url: '/api/echo?token=query-secret',
      headers: { ...CSRF, cookie },
      payload: { password: 'body-secret' },
    });
    const text = t.logs.slice(before).join('\n');
    expect(text).toContain('"path":"/api/echo"');
    expect(text).toContain('"actor":"u1"');
    expect(text).not.toContain('query-secret');
    expect(text).not.toContain('body-secret');
    expect(text).not.toContain(cookie.split('=')[1]);
  });
});

describe('信任代理（TRUST_PROXY）', () => {
  const forwarded = async (env: Record<string, string>): Promise<string> => {
    const t = await makeApp({ env });
    try {
      const cookie = await login(t.app, 'u1');
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/echo',
        remoteAddress: '10.0.0.5',
        headers: { ...CSRF, cookie, 'x-forwarded-for': '198.51.100.9' },
        payload: {},
      });
      return res.json().ip as string;
    } finally {
      await t.close();
    }
  };

  it('預設不信任 X-Forwarded-For', async () => {
    expect(await forwarded({})).toBe('10.0.0.5');
  });

  it('TRUST_PROXY=true 時採用代理轉來的 IP', async () => {
    expect(await forwarded({ TRUST_PROXY: 'true' })).toBe('198.51.100.9');
  });
});

describe('rate limit（路由表的 rateLimit）', () => {
  it('超過上限回 429 與 Retry-After', async () => {
    const t = await makeApp({ env: { RATE_LIMIT_MAX: '2', RATE_LIMIT_WINDOW_SEC: '60' } });
    try {
      const hit = () => t.app.inject({ method: 'POST', url: '/api/limited', headers: CSRF, remoteAddress: '192.0.2.1' });
      expect((await hit()).statusCode).toBe(200);
      expect((await hit()).statusCode).toBe(200);
      const blocked = await hit();
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().code).toBe('too_many_requests');
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
      // 別的 IP 不受影響。
      const other = await t.app.inject({ method: 'POST', url: '/api/limited', headers: CSRF, remoteAddress: '192.0.2.2' });
      expect(other.statusCode).toBe(200);
    } finally {
      await t.close();
    }
  });
});

describe('路由表檢查', () => {
  const ok: RouteDef = { method: 'GET', path: '/a', fn: 'ping', auth: 'public', args: () => [] };

  it('合法的表可以通過', () => {
    expect(() => validateRoutes(testContract.routes)).not.toThrow();
  });

  it('寫錯的地方啟動時就擋下來', () => {
    expect(() => validateRoutes([{ ...ok, fn: 'ping; drop' }])).toThrow(/名稱不合法/);
    expect(() => validateRoutes([{ ...ok, path: 'a' }])).toThrow(/path 必須以 \/ 開頭/);
    expect(() => validateRoutes([{ ...ok, mfa: true }])).toThrow(/mfa 只能用在 auth=user/);
    expect(() => validateRoutes([ok, { ...ok }])).toThrow(/重複的路由/);
    expect(() => validateRoutes([{ ...ok, path: '/x/:id' }, { ...ok, path: '/x/:key' }])).toThrow(/重複的路由/);
    expect(() => validateRoutes([{ ...ok, status: 500 }])).toThrow(/status 必須是 200–399/);
    expect(() => validateRoutes([{ ...ok, method: 'TRACE' as never }])).toThrow(/method 不合法/);
  });

  it('路由表有問題時 app 起不來', async () => {
    await expect(makeApp({ contract: { ...testContract, routes: [{ ...ok, fn: 'Bad Name' }] } })).rejects.toThrow(
      /名稱不合法/,
    );
  });
});
