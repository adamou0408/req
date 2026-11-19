import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF, makeApp, type TestApp } from './helpers.ts';

describe('WEB_DIST：靜態檔與 SPA fallback', () => {
  let root: string;
  let dist: string;
  let t: TestApp;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'das-api-static-'));
    dist = path.join(root, 'dist');
    await mkdir(path.join(dist, 'assets'), { recursive: true });
    await mkdir(path.join(dist, '.well-known'));
    await writeFile(path.join(dist, 'index.html'), '<!doctype html><title>資料授權簽核</title><div id="root"></div>');
    await writeFile(path.join(dist, 'assets', 'index-abc123.js'), 'console.log("app")');
    await writeFile(path.join(dist, 'assets', 'index-abc123.css'), 'body{margin:0}');
    await writeFile(path.join(dist, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await writeFile(path.join(dist, '.env'), 'SECRET=in-dist');
    await writeFile(path.join(dist, '.well-known', 'security.txt'), 'Contact: mailto:security@example.test');
    await writeFile(path.join(root, 'outside.txt'), 'outside the web root');
    await symlink(path.join(root, 'outside.txt'), path.join(dist, 'link.txt'));
    t = await makeApp({ env: { WEB_DIST: dist } });
  });
  afterAll(async () => {
    await t.close();
    await rm(root, { recursive: true, force: true });
  });

  const get = (url: string, headers: Record<string, string> = {}) => t.app.inject({ method: 'GET', url, headers });

  it('/ 回 index.html，不快取', async () => {
    const res = await get('/');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.body).toContain('資料授權簽核');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('/assets/* 回檔案並可永久快取', async () => {
    const js = await get('/assets/index-abc123.js');
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(js.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(js.body).toBe('console.log("app")');
    const css = await get('/assets/index-abc123.css');
    expect(css.headers['content-type']).toBe('text/css; charset=utf-8');
    const svg = await get('/favicon.svg');
    expect(svg.headers['content-type']).toBe('image/svg+xml');
    expect(svg.headers['cache-control']).toBe('no-cache');
  });

  it('SPA fallback：前端路由的網址都回 index.html', async () => {
    for (const url of ['/inbox', '/requests/42', '/requests/42?tab=history', '/a/b/c/']) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).toContain('<div id="root">');
    }
  });

  it('要檔案卻找不到 → 404，不回 index.html', async () => {
    for (const url of ['/assets/missing.js', '/logo.png', '/robots.txt']) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(404);
      expect(res.json().code).toBe('not_found');
    }
  });

  it('API 與 /healthz 不受影響：不存在的 API 路徑回 JSON 404', async () => {
    expect((await get('/api/ping')).json()).toEqual({ pong: true, actor: null });
    expect((await get('/healthz')).json()).toEqual({ status: 'ok', db: 'ok' });
    for (const url of ['/api/nope', '/api', '/api/']) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(404);
      expect(res.headers['content-type'], url).toBe('application/json; charset=utf-8');
    }
  });

  it('拿不到 WEB_DIST 以外的檔案：可疑的路徑一律 4xx，連 index.html 都不回', async () => {
    const attempts = [
      '/../outside.txt',
      '/assets/../../outside.txt',
      '/%2e%2e/outside.txt',
      '/%2e%2e/%2e%2e/etc/passwd',
      '/assets/%2e%2e%2f%2e%2e%2foutside.txt',
      '/..%2foutside.txt',
      '/assets/..%5c..%5coutside.txt',
      '/%00',
      '/inbox%00.html',
      '/%E0%A4%A', // 壞掉的編碼
      '/link.txt', // 指向外面的符號連結
      '/.env', // 隱藏檔
      '/.git/config',
    ];
    for (const url of attempts) {
      const res = await get(url);
      expect([400, 404], `${url} → ${res.statusCode}`).toContain(res.statusCode);
      expect(res.body, url).not.toContain('outside the web root');
      expect(res.body, url).not.toContain('SECRET=in-dist');
      expect(res.body, url).not.toContain('<div id="root">');
    }
    // 多一個斜線只是一般路徑，照 SPA fallback 處理，拿不到系統檔案。
    const doubled = await get('//etc/passwd');
    expect(doubled.body).not.toContain('root:');
  });

  it('真的走 HTTP、路徑不經過任何正規化時也一樣', async () => {
    await t.app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = t.app.server.address() as { port: number };
    const raw = (rawPath: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path: rawPath, method: 'GET' }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on('error', reject);
        req.end();
      });
    for (const rawPath of [
      '/assets/../../outside.txt',
      '/assets/../../../../../../etc/passwd',
      '/../../../../etc/passwd',
      '/assets/..%2f..%2foutside.txt',
      '/.env',
    ]) {
      const res = await raw(rawPath);
      expect([400, 404], `${rawPath} → ${res.status}`).toContain(res.status);
      expect(res.body, rawPath).not.toContain('outside the web root');
      expect(res.body, rawPath).not.toContain('root:');
      expect(res.body, rawPath).not.toContain('<div id="root">');
    }
    expect((await raw('/assets/index-abc123.js')).body).toBe('console.log("app")');
    expect((await raw('/inbox')).body).toContain('<div id="root">');
  });

  it('.well-known 可以提供', async () => {
    const res = await get('/.well-known/security.txt');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Contact:');
  });

  it('ETag：內容沒變回 304', async () => {
    const first = await get('/assets/index-abc123.js');
    const etag = first.headers.etag as string;
    expect(etag).toMatch(/^W\/"/);
    const second = await get('/assets/index-abc123.js', { 'if-none-match': etag });
    expect(second.statusCode).toBe(304);
    expect(second.body).toBe('');
  });

  it('HEAD 只回標頭', async () => {
    const res = await t.app.inject({ method: 'HEAD', url: '/assets/index-abc123.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-length']).toBe('18');
    expect(res.body).toBe('');
  });

  it('POST 到前端路徑不會回 index.html', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/inbox', headers: CSRF });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('not_found');
  });

  it('WEB_DIST 不存在或沒有 index.html 時起不來，訊息講清楚', async () => {
    await expect(makeApp({ env: { WEB_DIST: path.join(root, 'nope') } })).rejects.toThrow(/WEB_DIST 指到的目錄不存在/);
    const empty = path.join(root, 'empty');
    await mkdir(empty);
    await expect(makeApp({ env: { WEB_DIST: empty } })).rejects.toThrow(/找不到 index.html/);
  });
});

describe('沒有設定 WEB_DIST', () => {
  it('/ 回 JSON 404（前端由別的服務提供）', async () => {
    const t = await makeApp();
    try {
      const res = await t.app.inject({ method: 'GET', url: '/' });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ code: 'not_found', message: '找不到這個網址' });
    } finally {
      await t.close();
    }
  });
});
