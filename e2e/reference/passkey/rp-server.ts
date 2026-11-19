// 測試用的最小 relying party：把 src/webauthn 的 PasskeyService（Node 端的通行金鑰對照實作）掛到 HTTP 上，
// 只服務一位固定的使用者（登入不在這個對照組的範圍；登入由整合者的後端負責）。
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { ChallengeRegistry } from './src/webauthn/challenge.ts';
import { CredentialStore } from './src/webauthn/store.ts';
import { PasskeyService } from './src/webauthn/service.ts';
import { WebAuthnError } from './src/webauthn/verify.ts';

const page = readFileSync(new URL('./fixture/page.html', import.meta.url));
const user = { iss: 'urn:sgn:test', sub: 'p04', uid: 'p04', name: '林怡君', email: 'p04@sim.example', groups: [] };

const PREFERRED_PORT = Number(process.env.FRONTDOOR_PORT ?? 3000);

function listen(server: Server, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
        });
    });
}

export interface RunningRp {
    origin: string;
    service: PasskeyService;
    user: typeof user;
    close(): Promise<void>;
}

async function readBody(req: import('node:http').IncomingMessage): Promise<never> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return (chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) as never;
}

export async function startRp(): Promise<RunningRp> {
    // handler 在 listen 之後才會被呼叫；origin 要等拿到埠號才知道，所以 service 之後才放進來
    const holder: { service?: PasskeyService } = {};
    const server: Server = createServer(async (req, res) => {
        const send = (status: number, body: unknown) => {
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(body));
        };
        const service = holder.service;
        if (!service) return send(503, { ok: false });
        try {
            const body = req.method === 'POST' ? await readBody(req) : ({} as never);
            switch (`${req.method} ${req.url}`) {
                case 'GET /':
                    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
                    return void res.end(page);
                case 'POST /register/options':
                    return send(200, await service.registrationOptions(user));
                case 'POST /register/verify': {
                    const credential = await service.finishRegistration(user, body);
                    return send(200, { ok: true, credentialId: credential.credentialId });
                }
                case 'POST /confirm/options':
                    return send(
                        200,
                        await service.confirmationOptions(user, (body as { binding?: Record<string, unknown> }).binding ?? {}),
                    );
                case 'POST /confirm/verify': {
                    const evidence = await service.finishConfirmation(user, body);
                    return send(evidence.result.ok ? 200 : 400, evidence.result);
                }
                default:
                    return send(404, { ok: false });
            }
        } catch (error) {
            if (error instanceof WebAuthnError) return send(400, { ok: false, code: error.code, message: error.message });
            throw error;
        }
    });
    // 優先用 3000：資料庫探針的 webauthn origin 設定是 http://localhost:3000，向量才能直接拿去驗。被占用就改用隨機埠。
    await listen(server, PREFERRED_PORT).catch(() => listen(server, 0));
    // rpId 不能是 IP，所以瀏覽器用 localhost 連（Chromium 會把 localhost 解析到 127.0.0.1）。
    const origin = `http://localhost:${(server.address() as AddressInfo).port}`;
    const service = new PasskeyService(
        { rpId: 'localhost', rpName: 'passkey reference', origin },
        new ChallengeRegistry(),
        new CredentialStore(),
    );
    holder.service = service;
    return { origin, service, user, close: () => new Promise((resolve) => server.close(() => resolve())) };
}
