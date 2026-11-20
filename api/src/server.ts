// 最薄的後端：node:http，沒有框架。不做任何業務判斷，只回 JSON（頁面由另一個來源的靜態伺服器提供，web/server.mjs；裁決 D68）：
//   /api/*    路由表（packages/contract）裡的資料庫 function，參數照名稱從 JSON 取，session 從 cookie 取
//   /auth/*   OIDC 登入、通行金鑰登記時的再驗證、登出（SSO adapter），拿到原始 ID token 交給資料庫
//   /anchors  資料庫以外的錨點檔（唯讀轉送；正式環境應由稽核人員直接向獨立存放處取得）
//   /errors   錯誤目錄的訊息（登入頁只收錯誤代碼，文字從這裡取；裁決 D71）
//   /         導回頁面的來源，只帶錯誤目錄裡有的代碼
// 跨來源：CORS 只開給頁面的來源（帶 cookie）；會改狀態的請求帶了別的 Origin 一律拒絕。
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { backendCalls, packRoutes, routes, type Call } from '@sgn/contract';
import { config } from './config.ts';
import { ApiError, Db } from './db.ts';
import { OidcClient } from './oidc.ts';

const SESSION_COOKIE = 'sid';
const FLOW_COOKIE = 'flow';
const FLOW_TTL_MS = 10 * 60 * 1000;
const MAX_BODY_BYTES = 256 * 1024;
const LOGIN_WINDOW_MS = 60 * 1000;
/** 後端自己的流程帶回頁面的提示代碼（不是錯誤，不在錯誤目錄裡）。 */
const NOTICES = new Set(['PASSKEY_REGISTERED']);

/** 進行中的 OIDC 往返：登入，或登記通行金鑰前的再驗證。只存在記憶體，十分鐘失效。 */
type Flow =
    | { kind: 'login'; challengeId: string; verifier: string; expires: number }
    | { kind: 'passkey'; challengeId: string; verifier: string; expires: number; credentialId: string; spki: string };

const db = new Db(config.dbUrl);
const oidc = new OidcClient(config.oidc);
const flows = new Map<string, Flow>();
/** 每個來源最近一分鐘開始登入的時間（D71：登入入口的速率限制；上限來自 sgn.setting，啟動時讀一次）。 */
const loginAttempts = new Map<string, number[]>();
let loginLimit = 0;
// 核心路由與各流程包的路由一律依路由表註冊；後端不知道任何流程包的內容
const apiRoutes: ReadonlyMap<string, Call> = new Map(
    [...routes, ...Object.values(packRoutes).flat()].map((r): [string, Call] => [`/api/${r.fn}`, r]),
);

function cookies(req: IncomingMessage): Map<string, string> {
    const header = req.headers.cookie ?? '';
    return new Map(
        header
            .split(';')
            .map((part) => part.trim().split('='))
            .filter((kv) => kv.length === 2)
            .map(([k, v]) => [k, decodeURIComponent(v)]),
    );
}

// maxAgeSeconds 為 null 時是瀏覽器工作階段 cookie；工作階段真正的效期由資料庫（session.ttl_seconds）決定。
function setCookie(name: string, value: string, maxAgeSeconds: number | null, sameSite: 'Strict' | 'Lax'): string {
    const age = maxAgeSeconds === null ? '' : `; Max-Age=${maxAgeSeconds}`;
    return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=${sameSite}${age}${secure}`;
}

// 開發環境是 http://localhost；正式環境（https）加上 Secure。
const secure = config.origin.protocol === 'https:' ? '; Secure' : '';

function corsHeaders(): Record<string, string> {
    return { 'access-control-allow-origin': config.webOrigin, 'access-control-allow-credentials': 'true', vary: 'Origin' };
}

function sendJson(res: ServerResponse, status: number, body: unknown, setCookies: string[] = []): void {
    res.writeHead(status, {
        ...corsHeaders(),
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'set-cookie': setCookies,
    });
    res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, err: ApiError): void {
    sendJson(res, err.status, { error: { code: err.code, message: err.message } });
}

function redirect(res: ServerResponse, location: string, setCookies: string[] = []): void {
    res.writeHead(302, { location, 'set-cookie': setCookies, 'cache-control': 'no-store' });
    res.end();
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw db.error('BAD_INPUT');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY_BYTES) throw db.error('PAYLOAD_TOO_LARGE');
        chunks.push(chunk as Buffer);
    }
    let parsed: unknown;
    try {
        parsed = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    } catch {
        throw db.error('BAD_INPUT');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw db.error('BAD_INPUT');
    return parsed as Record<string, unknown>;
}

async function handleApi(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const route = apiRoutes.get(path);
    if (!route || req.method !== 'POST') return sendError(res, db.error('NOT_FOUND'));
    const body = await readJson(req);
    const session = cookies(req).get(SESSION_COOKIE) ?? '';
    const args = route.params.map((name) => (name === 'session' ? session : (body[name] ?? null)));
    sendJson(res, 200, { result: await db.callApi(route, args) });
}

async function startFlow(res: ServerResponse, nonce: string, make: (verifier: string) => Flow): Promise<string> {
    const { url, state, verifier } = await oidc.authorize(nonce);
    flows.set(state, make(verifier));
    res.setHeader('set-cookie', setCookie(FLOW_COOKIE, state, FLOW_TTL_MS / 1000, 'Lax'));
    return url;
}

/** 同一個來源一分鐘內開始登入的次數超過上限就拒絕（在進資料庫之前）。 */
function loginAllowed(req: IncomingMessage): boolean {
    const client = req.socket.remoteAddress ?? '';
    const now = Date.now();
    const recent = (loginAttempts.get(client) ?? []).filter((t) => t > now - LOGIN_WINDOW_MS);
    if (recent.length >= loginLimit) {
        loginAttempts.set(client, recent);
        return false;
    }
    loginAttempts.set(client, [...recent, now]);
    return true;
}

async function handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!loginAllowed(req)) return sendError(res, db.error('AUTH_RATE_LIMITED'));
    const begin = (await db.callApi(backendCalls.sessionBegin, [])) as { challenge_id: string; nonce: string };
    const url = await startFlow(res, begin.nonce, (verifier) => ({
        kind: 'login',
        challengeId: begin.challenge_id,
        verifier,
        expires: Date.now() + FLOW_TTL_MS,
    }));
    redirect(res, url, [res.getHeader('set-cookie') as string]);
}

/** 登記通行金鑰：nonce 綁定挑戰值與這把公鑰（docs/handoff/probe-db-findings.md §6.2），讓使用者在身分提供者再驗證一次。 */
async function handlePasskeyStart(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    const challengeId = String(body.challenge_id ?? '');
    const challenge = Buffer.from(String(body.challenge ?? ''), 'base64url');
    const spki = String(body.spki ?? '');
    const nonce = createHash('sha256').update(challenge).update(Buffer.from(spki, 'base64url')).digest('base64url');
    const url = await startFlow(res, nonce, (verifier) => ({
        kind: 'passkey',
        challengeId,
        verifier,
        expires: Date.now() + FLOW_TTL_MS,
        credentialId: String(body.credential_id ?? ''),
        spki,
    }));
    sendJson(res, 200, { result: { redirect: url } }, [res.getHeader('set-cookie') as string]);
}

async function completeFlow(flow: Flow, idToken: string): Promise<{ location: string; cookies: string[] }> {
    if (flow.kind === 'login') {
        const opened = (await db.callApi(backendCalls.sessionOpen, [flow.challengeId, idToken])) as { session_token: string };
        return { location: '/', cookies: [setCookie(SESSION_COOKIE, opened.session_token, null, 'Strict')] };
    }
    await db.callApi(backendCalls.passkeyRegister, [flow.challengeId, idToken, flow.credentialId, flow.spki]);
    return { location: '/?notice=PASSKEY_REGISTERED', cookies: [] };
}

async function handleCallback(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const state = url.searchParams.get('state') ?? '';
    const flow = flows.get(state);
    flows.delete(state);
    const clearFlow = setCookie(FLOW_COOKIE, '', 0, 'Lax');
    // 只帶錯誤代碼回去；頁面從錯誤目錄取文字（D71：網址上的文字不能被拿來放釣魚話術）
    const fail = (err: ApiError) => redirect(res, `/?error=${encodeURIComponent(err.code)}`, [clearFlow]);
    if (!flow || flow.expires < Date.now() || cookies(req).get(FLOW_COOKIE) !== state) return fail(db.error('LOGIN_FLOW_INVALID'));
    const code = url.searchParams.get('code');
    if (!code) return fail(db.error('LOGIN_INCOMPLETE'));
    try {
        const done = await completeFlow(flow, await oidc.exchange(code, flow.verifier));
        return redirect(res, done.location, [clearFlow, ...done.cookies]);
    } catch (err) {
        if (err instanceof ApiError) return fail(err);
        throw err;
    }
}

/** 登出：先讓資料庫裡的工作階段失效（PRB-SESSION），再清掉 cookie。 */
async function handleLogout(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const result = await db.callApi(backendCalls.sessionClose, [cookies(req).get(SESSION_COOKIE) ?? '']);
    sendJson(res, 200, { result }, [setCookie(SESSION_COOKIE, '', 0, 'Strict')]);
}

/** 導回頁面的來源（登入往返、舊網址）。只帶錯誤目錄裡有的錯誤代碼、後端自己的提示代碼，其他一律丟掉。 */
function toWeb(res: ServerResponse, url: URL): void {
    const target = new URL('/', config.webOrigin);
    const error = url.searchParams.get('error') ?? '';
    const notice = url.searchParams.get('notice') ?? '';
    if (db.hasCode(error)) target.searchParams.set('error', error);
    if (NOTICES.has(notice)) target.searchParams.set('notice', notice);
    redirect(res, target.toString());
}

function serveErrors(res: ServerResponse): void {
    sendJson(res, 200, { result: db.messages() });
}

async function serveAnchors(res: ServerResponse): Promise<void> {
    const text = await readFile(config.anchorFile, 'utf8').catch(() => '');
    res.writeHead(200, { ...corsHeaders(), 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
    res.end(text);
}

/** 預檢：只回答頁面的來源。 */
function preflight(req: IncomingMessage, res: ServerResponse): void {
    if (req.headers.origin !== config.webOrigin) return sendError(res, db.error('FORBIDDEN'));
    res.writeHead(204, {
        ...corsHeaders(),
        'access-control-allow-methods': 'GET, POST',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '600',
    });
    res.end();
}

async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', config.origin);
    const path = url.pathname;
    if (req.method === 'OPTIONS') return preflight(req, res);
    // 會改狀態的請求：瀏覽器帶來的 Origin 必須是頁面的來源（沒有 Origin 的是瀏覽器以外的程式，cookie 仍是 SameSite=Strict）
    if (req.method === 'POST' && req.headers.origin !== undefined && req.headers.origin !== config.webOrigin) {
        return sendError(res, db.error('FORBIDDEN'));
    }
    if (path.startsWith('/api/')) return handleApi(req, res, path);
    if (path === '/auth/login' && req.method === 'GET') return handleLogin(req, res);
    if (path === '/auth/oidc/callback' && req.method === 'GET') return handleCallback(req, res, url);
    if (path === '/auth/passkey' && req.method === 'POST') return handlePasskeyStart(req, res);
    if (path === '/auth/logout' && req.method === 'POST') return handleLogout(req, res);
    if (path === '/anchors' && req.method === 'GET') return serveAnchors(res);
    if (path === '/errors' && req.method === 'GET') return serveErrors(res);
    if (path === '/' && req.method === 'GET') return toWeb(res, url);
    sendError(res, db.error('NOT_FOUND'));
}

const server = createServer((req, res) => {
    const started = process.hrtime.bigint();
    dispatch(req, res)
        .catch((err: unknown) => {
            if (err instanceof ApiError) return sendError(res, err);
            console.error(err);
            if (!res.headersSent) sendError(res, db.error('INTERNAL'));
        })
        .finally(() => {
            const ms = Number(process.hrtime.bigint() - started) / 1e6;
            console.log(`${req.method} ${(req.url ?? '').split('?')[0]} ${res.statusCode} ${ms.toFixed(1)}ms`);
        });
});

setInterval(() => {
    const now = Date.now();
    for (const [state, flow] of flows) if (flow.expires < now) flows.delete(state);
    for (const [client, times] of loginAttempts) if (times.every((t) => t <= now - LOGIN_WINDOW_MS)) loginAttempts.delete(client);
}, 60_000).unref();

await db.loadErrorCatalog();
loginLimit = ((await db.callApi(backendCalls.frontdoorPolicy, [])) as { login_attempts_per_minute: number }).login_attempts_per_minute;
server.listen(config.listenPort, config.listenHost, () => {
    console.log(`sgn api listening on ${config.origin.origin}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
        server.close();
        void db.close().then(() => process.exit(0));
    });
}
