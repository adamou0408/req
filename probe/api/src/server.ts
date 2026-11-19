// 最薄的後端：node:http，沒有框架。不做任何業務判斷：
//   /auth/*   OIDC 登入與通行金鑰登記時的再驗證（SSO adapter），拿到原始 ID token 交給資料庫
//   /api/*    路由表裡的資料庫 function，參數照名稱從 JSON 取，session 從 cookie 取
//   /anchors  資料庫以外的錨點檔（唯讀轉送；正式環境應由稽核人員直接向獨立存放處取得）
//   其他      probe/web 的靜態檔
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { config } from './config.ts';
import { ApiError, Db } from './db.ts';
import { OidcClient } from './oidc.ts';
import { routes } from './routes.ts';

const SESSION_COOKIE = 'sid';
const FLOW_COOKIE = 'flow';
const FLOW_TTL_MS = 10 * 60 * 1000;
const MAX_BODY_BYTES = 256 * 1024;
const CONTENT_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
};

/** 進行中的 OIDC 往返：登入，或登記通行金鑰前的再驗證。只存在記憶體，十分鐘失效。 */
type Flow =
    | { kind: 'login'; challengeId: string; verifier: string; expires: number }
    | { kind: 'passkey'; challengeId: string; verifier: string; expires: number; credentialId: string; spki: string };

const db = new Db(config.dbUrl);
const oidc = new OidcClient(config.oidc);
const flows = new Map<string, Flow>();

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
    return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=${sameSite}${age}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
}

function redirect(res: ServerResponse, location: string, setCookies: string[] = []): void {
    res.writeHead(302, { location, 'set-cookie': setCookies, 'cache-control': 'no-store' });
    res.end();
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
        throw new ApiError('BAD_INPUT', 415, '請求格式必須是 JSON');
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY_BYTES) throw new ApiError('BAD_INPUT', 413, '請求太大');
        chunks.push(chunk as Buffer);
    }
    const parsed: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new ApiError('BAD_INPUT', 400, '請求格式必須是 JSON 物件');
    }
    return parsed as Record<string, unknown>;
}

async function handleApi(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const route = routes.get(path);
    if (!route || req.method !== 'POST') return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '沒有這個功能' } });
    const body = await readJson(req);
    const session = cookies(req).get(SESSION_COOKIE) ?? '';
    const args = route.params.map((name) => (name === 'session' ? session : (body[name] ?? null)));
    sendJson(res, 200, { result: await db.call(route, args) });
}

async function startFlow(res: ServerResponse, nonce: string, make: (verifier: string) => Flow): Promise<string> {
    const { url, state, verifier } = await oidc.authorize(nonce);
    flows.set(state, make(verifier));
    res.setHeader('set-cookie', setCookie(FLOW_COOKIE, state, FLOW_TTL_MS / 1000, 'Lax'));
    return url;
}

async function handleLogin(res: ServerResponse): Promise<void> {
    const begin = (await db.call({ fn: 'api.session_begin', params: [], result: 'row' }, [])) as {
        challenge_id: string;
        nonce: string;
    };
    const url = await startFlow(res, begin.nonce, (verifier) => ({
        kind: 'login',
        challengeId: begin.challenge_id,
        verifier,
        expires: Date.now() + FLOW_TTL_MS,
    }));
    redirect(res, url, [res.getHeader('set-cookie') as string]);
}

/** 登記通行金鑰：nonce 綁定挑戰值與這把公鑰（db-findings §6.2），讓使用者在身分提供者再驗證一次。 */
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
    sendJson(res, 200, { result: { redirect: url } });
}

async function handleCallback(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const state = url.searchParams.get('state') ?? '';
    const flow = flows.get(state);
    flows.delete(state);
    const clearFlow = setCookie(FLOW_COOKIE, '', 0, 'Lax');
    if (!flow || flow.expires < Date.now() || cookies(req).get(FLOW_COOKIE) !== state) {
        return redirect(res, '/?error=FLOW_INVALID', [clearFlow]);
    }
    const code = url.searchParams.get('code');
    if (!code) return redirect(res, '/?error=LOGIN_CANCELLED', [clearFlow]);
    const idToken = await oidc.exchange(code, flow.verifier);
    try {
        if (flow.kind === 'login') {
            const opened = (await db.call({ fn: 'api.session_open', params: [], result: 'row' }, [flow.challengeId, idToken])) as {
                session_token: string;
            };
            return redirect(res, '/', [clearFlow, setCookie(SESSION_COOKIE, opened.session_token, null, 'Strict')]);
        }
        await db.call({ fn: 'api.passkey_register', params: [], result: 'value' }, [
            flow.challengeId,
            idToken,
            flow.credentialId,
            flow.spki,
        ]);
        return redirect(res, '/?notice=PASSKEY_REGISTERED', [clearFlow]);
    } catch (err) {
        if (err instanceof ApiError) return redirect(res, `/?error=${encodeURIComponent(err.code)}`, [clearFlow]);
        throw err;
    }
}

async function serveStatic(res: ServerResponse, path: string): Promise<void> {
    const file = normalize(path === '/' ? '/index.html' : path);
    const type = CONTENT_TYPES[extname(file)];
    if (!type || file.includes('..')) return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '找不到' } });
    try {
        const content = await readFile(join(config.webDir, file));
        res.writeHead(200, {
            'content-type': type,
            'cache-control': 'no-store',
            'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
        });
        res.end(content);
    } catch {
        sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '找不到' } });
    }
}

async function serveAnchors(res: ServerResponse): Promise<void> {
    const text = await readFile(config.anchorFile, 'utf8').catch(() => '');
    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
    res.end(text);
}

async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', config.origin);
    const path = url.pathname;
    if (path.startsWith('/api/')) return handleApi(req, res, path);
    if (path === '/auth/login' && req.method === 'GET') return handleLogin(res);
    if (path === '/auth/oidc/callback' && req.method === 'GET') return handleCallback(req, res, url);
    if (path === '/auth/passkey' && req.method === 'POST') return handlePasskeyStart(req, res);
    if (path === '/auth/logout' && req.method === 'POST') {
        res.setHeader('set-cookie', setCookie(SESSION_COOKIE, '', 0, 'Strict'));
        return sendJson(res, 200, { result: null });
    }
    if (path === '/anchors' && req.method === 'GET') return serveAnchors(res);
    if (req.method === 'GET') return serveStatic(res, path);
    sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '找不到' } });
}

const server = createServer((req, res) => {
    const started = process.hrtime.bigint();
    dispatch(req, res)
        .catch((err: unknown) => {
            if (err instanceof ApiError) return sendJson(res, err.status, { error: { code: err.code, message: err.message } });
            if (err instanceof SyntaxError) return sendJson(res, 400, { error: { code: 'BAD_INPUT', message: '請求格式不正確' } });
            console.error(err);
            if (!res.headersSent) sendJson(res, 500, { error: { code: 'INTERNAL', message: '系統發生錯誤，請稍後再試' } });
        })
        .finally(() => {
            const ms = Number(process.hrtime.bigint() - started) / 1e6;
            console.log(`${req.method} ${(req.url ?? '').split('?')[0]} ${res.statusCode} ${ms.toFixed(1)}ms`);
        });
});

setInterval(() => {
    const now = Date.now();
    for (const [state, flow] of flows) if (flow.expires < now) flows.delete(state);
}, 60_000).unref();

await db.loadErrorCatalog();
server.listen(config.listenPort, config.listenHost, () => {
    console.log(`probe api listening on ${config.origin.origin}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
        server.close();
        void db.close().then(() => process.exit(0));
    });
}
