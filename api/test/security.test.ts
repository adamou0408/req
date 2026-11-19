import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { login, makeApp, type TestApp } from './helpers.ts';

describe('CSRF 防護', () => {
  let t: TestApp;
  let cookie: string;
  beforeAll(async () => {
    t = await makeApp();
    cookie = await login(t.app, 'u1');
  });
  afterAll(() => t.close());

  const post = (headers: Record<string, string>, url = '/api/echo') =>
    t.app.inject({ method: 'POST', url, headers: { cookie, host: 'das.example.test', ...headers }, payload: { a: 1 } });

  it('非 GET 沒帶自訂標頭 → 403', async () => {
    const res = await post({});
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ code: 'csrf_header_missing', message: '請求缺少必要的標頭' });
    const blank = await post({ 'x-requested-with': '  ' });
    expect(blank.statusCode).toBe(403);
  });

  it('帶了自訂標頭、沒有 Origin（非瀏覽器）→ 放行', async () => {
    const res = await post({ 'x-requested-with': 'das-web' });
    expect(res.statusCode).toBe(200);
  });

  it('Origin 與 Host 相同 → 放行', async () => {
    const res = await post({ 'x-requested-with': 'das-web', origin: 'https://das.example.test' });
    expect(res.statusCode).toBe(200);
  });

  it('Origin 是別的網站 → 403，就算有自訂標頭', async () => {
    for (const origin of ['https://evil.example', 'https://das.example.test.evil.example', 'https://sub.das.example.test', 'null']) {
      const res = await post({ 'x-requested-with': 'das-web', origin });
      expect(res.statusCode, origin).toBe(403);
      expect(res.json().code).toBe('csrf_origin_mismatch');
    }
  });

  it('沒有 Origin 但 Sec-Fetch-Site 表示跨站 → 403', async () => {
    expect((await post({ 'x-requested-with': 'das-web', 'sec-fetch-site': 'cross-site' })).statusCode).toBe(403);
    expect((await post({ 'x-requested-with': 'das-web', 'sec-fetch-site': 'same-site' })).statusCode).toBe(403);
    expect((await post({ 'x-requested-with': 'das-web', 'sec-fetch-site': 'same-origin' })).statusCode).toBe(200);
  });

  it('所有會改資料的方法與端點都適用（含登入、登出、MFA、不存在的路徑）', async () => {
    const targets: Array<[string, string]> = [
      ['POST', '/api/auth/dev-login'],
      ['POST', '/api/auth/logout'],
      ['POST', '/api/auth/mfa/verify'],
      ['DELETE', '/api/things/1'],
      ['PUT', '/api/nope'],
      ['PATCH', '/api/nope'],
    ];
    for (const [method, url] of targets) {
      const res = await t.app.inject({ method: method as 'POST', url, headers: { cookie } });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().code).toBe('csrf_header_missing');
    }
  });

  it('被擋下的請求不會執行到 SQL function', async () => {
    const admin = new pg.Pool({ connectionString: inject('adminDbUrl'), max: 1 });
    try {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/things',
        headers: { cookie, origin: 'https://evil.example', 'x-requested-with': 'x' },
        payload: { id: 9001 },
      });
      expect(res.statusCode).toBe(403);
      const { rows } = await admin.query('select count(*)::int as n from das.things where id = 9001');
      expect(rows[0].n).toBe(0);
    } finally {
      await admin.end();
    }
  });

  it('GET 不需要自訂標頭', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/whoami', headers: { cookie } });
    expect(res.statusCode).toBe(200);
  });

  it('只收 JSON：表單格式的 body 回 415', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/echo',
      headers: { cookie, 'x-requested-with': 'x', 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'a=1',
    });
    expect(res.statusCode).toBe(415);
    expect(res.json().code).toBe('unsupported_media_type');
    const text = await t.app.inject({
      method: 'POST',
      url: '/api/echo',
      headers: { cookie, 'x-requested-with': 'x', 'content-type': 'text/plain' },
      payload: '{"a":1}',
    });
    expect(text.statusCode).toBe(415);
  });
});

describe('CSRF：設定了 PUBLIC_ORIGIN／ALLOWED_ORIGINS', () => {
  it('Origin 必須等於 PUBLIC_ORIGIN 或在允許清單裡', async () => {
    const t = await makeApp({
      env: { PUBLIC_ORIGIN: 'https://das.example.test', ALLOWED_ORIGINS: 'http://localhost:5173' },
    });
    try {
      const post = (origin: string) =>
        t.app.inject({
          method: 'POST',
          url: '/api/echo-text',
          headers: { 'x-requested-with': 'x', origin, host: 'internal-host:3000' },
          payload: { value: 'x' },
        });
      expect((await post('https://das.example.test')).statusCode).toBe(200);
      expect((await post('http://localhost:5173')).statusCode).toBe(200);
      // 和 Host 相同也不行：有設 PUBLIC_ORIGIN 就以它為準。
      expect((await post('http://internal-host:3000')).statusCode).toBe(403);
      expect((await post('http://das.example.test')).statusCode).toBe(403);
    } finally {
      await t.close();
    }
  });
});

describe('安全標頭、請求大小、健康檢查', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeApp({ env: { BODY_LIMIT_BYTES: '2048' } });
  });
  afterAll(() => t.close());

  it('每個回應都帶安全標頭（含 404 與錯誤）', async () => {
    for (const url of ['/api/ping', '/api/nope', '/api/boom', '/healthz']) {
      const res = await t.app.inject({ method: 'GET', url });
      expect(res.headers, url).toMatchObject({
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
        'referrer-policy': 'no-referrer',
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-resource-policy': 'same-origin',
        'cache-control': 'no-store',
      });
      expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
      expect(res.headers['strict-transport-security']).toBeUndefined(); // 沒走 HTTPS 就不送
    }
  });

  it('不採用用戶端給的 request id', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/ping', headers: { 'x-request-id': 'attacker-chosen' } });
    expect(res.headers['x-request-id']).not.toBe('attacker-chosen');
  });

  it('body 超過上限 → 413', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/echo-text',
      headers: { 'x-requested-with': 'x' },
      payload: { value: 'x'.repeat(5000) },
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ code: 'payload_too_large', message: '送出的內容太大' });
  });

  it('JSON 語法錯誤 → 400，不回解析器的原始訊息', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/echo-text',
      headers: { 'x-requested-with': 'x', 'content-type': 'application/json' },
      payload: '{"value": ',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ code: 'bad_request', message: '請求格式不正確' });
  });

  it('__proto__ 之類的 JSON 會被擋下', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/echo-text',
      headers: { 'x-requested-with': 'x', 'content-type': 'application/json' },
      payload: '{"__proto__": {"admin": true}, "value": "x"}',
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /healthz：資料庫正常回 200', async () => {
    for (const url of ['/healthz', '/api/healthz']) {
      const res = await t.app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.json()).toEqual({ status: 'ok', db: 'ok' });
    }
  });

  it('GET /healthz：資料庫連不上回 503，不洩漏連線資訊', async () => {
    const url = new URL(inject('appDbUrl'));
    url.port = '1';
    const down = await makeApp({ pool: new pg.Pool({ connectionString: url.href, connectionTimeoutMillis: 300 }) });
    try {
      const res = await down.app.inject({ method: 'GET', url: '/healthz' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ status: 'unavailable', db: 'down' });
      const api = await down.app.inject({ method: 'GET', url: '/api/ping' });
      expect(api.statusCode).toBe(503);
      expect(api.json().code).toBe('service_unavailable');
      expect(api.body).not.toContain('ECONNREFUSED');
    } finally {
      await down.close();
    }
  });

  it('資料庫逾時（57014）→ 503', async () => {
    const slow = await makeApp({ env: { DB_STATEMENT_TIMEOUT_MS: '150' } });
    try {
      const res = await slow.app.inject({ method: 'GET', url: '/api/slow?seconds=2' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ code: 'timeout', message: '處理逾時' });
    } finally {
      await slow.close();
    }
  });
});
