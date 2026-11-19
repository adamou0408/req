/**
 * 正式契約檔（src/contract/*）的基本檢查。契約填好之後這些檢查一樣適用：
 * 只看「表的格式對不對」，不看內容。
 */
import { describe, expect, it } from 'vitest';
import { allowedFunctions, contract } from '../src/contract/index.ts';
import { assertFnName } from '../src/db.ts';
import { validateRoutes } from '../src/routing/register.ts';
import type { RouteReq } from '../src/routing/types.ts';

describe('正式契約檔', () => {
  it('路由表格式正確、沒有重複', () => {
    expect(() => validateRoutes(contract.routes)).not.toThrow();
  });

  it('路由不會蓋到內建的端點', () => {
    for (const r of contract.routes) {
      expect(r.path === '/healthz' || r.path.startsWith('/auth/') || r.path === '/auth', `${r.method} ${r.path}`).toBe(false);
    }
  });

  it('每一列的 args 都回傳陣列', () => {
    const req: RouteReq = {
      params: new Proxy({}, { get: () => 'x' }) as Record<string, string>,
      query: {},
      body: {},
      ctx: {
        actor: 'u1',
        ip: '127.0.0.1',
        device: 'desktop',
        userAgent: 'test',
        mfaVerified: false,
        mfaVerifiedAt: null,
        sessionId: 's',
        requestId: 'r',
      },
    };
    for (const r of contract.routes) {
      expect(Array.isArray(r.args(req)), `${r.method} ${r.path}`).toBe(true);
    }
  });

  it('sqlNames 都是合法的 function 名稱，而且都在白名單裡', () => {
    const allowed = new Set(allowedFunctions(contract));
    for (const [key, name] of Object.entries(contract.sqlNames)) {
      if (name === null) continue;
      expect(() => assertFnName(name), key).not.toThrow();
      expect(allowed.has(name), key).toBe(true);
    }
    for (const r of contract.routes) expect(allowed.has(r.fn)).toBe(true);
  });

  it('錯誤對應表：SQLSTATE 格式正確、狀態碼是 4xx／5xx、有預設文字', () => {
    for (const [code, rule] of Object.entries(contract.errors.exact)) {
      expect(code, code).toMatch(/^[0-9A-Z]{5}$/);
      expect(rule.status, code).toBeGreaterThanOrEqual(400);
      expect(rule.status, code).toBeLessThan(600);
      expect(rule.code, code).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(rule.message, code).toBeTruthy();
    }
    for (const [cls, rule] of Object.entries(contract.errors.classes)) {
      expect(cls, cls).toMatch(/^[0-9A-Z]{2}$/);
      expect(rule.status, cls).toBeGreaterThanOrEqual(400);
      expect(rule.message, cls).toBeTruthy();
    }
  });

  it('5xx 的對應一律不外露 SQL 訊息', () => {
    const all = [...Object.entries(contract.errors.exact), ...Object.entries(contract.errors.classes)];
    for (const [code, rule] of all) {
      if (rule.status >= 500) expect(rule.expose, code).toBe(false);
    }
  });
});
