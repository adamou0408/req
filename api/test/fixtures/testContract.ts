/**
 * 測試用的契約：對應 test-schema.sql。和 src/contract/ 的正式契約互不影響，
 * 所以正式契約怎麼改，這些測試都不用跟著改。
 */
import type { Contract } from '../../src/contract/index.ts';
import type { ErrorContract, RouteDef } from '../../src/routing/types.ts';

const json = (v: unknown): string => JSON.stringify(v ?? null);

export const testRoutes: RouteDef[] = [
  { method: 'GET', path: '/ping', fn: 'ping', auth: 'public', args: () => [] },
  { method: 'GET', path: '/whoami', fn: 'whoami', auth: 'user', args: () => [] },
  {
    method: 'POST',
    path: '/echo',
    fn: 'echo',
    auth: 'user',
    args: (r) => [json(r.body), r.ctx.ip, r.ctx.device, r.ctx.mfaVerified],
  },
  { method: 'POST', path: '/echo-text', fn: 'echo_text', auth: 'public', args: (r) => [r.body.value] },
  { method: 'GET', path: '/to-int/:value', fn: 'to_int', auth: 'public', args: (r) => [r.params.value] },
  { method: 'GET', path: '/items', fn: 'list_items', auth: 'public', result: 'rows', args: (r) => [r.query.n ?? '3'] },
  { method: 'GET', path: '/items/first', fn: 'list_items', auth: 'public', result: 'row', args: (r) => [r.query.n ?? '3'] },
  { method: 'POST', path: '/secure', fn: 'secure_action', auth: 'user', mfa: true, args: (r) => [r.body.note] },
  { method: 'POST', path: '/things', fn: 'add_thing', auth: 'user', status: 201, args: (r) => [r.body.id] },
  { method: 'DELETE', path: '/things/:id', fn: 'delete_thing', auth: 'user', result: 'none', args: (r) => [r.params.id] },
  {
    method: 'POST',
    path: '/fail',
    fn: 'fail',
    auth: 'public',
    args: (r) => [r.body.sqlstate, r.body.message, r.body.detail],
  },
  { method: 'GET', path: '/boom', fn: 'boom', auth: 'public', args: () => [] },
  { method: 'GET', path: '/slow', fn: 'slow', auth: 'public', args: (r) => [r.query.seconds ?? '1'] },
  { method: 'POST', path: '/limited', fn: 'ping', auth: 'public', rateLimit: true, args: () => [] },
  {
    method: 'GET',
    path: '/broken-args',
    fn: 'ping',
    auth: 'public',
    args: () => {
      throw new Error('args 寫壞了：這段文字不應該出現在回應裡');
    },
  },
  {
    method: 'GET',
    path: '/download',
    fn: 'echo_text',
    auth: 'public',
    args: () => ['a,b\n1,2\n'],
    respond: (result, reply) =>
      reply.type('text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="x.csv"').send(result),
  },
];

export const testErrors: ErrorContract = {
  exact: {
    DT401: { status: 401, expose: true, code: 'unauthenticated', message: '請先登入' },
    DT403: { status: 403, expose: true, code: 'forbidden', message: '沒有權限' },
    DT404: { status: 404, expose: true, code: 'not_found', message: '找不到資料' },
    DT409: { status: 409, expose: true, code: 'conflict', message: '狀態已改變' },
    '22P02': { status: 400, expose: false, code: 'invalid_input', message: '輸入的格式不正確' },
    '57014': { status: 503, expose: false, code: 'timeout', message: '處理逾時' },
  },
  classes: {
    DT: { status: 400, expose: true, code: 'invalid_request', message: '無法完成這個操作' },
  },
};

export const testContract: Contract = {
  routes: testRoutes,
  errors: testErrors,
  sqlNames: {
    schedulerRun: 'run_scheduled_jobs',
    outboxClaim: 'outbox_claim',
    outboxMarkSent: 'outbox_mark_sent',
    outboxMarkFailed: 'outbox_mark_failed',
    authResolveLogin: 'auth_resolve_login',
    authMe: 'auth_me',
    mfaTotpSecret: 'mfa_totp_secret',
    directoryImport: 'directory_import',
    catalogImport: 'catalog_import',
  },
  systemActor: null,
};
