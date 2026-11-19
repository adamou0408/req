/**
 * ★ 契約檔：後端自己呼叫的 SQL function 的「參數順序」與「回傳欄位」。
 * 名稱在 sqlNames.ts。契約定案後，只要改這個檔裡的參數與欄位對應。
 *
 * 目前假設的簽章（都在 schema api，第一個參數都是 p_actor）：
 *   run_scheduled_jobs(p_actor)                                   returns jsonb
 *   outbox_claim(p_actor, p_limit int)                            returns table(id, recipients text[], cc text[],
 *                                                                               subject, body_text, body_html, attempts int)
 *   outbox_mark_sent(p_actor, p_id, p_provider_ref text)          returns void
 *   outbox_mark_failed(p_actor, p_id, p_error text, p_retry_after_sec int) returns void
 *   auth_resolve_login(p_actor, p_identity jsonb, p_ip text, p_device text) returns text（actor id；找不到回 null）
 *   auth_me(p_actor)                                              returns jsonb
 *   mfa_totp_secret(p_actor)                                      returns text（base32；未設定回 null）
 *   directory_import(p_actor, p_data jsonb)                       returns jsonb
 *   catalog_import(p_actor, p_data jsonb)                         returns jsonb
 */
import type { Db } from '../db.ts';
import type { Device } from '../routing/types.ts';
import type { SqlNames } from './sqlNames.ts';

export interface OutboxMessage {
  id: string;
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  html: string | null;
  /** 已經失敗過幾次（用來算重試間隔）。 */
  attempts: number;
}

export interface LoginIdentity {
  /** 身分提供者的 sub。 */
  subject: string;
  email: string | null;
  username: string | null;
  name: string | null;
}

export interface SystemCalls {
  runScheduledJobs(): Promise<unknown>;
  outboxClaim(limit: number): Promise<OutboxMessage[]>;
  outboxMarkSent(id: string, providerRef: string | null): Promise<void>;
  outboxMarkFailed(id: string, error: string, retryAfterSec: number): Promise<void>;
  /** 回 null＝這個身分在本站沒有對應的人。 */
  resolveLogin(identity: LoginIdentity, ip: string, device: Device): Promise<string | null>;
  /** 回 undefined＝契約沒有提供這個 function。 */
  me(actor: string): Promise<unknown>;
  totpSecret(actor: string): Promise<string | null>;
  importDirectory(data: unknown): Promise<unknown>;
  importCatalog(data: unknown): Promise<unknown>;
}

function stringList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && x !== '');
  if (typeof v === 'string' && v !== '') return [v];
  return [];
}

export function createSystemCalls(db: Db, names: SqlNames, systemActor: string | null): SystemCalls {
  return {
    runScheduledJobs: () => db.callApi(names.schedulerRun, systemActor, []),

    async outboxClaim(limit) {
      const rows = await db.callApi<Record<string, unknown>[]>(names.outboxClaim, systemActor, [limit], 'rows');
      return rows.map((r) => ({
        id: String(r.id),
        to: stringList(r.recipients),
        cc: stringList(r.cc),
        subject: String(r.subject ?? ''),
        text: String(r.body_text ?? ''),
        html: typeof r.body_html === 'string' ? r.body_html : null,
        attempts: Number(r.attempts ?? 0),
      }));
    },

    async outboxMarkSent(id, providerRef) {
      await db.callApi(names.outboxMarkSent, systemActor, [id, providerRef], 'none');
    },

    async outboxMarkFailed(id, error, retryAfterSec) {
      await db.callApi(names.outboxMarkFailed, systemActor, [id, error, retryAfterSec], 'none');
    },

    async resolveLogin(identity, ip, device) {
      if (names.authResolveLogin === null) return null;
      const actor = await db.callApi<unknown>(names.authResolveLogin, systemActor, [
        JSON.stringify(identity),
        ip,
        device,
      ]);
      return actor === null || actor === undefined ? null : String(actor);
    },

    async me(actor) {
      if (names.authMe === null) return undefined;
      return db.callApi(names.authMe, actor, []);
    },

    async totpSecret(actor) {
      if (names.mfaTotpSecret === null) return null;
      const secret = await db.callApi<unknown>(names.mfaTotpSecret, actor, []);
      return typeof secret === 'string' && secret !== '' ? secret : null;
    },

    importDirectory: (data) => db.callApi(names.directoryImport, systemActor, [JSON.stringify(data)]),
    importCatalog: (data) => db.callApi(names.catalogImport, systemActor, [JSON.stringify(data)]),
  };
}
