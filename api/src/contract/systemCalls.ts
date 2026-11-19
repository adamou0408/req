/**
 * ★ 契約檔：後端自己呼叫的 SQL function 的「參數順序」與「回傳欄位」。
 * 名稱在 sqlNames.ts。核心契約定案後，只要改這個檔裡的參數與欄位對應。
 *
 * 目前假設的簽章（都在 schema api，第一個參數都是 p_actor）：
 *   run_scheduled_jobs(p_actor)                                   returns jsonb
 *   outbox_claim(p_actor, p_limit int)                            returns table(id, recipients text[], cc text[],
 *                                                                               subject, body_text, body_html, attempts int)
 *   outbox_mark_sent(p_actor, p_id, p_provider_ref text)          returns void
 *   outbox_mark_failed(p_actor, p_id, p_error text, p_retry_after_sec int) returns void
 *   directory_import(p_actor, p_data jsonb)                       returns jsonb
 *   <errorCatalog>(p_actor)                                       returns table(code, sqlstate, http_status int, message)
 *   <authResolveLogin>(p_actor, p_identity jsonb, p_ip text, p_device text) returns actor id（找不到回 null）
 *   <authMe>(p_actor)                                             returns jsonb
 *   <authDevUsers>(p_actor)                                       returns jsonb（陣列）
 *   <mfaTotpSecret>(p_actor)                                      returns text（base32；未設定回 null）
 */
import type { Db } from '../db.ts';
import type { CatalogEntry } from '../errors.ts';
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
  importDirectory(data: unknown): Promise<unknown>;
  /** 契約沒有提供時回空陣列。 */
  errorCatalog(): Promise<CatalogEntry[]>;
  /** 回 null＝這個身分在本站沒有對應的人。 */
  resolveLogin(identity: LoginIdentity, ip: string, device: Device): Promise<string | null>;
  /** 回 null＝契約沒有提供這個 function。 */
  me(actor: string): Promise<unknown>;
  devUsers(): Promise<unknown[]>;
  totpSecret(actor: string): Promise<string | null>;
}

type Row = Record<string, unknown>;

function stringList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && x !== '');
  if (typeof v === 'string' && v !== '') return [v];
  return [];
}

function toOutboxMessage(r: Row): OutboxMessage {
  return {
    id: String(r.id),
    to: stringList(r.recipients),
    cc: stringList(r.cc),
    subject: String(r.subject ?? ''),
    text: String(r.body_text ?? ''),
    html: typeof r.body_html === 'string' ? r.body_html : null,
    attempts: Number(r.attempts ?? 0),
  };
}

function toCatalogEntry(r: Row): CatalogEntry {
  return {
    code: String(r.code),
    sqlstate: String(r.sqlstate),
    status: Number(r.http_status),
    message: String(r.message ?? ''),
  };
}

function outboxCalls(db: Db, names: SqlNames, actor: string | null) {
  return {
    async outboxClaim(limit: number): Promise<OutboxMessage[]> {
      const rows = await db.callApi<Row[]>(names.outboxClaim, actor, [limit], 'rows');
      return rows.map(toOutboxMessage);
    },
    async outboxMarkSent(id: string, providerRef: string | null): Promise<void> {
      await db.callApi(names.outboxMarkSent, actor, [id, providerRef], 'none');
    },
    async outboxMarkFailed(id: string, error: string, retryAfterSec: number): Promise<void> {
      await db.callApi(names.outboxMarkFailed, actor, [id, error, retryAfterSec], 'none');
    },
  };
}

function authCalls(db: Db, names: SqlNames, systemActor: string | null) {
  return {
    async resolveLogin(identity: LoginIdentity, ip: string, device: Device): Promise<string | null> {
      if (names.authResolveLogin === null) return null;
      const args = [JSON.stringify(identity), ip, device];
      const actor = await db.callApi<unknown>(names.authResolveLogin, systemActor, args);
      return actor === null || actor === undefined ? null : String(actor);
    },
    async me(actor: string): Promise<unknown> {
      return names.authMe === null ? null : db.callApi(names.authMe, actor, []);
    },
    async devUsers(): Promise<unknown[]> {
      if (names.authDevUsers === null) return [];
      const users = await db.callApi<unknown>(names.authDevUsers, systemActor, []);
      return Array.isArray(users) ? users : [];
    },
    async totpSecret(actor: string): Promise<string | null> {
      if (names.mfaTotpSecret === null) return null;
      const secret = await db.callApi<unknown>(names.mfaTotpSecret, actor, []);
      return typeof secret === 'string' && secret !== '' ? secret : null;
    },
  };
}

export function createSystemCalls(db: Db, names: SqlNames, systemActor: string | null): SystemCalls {
  return {
    runScheduledJobs: () => db.callApi(names.schedulerRun, systemActor, []),
    importDirectory: (data) => db.callApi(names.directoryImport, systemActor, [JSON.stringify(data)]),
    async errorCatalog() {
      if (names.errorCatalog === null) return [];
      const rows = await db.callApi<Row[]>(names.errorCatalog, systemActor, [], 'rows');
      return rows.map(toCatalogEntry);
    },
    ...outboxCalls(db, names, systemActor),
    ...authCalls(db, names, systemActor),
  };
}
