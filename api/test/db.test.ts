import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { createPool, Db } from '../src/db.ts';
import { HttpError } from '../src/errors.ts';
import { baseEnv } from './helpers.ts';

describe('db 層：callApi', () => {
  let pool: pg.Pool;
  let db: Db;

  beforeAll(() => {
    pool = createPool(loadConfig(baseEnv()));
    db = new Db(pool, ['ping', 'echo', 'echo_text', 'to_int', 'list_items', 'fail', 'delete_thing', 'slow']);
  });
  afterAll(() => pool.end());

  it('scalar：select api.fn($1, ...) 並把 actor 放第一個參數', async () => {
    expect(await db.callApi('ping', 'u1')).toEqual({ pong: true, actor: 'u1' });
    expect(await db.callApi('ping', null)).toEqual({ pong: true, actor: null });
  });

  it('參數依順序傳入，jsonb 會解回物件', async () => {
    const result = await db.callApi('echo', 'u1', [JSON.stringify({ a: [1, 2], b: '中文' }), '10.0.0.1', 'mobile', true]);
    expect(result).toEqual({
      actor: 'u1',
      payload: { a: [1, 2], b: '中文' },
      ip: '10.0.0.1',
      device: 'mobile',
      mfa: true,
    });
  });

  it('rows／row／none 三種取值方式', async () => {
    expect(await db.callApi('list_items', null, [2], 'rows')).toEqual([
      { n: 1, label: 'item-1' },
      { n: 2, label: 'item-2' },
    ]);
    expect(await db.callApi('list_items', null, [2], 'row')).toEqual({ n: 1, label: 'item-1' });
    expect(await db.callApi('list_items', null, [0], 'row')).toBeNull();
    expect(await db.callApi('echo_text', null, ['x'], 'none')).toBeUndefined();
  });

  it('不在白名單的 function 不會被呼叫（即使資料庫裡真的有）', async () => {
    await expect(db.callApi('not_whitelisted', 'u1')).rejects.toThrow(/不在白名單內/);
    await expect(db.callApi('pg_sleep', null, [0])).rejects.toThrow(/不在白名單內/);
  });

  it('白名單裡的名稱必須是單純的識別字', () => {
    for (const bad of ['ping()', 'ping; drop table x', 'Ping', 'api.ping', 'a b', '', '1abc']) {
      expect(() => new Db(pool, [bad]), bad).toThrow(/名稱不合法/);
    }
  });

  it('參數一律走繫結：SQL 片段只會被當成資料', async () => {
    const hostile = `'); drop schema api cascade; --`;
    expect(await db.callApi('echo_text', hostile, [hostile])).toBe(hostile);
    // schema 還在。
    expect(await db.callApi('ping', null)).toMatchObject({ pong: true });
  });

  it('SQL function 丟的錯誤原樣往上丟，帶 SQLSTATE、message、detail', async () => {
    await expect(db.callApi('fail', 'u1', ['DT409', 'already_decided', '這張單已經簽過了'])).rejects.toMatchObject({
      code: 'DT409',
      message: 'already_decided',
      detail: '這張單已經簽過了',
    });
  });

  it('app 角色只能 EXECUTE api.*，不能直接碰資料表', async () => {
    await expect(pool.query('select * from das.people')).rejects.toMatchObject({ code: '42501' });
    await expect(pool.query('create table public.x (id int)')).rejects.toMatchObject({ code: '42501' });
  });

  it('超過 statement_timeout 會被資料庫中斷（57014）', async () => {
    const shortPool = createPool(loadConfig(baseEnv({ DB_STATEMENT_TIMEOUT_MS: '150' })));
    try {
      const shortDb = new Db(shortPool, ['slow']);
      await expect(shortDb.callApi('slow', null, [2])).rejects.toMatchObject({ code: '57014' });
    } finally {
      await shortPool.end();
    }
  });

  it('連不上資料庫 → 503，不是 500', async () => {
    const url = new URL(inject('appDbUrl'));
    url.port = '1'; // 沒有東西在聽
    const deadPool = new pg.Pool({ connectionString: url.href, connectionTimeoutMillis: 500 });
    try {
      const deadDb = new Db(deadPool, ['ping']);
      const err = await deadDb.callApi('ping', null).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HttpError);
      expect(err).toMatchObject({ status: 503, code: 'service_unavailable' });
      await expect(deadDb.ping(500)).rejects.toThrow();
    } finally {
      await deadPool.end();
    }
  });

  it('ping 成功', async () => {
    await expect(db.ping()).resolves.toBeUndefined();
  });
});

describe('db 層：序列化衝突自動重試', () => {
  it('40001 最多試 3 次，之後才往上丟', async () => {
    let calls = 0;
    const fakePool = {
      query: async () => {
        calls += 1;
        throw Object.assign(new Error('could not serialize access'), { code: '40001', severity: 'ERROR' });
      },
    } as unknown as pg.Pool;
    const db = new Db(fakePool, ['ping']);
    await expect(db.callApi('ping', null)).rejects.toMatchObject({ code: '40001' });
    expect(calls).toBe(3);
  });

  it('第二次成功就回結果', async () => {
    let calls = 0;
    const fakePool = {
      query: async () => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error('deadlock detected'), { code: '40P01', severity: 'ERROR' });
        return { rows: [{ result: 'ok' }] };
      },
    } as unknown as pg.Pool;
    expect(await new Db(fakePool, ['ping']).callApi('ping', null)).toBe('ok');
    expect(calls).toBe(2);
  });

  it('其他錯誤不重試', async () => {
    let calls = 0;
    const fakePool = {
      query: async () => {
        calls += 1;
        throw Object.assign(new Error('nope'), { code: 'DT403', severity: 'ERROR' });
      },
    } as unknown as pg.Pool;
    await expect(new Db(fakePool, ['ping']).callApi('ping', null)).rejects.toMatchObject({ code: 'DT403' });
    expect(calls).toBe(1);
  });
});
