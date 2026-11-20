// HTTP 端點。路徑前綴 /v1 是正式（合成）資料，/masked/v1 是遮罩資料；兩者端點相同，另外遮罩環境多一個沙箱。
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { applyRuleSet, ApplyConflict, listRuleSets, withdrawRules, WithdrawNotFound } from './apply.ts';
import { backdoor, BackdoorError } from './backdoor.ts';
import type { ClientConfig, Config, Scope } from './config.ts';
import { withTx, type Env } from './db.ts';
import { reconciliationReport } from './reconcile.ts';
import { principalIdValid } from './roles.ts';
import { caseNoValid, parseRuleSet, RuleSetError } from './ruleset.ts';
import { runSandbox, SandboxError } from './sandbox.ts';
import { SIGNATURE_HEADER, SignatureError, verifyRequest, type TrustedKeys } from './signature.ts';
import { parseTestQuery, QueryError, runTestQuery, type TestQueryResult } from './testQuery.ts';

const MAX_BODY = 1024 * 1024;

class HttpError extends Error {
    readonly status: number;
    readonly code: string;
    constructor(status: number, code: string, message: string) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

interface Ctx {
    readonly req: IncomingMessage;
    readonly env: Env;
    readonly path: string;
    readonly query: URLSearchParams;
    readonly body: Buffer;
    readonly client: ClientConfig;
}

function digest(s: string): Buffer {
    return createHash('sha256').update(s).digest();
}

function authenticate(clients: readonly ClientConfig[], header: string | undefined): ClientConfig {
    const m = /^Bearer (\S+)$/.exec(header ?? '');
    if (m === null || m[1] === undefined) throw new HttpError(401, 'unauthenticated', '需要 Authorization: Bearer <金鑰>');
    const given = digest(m[1]);
    const client = clients.find((c) => timingSafeEqual(digest(c.key), given));
    if (client === undefined) throw new HttpError(401, 'unauthenticated', '金鑰不正確');
    return client;
}

function requireScope(ctx: Ctx, scope: Scope): void {
    if (!ctx.client.scopes.includes(scope)) throw new HttpError(403, 'forbidden', `呼叫方 ${ctx.client.name} 沒有 ${scope}`);
}

function json(body: Buffer): unknown {
    try {
        return JSON.parse(body.toString('utf8'));
    } catch {
        throw new HttpError(400, 'invalid_json', '本文不是 JSON');
    }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        const b = chunk as Buffer;
        size += b.length;
        if (size > MAX_BODY) throw new HttpError(413, 'too_large', '本文超過 1 MiB');
        chunks.push(b);
    }
    return Buffer.concat(chunks);
}

function signedBy(ctx: Ctx, keys: TrustedKeys): string {
    try {
        return verifyRequest(keys, ctx.req.headers[SIGNATURE_HEADER] as string | undefined, ctx.body);
    } catch (err) {
        if (err instanceof SignatureError) throw new HttpError(401, 'signature_invalid', err.message);
        throw err;
    }
}

function caseNoOf(path: string): string {
    const raw = decodeURIComponent(path.slice('/rule-sets/'.length));
    if (!caseNoValid(raw)) throw new HttpError(400, 'invalid_case_no', 'case_no 格式不符');
    return raw;
}

async function putRuleSet(ctx: Ctx, config: Config, keys: TrustedKeys): Promise<unknown> {
    requireScope(ctx, 'rules.write');
    const keyId = signedBy(ctx, keys);
    const rs = parseRuleSet(json(ctx.body), config.systems);
    if (rs.case_no !== caseNoOf(ctx.path)) throw new HttpError(422, 'case_no_mismatch', '路徑的 case_no 與本文不同');
    const requestId = (ctx.req.headers['x-request-id'] as string | undefined) ?? null;
    const result = await withTx(ctx.env, (db) => applyRuleSet(db, ctx.env.config.rolePrefix, rs, { keyId, requestId }));
    return { status: result.status, dc_ref: result.dc_ref };
}

async function deleteRuleSet(ctx: Ctx, keys: TrustedKeys): Promise<unknown> {
    requireScope(ctx, 'rules.write');
    signedBy(ctx, keys);
    const body = json(ctx.body) as { request_id?: unknown; case_no?: unknown; rule_ids?: unknown };
    if (typeof body.request_id !== 'string' || body.request_id === '') throw new HttpError(422, 'invalid_request', 'request_id 必須是字串');
    if (body.case_no !== caseNoOf(ctx.path)) throw new HttpError(422, 'case_no_mismatch', '路徑的 case_no 與本文不同');
    const ids = body.rule_ids ?? null;
    if (ids !== null && (!Array.isArray(ids) || ids.length === 0 || ids.some((x) => typeof x !== 'string'))) {
        throw new HttpError(422, 'invalid_request', 'rule_ids 必須是非空的字串陣列或省略');
    }
    const req = { request_id: body.request_id, case_no: body.case_no, rule_ids: ids as string[] | null };
    return withTx(ctx.env, (db) => withdrawRules(db, ctx.env.config.rolePrefix, req));
}

function principalOf(v: unknown): string {
    const id = typeof v === 'number' ? String(v) : v;
    if (typeof id !== 'string' || !principalIdValid(id)) throw new HttpError(422, 'invalid_request', 'principal_id 必須是 UUID 或正整數');
    return id;
}

async function testQuery(ctx: Ctx): Promise<TestQueryResult> {
    requireScope(ctx, 'test_query');
    const body = json(ctx.body) as { principal_id?: unknown; query?: unknown; probe_missing_row?: unknown };
    const principal = principalOf(body.principal_id);
    return runTestQuery(ctx.env, principal, parseTestQuery(body.query), { probe: body.probe_missing_row === true });
}

// 02 §8.5 的 verify_request → verify_result。沒有符合的資料列時插入測試列（見 handoff 的「與契約不同」）。
async function verify(ctx: Ctx): Promise<unknown> {
    requireScope(ctx, 'test_query');
    const body = json(ctx.body) as { rule_set?: { grantee?: { principal_id?: unknown } }; cases?: unknown };
    const principal = principalOf(body.rule_set?.grantee?.principal_id);
    if (!Array.isArray(body.cases)) throw new HttpError(422, 'invalid_request', 'cases 必須是陣列');
    const results = [];
    for (const c of body.cases as { code?: unknown; query?: unknown }[]) {
        const code = typeof c.code === 'string' ? c.code : null;
        try {
            const r = await runTestQuery(ctx.env, principal, parseTestQuery(c.query), { probe: true });
            results.push({
                code,
                actual: r.decision === 'allow' ? 'allow' : 'deny',
                reason: r.reason,
                detail: { db_role: r.db_role, rows_matching: r.rows_matching, rows_visible: r.rows_visible, row_source: r.row_source },
            });
        } catch (err) {
            if (!(err instanceof QueryError)) throw err;
            results.push({ code, actual: 'error', reason: err.message, detail: null });
        }
    }
    return { status: 'completed', results };
}

async function reconciliation(ctx: Ctx): Promise<unknown> {
    requireScope(ctx, 'reconcile.read');
    return withTx(
        ctx.env,
        async (db) => {
            const today = (await db.query<{ d: string }>('select current_date::text as d')).rows[0]?.d ?? '';
            const report = await reconciliationReport(db, today);
            // ?exclude_inactive=1：去掉今天不在授權起迄內的規則（權限還在目錄上，但列層級安全已經不放行任何一列）
            if (ctx.query.get('exclude_inactive') !== '1') return report;
            return { ...report, items: report.items.filter((i) => i.properties['effective_now'] !== false) };
        },
        { rollback: true },
    );
}

async function route(ctx: Ctx, config: Config, keys: TrustedKeys): Promise<[number, unknown]> {
    const { path } = ctx;
    const method = ctx.req.method ?? 'GET';
    if (path.startsWith('/rule-sets/') && method === 'PUT') return [200, await putRuleSet(ctx, config, keys)];
    if (path.startsWith('/rule-sets/') && method === 'DELETE') return [200, await deleteRuleSet(ctx, keys)];
    if (path === '/rule-sets' && method === 'GET') {
        requireScope(ctx, 'rules.read');
        return [200, { rule_sets: await withTx(ctx.env, (db) => listRuleSets(db, null)) }];
    }
    if (path.startsWith('/rule-sets/') && method === 'GET') {
        requireScope(ctx, 'rules.read');
        const found = await withTx(ctx.env, (db) => listRuleSets(db, caseNoOf(path)));
        if (found.length === 0) throw new HttpError(404, 'not_found', '沒有這張單的規則');
        return [200, found[0]];
    }
    if (path === '/test-queries' && method === 'POST') return [200, await verify(ctx)];
    if (path === '/test-query' && method === 'POST') return [200, await testQuery(ctx)];
    if (path === '/reconciliation' && method === 'GET') return [200, await reconciliation(ctx)];
    if (path === '/sandbox/runs' && method === 'POST') {
        requireScope(ctx, 'sandbox.run');
        return [200, await runSandbox(ctx.env, config.sandboxRole, json(ctx.body))];
    }
    if (path.startsWith('/admin/') && method === 'POST') {
        if (!config.backdoor) throw new HttpError(404, 'not_found', '管理後門沒有開啟');
        requireScope(ctx, 'admin.backdoor');
        const op = path.slice('/admin/'.length);
        const body = (ctx.body.length === 0 ? {} : json(ctx.body)) as Record<string, unknown>;
        return [
            200,
            {
                test_only_backdoor: true,
                ...(await withTx(ctx.env, async (db) => ({ result: await backdoor(db, ctx.env.config.rolePrefix, op, body) }))),
            },
        ];
    }
    throw new HttpError(404, 'not_found', '沒有這個端點');
}

function toHttpError(err: unknown): HttpError {
    if (err instanceof HttpError) return err;
    if (err instanceof RuleSetError || err instanceof QueryError || err instanceof BackdoorError || err instanceof SandboxError) {
        return new HttpError(422, 'invalid_request', err.message);
    }
    if (err instanceof ApplyConflict) return new HttpError(409, 'conflict', err.message);
    if (err instanceof WithdrawNotFound) return new HttpError(404, 'not_found', err.message);
    return new HttpError(500, 'internal_error', err instanceof Error ? err.message : String(err));
}

function send(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
    res.end(text);
}

async function logCall(env: Env, client: string | null, method: string, path: string, status: number, note: string | null): Promise<void> {
    await env.pool
        .query('insert into simdc_meta.call_log (client, method, path, status, note) values ($1, $2, $3, $4, $5)', [
            client,
            method,
            path,
            status,
            note,
        ])
        .catch(() => undefined);
}

async function health(envs: readonly Env[]): Promise<unknown> {
    const out: Record<string, string> = {};
    for (const env of envs) {
        const r = await env.pool.query<{ d: string }>('select current_database() as d');
        out[env.config.name] = r.rows[0]?.d ?? '';
    }
    return { status: 'ok', databases: out };
}

export function createDcServer(config: Config, envs: readonly Env[], keys: TrustedKeys): Server {
    return createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://sim-dc');
        const env = [...envs]
            .sort((a, b) => b.config.basePath.length - a.config.basePath.length)
            .find((e) => url.pathname.startsWith(`${e.config.basePath}/`));
        void (async () => {
            if (url.pathname === '/health' && req.method === 'GET') {
                send(res, 200, await health(envs));
                return;
            }
            let client: ClientConfig | null = null;
            try {
                if (env === undefined) throw new HttpError(404, 'not_found', '路徑要以 /v1/ 或 /masked/v1/ 開頭');
                client = authenticate(config.clients, req.headers.authorization);
                const body = await readBody(req);
                const ctx: Ctx = { req, env, body, client, query: url.searchParams, path: url.pathname.slice(env.config.basePath.length) };
                const [status, payload] = await route(ctx, config, keys);
                send(res, status, payload);
                await logCall(env, client.name, req.method ?? '', url.pathname, status, null);
            } catch (err) {
                const e = toHttpError(err);
                send(res, e.status, { status: 'failed', code: e.code, error: e.message });
                if (env !== undefined) await logCall(env, client?.name ?? null, req.method ?? '', url.pathname, e.status, e.message);
            }
        })().catch((err: unknown) => {
            if (!res.headersSent) send(res, 500, { status: 'failed', code: 'internal_error', error: String(err) });
        });
    });
}
