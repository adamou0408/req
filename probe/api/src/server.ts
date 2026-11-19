// 最薄的後端：node:http，沒有框架。
// 路由：登入（OIDC）、/auth/me、通行金鑰的註冊與確認、證據匯出，以及 probe/web 的靜態檔。
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, type AppConfig } from './config.ts';
import { OidcClient, OidcError, type IdTokenClaims } from './oidc.ts';
import { SessionStore, type Session, type SessionUser } from './session.ts';
import { ChallengeRegistry } from './webauthn/challenge.ts';
import { CredentialStore } from './webauthn/store.ts';
import { PasskeyService, userKeyOf } from './webauthn/service.ts';
import { WebAuthnError } from './webauthn/verify.ts';

const COOKIE = 'probe_sid';
const MAX_BODY_BYTES = 64 * 1024;
const STATIC_FILES: Record<string, string> = {
    '/': 'index.html',
    '/app.js': 'app.js',
    '/api.js': 'api.js',
    '/i18n.js': 'i18n.js',
    '/style.css': 'style.css',
};
const CONTENT_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
};

class HttpError extends Error {
    readonly status: number;
    readonly code: string;
    constructor(status: number, code: string, message: string) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

interface Context {
    req: IncomingMessage;
    res: ServerResponse;
    url: URL;
    session?: Session;
}

type Handler = (ctx: Context) => Promise<void>;

function readCookie(req: IncomingMessage, name: string): string | undefined {
    for (const part of (req.headers.cookie ?? '').split(';')) {
        const [key, ...rest] = part.trim().split('=');
        if (key === name) return rest.join('=');
    }
    return undefined;
}

function setSessionCookie(res: ServerResponse, value: string, maxAgeSeconds: number): void {
    // httpOnly：前端程式讀不到；SameSite=Lax：從 IdP 轉回 callback（頂層 GET）時仍會帶上。
    res.setHeader('set-cookie', `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
}

function redirect(res: ServerResponse, location: string): void {
    res.writeHead(302, { location, 'cache-control': 'no-store' });
    res.end();
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY_BYTES) throw new HttpError(413, 'BODY_TOO_LARGE', '請求內容太大');
        chunks.push(chunk as Buffer);
    }
    if (size === 0) return {};
    try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
        // 落到下面的錯誤。
    }
    throw new HttpError(400, 'BODY_MALFORMED', '請求內容不是 JSON 物件');
}

function toUser(claims: IdTokenClaims): SessionUser {
    return {
        iss: claims.iss,
        sub: claims.sub,
        uid: claims.federated_claims?.user_id ?? claims.preferred_username ?? '',
        name: claims.name ?? '',
        email: claims.email ?? '',
        groups: claims.groups ?? [],
    };
}

export function createApp(config: AppConfig) {
    const oidc = new OidcClient(config.oidc);
    const sessions = new SessionStore();
    const passkeys = new PasskeyService(
        { rpId: config.rpId, rpName: config.rpName, origin: config.origin },
        new ChallengeRegistry(),
        new CredentialStore(),
    );

    function requireUser(ctx: Context): SessionUser {
        const user = ctx.session?.user;
        if (!user) throw new HttpError(401, 'NOT_LOGGED_IN', '請先登入');
        return user;
    }

    /** 會改變狀態的請求只接受同源的 JSON（擋 CSRF）。 */
    function requireSameOrigin(ctx: Context): void {
        if (ctx.req.headers.origin !== config.origin) throw new HttpError(403, 'ORIGIN_REJECTED', '請求來源不符');
        if (!(ctx.req.headers['content-type'] ?? '').startsWith('application/json')) {
            throw new HttpError(415, 'CONTENT_TYPE', '只接受 application/json');
        }
    }

    const routes: Record<string, Handler> = {
        'GET /auth/login': async (ctx) => {
            const session = ctx.session ?? sessions.create();
            const { url, pending } = await oidc.beginLogin();
            session.pendingLogin = pending;
            setSessionCookie(ctx.res, session.id, 3600);
            redirect(ctx.res, url);
        },
        'GET /auth/oidc/callback': async (ctx) => {
            const pending = ctx.session && sessions.takePendingLogin(ctx.session);
            if (!ctx.session || !pending) throw new HttpError(400, 'LOGIN_NOT_STARTED', '登入流程已失效，請重新登入');
            const { claims } = await oidc.finishLogin(ctx.url.searchParams, pending);
            const session = sessions.promote(ctx.session, toUser(claims));
            setSessionCookie(ctx.res, session.id, 3600);
            redirect(ctx.res, '/');
        },
        'POST /auth/logout': async (ctx) => {
            requireSameOrigin(ctx);
            if (ctx.session) sessions.destroy(ctx.session.id);
            setSessionCookie(ctx.res, '', 0);
            sendJson(ctx.res, 200, { ok: true });
        },
        'GET /auth/me': async (ctx) => {
            const user = requireUser(ctx);
            sendJson(ctx.res, 200, { ...user, passkeys: passkeys.store.forUser(userKeyOf(user)).length });
        },
        'POST /webauthn/register/options': async (ctx) => {
            requireSameOrigin(ctx);
            sendJson(ctx.res, 200, await passkeys.registrationOptions(requireUser(ctx)));
        },
        'POST /webauthn/register/verify': async (ctx) => {
            requireSameOrigin(ctx);
            const user = requireUser(ctx);
            const credential = await passkeys.finishRegistration(user, (await readJson(ctx.req)) as never);
            sendJson(ctx.res, 200, { ok: true, credentialId: credential.credentialId, alg: credential.alg });
        },
        'POST /webauthn/confirm/options': async (ctx) => {
            requireSameOrigin(ctx);
            const user = requireUser(ctx);
            const body = await readJson(ctx.req);
            const binding = body.binding && typeof body.binding === 'object' ? (body.binding as Record<string, unknown>) : {};
            sendJson(ctx.res, 200, await passkeys.confirmationOptions(user, binding));
        },
        'POST /webauthn/confirm/verify': async (ctx) => {
            requireSameOrigin(ctx);
            const user = requireUser(ctx);
            const evidence = await passkeys.finishConfirmation(user, (await readJson(ctx.req)) as never);
            sendJson(ctx.res, evidence.result.ok ? 200 : 400, { ...evidence.result, binding: evidence.binding });
        },
        'GET /webauthn/evidence': async (ctx) => {
            const user = requireUser(ctx);
            sendJson(ctx.res, 200, { rpId: config.rpId, origin: config.origin, ...passkeys.store.exportFor(userKeyOf(user)) });
        },
    };

    async function serveStatic(ctx: Context): Promise<boolean> {
        const file = ctx.req.method === 'GET' ? STATIC_FILES[ctx.url.pathname] : undefined;
        if (!file) return false;
        const body = await readFile(path.join(config.webDir, file));
        ctx.res.writeHead(200, { 'content-type': CONTENT_TYPES[path.extname(file)], 'cache-control': 'no-store' });
        ctx.res.end(body);
        return true;
    }

    return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const ctx: Context = { req, res, url: new URL(req.url ?? '/', config.origin), session: sessions.get(readCookie(req, COOKIE)) };
        try {
            const route = routes[`${req.method} ${ctx.url.pathname}`];
            if (route) await route(ctx);
            else if (!(await serveStatic(ctx))) throw new HttpError(404, 'NOT_FOUND', '找不到這個位址');
        } catch (error) {
            if (error instanceof HttpError) sendJson(res, error.status, { ok: false, code: error.code, message: error.message });
            else if (error instanceof WebAuthnError) sendJson(res, 400, { ok: false, code: error.code, message: error.message });
            else if (error instanceof OidcError) sendJson(res, 400, { ok: false, code: 'LOGIN_FAILED', message: error.message });
            else {
                console.error(error);
                sendJson(res, 500, { ok: false, code: 'INTERNAL', message: '伺服器發生錯誤' });
            }
        }
    };
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const config = loadConfig();
    createServer(createApp(config)).listen(config.port, '127.0.0.1', () => {
        console.log(`probe api 在 ${config.origin}（rpId=${config.rpId}）`);
    });
}
