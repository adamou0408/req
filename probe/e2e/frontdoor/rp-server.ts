// 測試用的最小 relying party：把 probe/api/src/frontdoor 的 PasskeyService 掛到 HTTP 上，
// 只服務一位固定的使用者（登入不在這個對照組的範圍；登入由整合者的後端負責）。
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { ChallengeRegistry } from '../../api/src/frontdoor/webauthn/challenge.ts';
import { CredentialStore } from '../../api/src/frontdoor/webauthn/store.ts';
import { PasskeyService } from '../../api/src/frontdoor/webauthn/service.ts';
import { WebAuthnError } from '../../api/src/frontdoor/webauthn/verify.ts';

const page = readFileSync(new URL('./fixture/page.html', import.meta.url));
const user = { iss: 'urn:probe:test', sub: 'p04', uid: 'p04', name: '林怡君', email: 'p04@sim.example', groups: [] };

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
    let origin = '';
    let service!: PasskeyService;
    const server: Server = createServer(async (req, res) => {
        const send = (status: number, body: unknown) => {
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(body));
        };
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
                    return send(200, await service.confirmationOptions(user, (body as { binding?: Record<string, unknown> }).binding ?? {}));
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
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    // rpId 不能是 IP，所以瀏覽器用 localhost 連（Chromium 會把 localhost 解析到 127.0.0.1）。
    origin = `http://localhost:${(server.address() as AddressInfo).port}`;
    service = new PasskeyService({ rpId: 'localhost', rpName: 'probe frontdoor', origin }, new ChallengeRegistry(), new CredentialStore());
    return { origin, service, user, close: () => new Promise((resolve) => server.close(() => resolve())) };
}
