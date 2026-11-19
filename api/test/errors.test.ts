import { describe, expect, it } from 'vitest';
import { HttpError, mapError } from '../src/errors.ts';
import { testErrors } from './fixtures/testContract.ts';

const pgError = (code: string, message: string, extra: Record<string, unknown> = {}): Error =>
  Object.assign(new Error(message), { code, severity: 'ERROR', ...extra });

describe('錯誤對應（SQLSTATE → HTTP）', () => {
  it('自訂 SQLSTATE：message 是訊息代碼、detail 是給人看的說明', () => {
    const m = mapError(pgError('DT404', 'request_not_found', { detail: '找不到這張申請單' }), testErrors);
    expect(m).toMatchObject({
      status: 404,
      body: { code: 'request_not_found', message: '找不到這張申請單' },
      kind: 'business',
      sqlstate: 'DT404',
    });
  });

  it('沒有 detail 時用對應表的預設訊息', () => {
    expect(mapError(pgError('DT403', 'not_your_turn'), testErrors).body).toEqual({
      code: 'not_your_turn',
      message: '沒有權限',
    });
  });

  it('message 不是代碼的樣子（一句話）時，code 用預設值、那句話當 message', () => {
    expect(mapError(pgError('DT409', '這張單已經被別人簽過了'), testErrors).body).toEqual({
      code: 'conflict',
      message: '這張單已經被別人簽過了',
    });
  });

  it('exact 沒對到就看類別（前 2 碼）', () => {
    expect(mapError(pgError('DT999', 'something_else'), testErrors)).toMatchObject({
      status: 400,
      body: { code: 'something_else', message: '無法完成這個操作' },
    });
  });

  it('expose=false：只回寫死的文字，原始訊息不外露', () => {
    const m = mapError(pgError('22P02', 'invalid input syntax for type integer: "abc"'), testErrors);
    expect(m).toMatchObject({ status: 400, body: { code: 'invalid_input', message: '輸入的格式不正確' }, kind: 'client' });
    expect(JSON.stringify(m.body)).not.toContain('abc');
  });

  it('沒對應到的 SQLSTATE → 500，不帶任何內部訊息', () => {
    const m = mapError(pgError('P0001', 'secret internal detail', { detail: 'row 42 of das.people' }), testErrors);
    expect(m).toMatchObject({ status: 500, kind: 'internal', sqlstate: 'P0001' });
    expect(m.body).toEqual({ code: 'internal_error', message: '系統發生錯誤，請稍後再試' });
  });

  it('一般的程式錯誤 → 500', () => {
    const m = mapError(new TypeError("Cannot read properties of undefined (reading 'x')"), testErrors);
    expect(m.status).toBe(500);
    expect(m.body.code).toBe('internal_error');
    expect(mapError('字串也可能被丟出來', testErrors).status).toBe(500);
    expect(mapError(null, testErrors).status).toBe(500);
  });

  it('HttpError 照自己的狀態與代碼', () => {
    const m = mapError(new HttpError(429, 'too_many_requests', '太多次', { 'retry-after': '30' }), testErrors);
    expect(m).toMatchObject({
      status: 429,
      body: { code: 'too_many_requests', message: '太多次' },
      headers: { 'retry-after': '30' },
      kind: 'client',
    });
  });

  it('長得像 SQLSTATE 但不是資料庫丟的（沒有 severity）不套用對應表', () => {
    const fake = Object.assign(new Error('DT404'), { code: 'DT404' });
    expect(mapError(fake, testErrors).status).toBe(500);
  });

  it('Fastify 的請求錯誤 → 4xx 與固定文字', () => {
    const tooLarge = Object.assign(new Error('Request body is too large'), { code: 'FST_ERR_CTP_BODY_TOO_LARGE', statusCode: 413 });
    expect(mapError(tooLarge, testErrors)).toMatchObject({ status: 413, body: { code: 'payload_too_large' } });
    const badJson = Object.assign(new SyntaxError('Unexpected token } in JSON at position 5'), { statusCode: 400 });
    expect(mapError(badJson, testErrors)).toMatchObject({
      status: 400,
      body: { code: 'bad_request', message: '請求格式不正確' },
    });
  });
});
