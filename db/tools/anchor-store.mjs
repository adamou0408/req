#!/usr/bin/env node
// 錨點存放處（裁決 D81 (4)；紅隊第四輪 中-4）：和後端不同的來源（SGN_ANCHOR_ORIGIN）、不同的程序與作業系統帳號（sgn-anchor-store）。
// 稽核頁與離線驗證工具直接向這裡取錨點，不經後端；後端主機上的人（B）改不了這裡的檔案、也換不了回應。
//   GET  /anchors   全部錨點（JSON 陣列）；CORS 只開給頁面的來源
//   POST /anchors   錨定程式（db/tools/anchor.mjs）寫入一個新錨點；要寫入金鑰（這裡只存它的 SHA-256）
// 只增不改：新的錨點序號要比最後一個大，而且大於 0（裁決 D84 (7)）。第五輪之前「程式指紋改變」時序號可以變小，拿到寫入金鑰的人
// 就能寫 0 號錨點讓錨定停擺（redteam/exploits/41）；現在程式指紋改變也要等鏈上有新的事件才寫得進新錨點。
// 資料檔是 .run/anchors-<端對端資料庫>.jsonl，擁有者是這個程式的帳號（db/tools/provision-secrets.mjs）。
// 用法：node db/tools/anchor-store.mjs（tools/run-all.sh 以 sgn-anchor-store 帳號啟動）
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { anchorFileStore } from './chain-lib.mjs';
import { anchorFile, loadProgramConfig } from './lib/env.mjs';

const config = loadProgramConfig('anchor-store');
const origin = new URL(config.db.SGN_ANCHOR_ORIGIN);
const webOrigin = new URL(config.db.SGN_WEB_ORIGIN).origin;
const store = anchorFileStore(anchorFile(config, config.db.SGN_DB_E2E));
const keyHash = Buffer.from(config.secret.SGN_ANCHOR_WRITE_KEY_SHA256, 'hex');
const MAX_BODY = 16 * 1024;

const headers = (type = 'application/json; charset=utf-8') => ({
    'content-type': type,
    'cache-control': 'no-store',
    'access-control-allow-origin': webOrigin,
    'x-content-type-options': 'nosniff',
});

function authorized(req) {
    const m = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
    if (!m) return false;
    return timingSafeEqual(createHash('sha256').update(m[1]).digest(), keyHash);
}

function valid(a) {
    return (
        a !== null &&
        typeof a === 'object' &&
        Number.isInteger(a.seq) &&
        a.seq > 0 &&
        /^[0-9a-f]{64}$/.test(a.hash) &&
        typeof a.code_fingerprint === 'string' &&
        typeof a.anchored_at === 'string' &&
        typeof a.label === 'string'
    );
}

async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) throw new Error('too large');
        chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function reply(res, status, body) {
    res.writeHead(status, headers());
    res.end(JSON.stringify(body));
}

async function handle(req, res) {
    const path = new URL(req.url ?? '/', origin).pathname;
    if (path !== '/anchors') return reply(res, 404, { error: 'not_found' });
    if (req.method === 'GET') return reply(res, 200, await store.read());
    if (req.method !== 'POST') return reply(res, 405, { error: 'method' });
    if (!authorized(req)) return reply(res, 401, { error: 'unauthorized' });
    const anchor = await readJson(req).catch(() => null);
    if (!valid(anchor)) return reply(res, 422, { error: 'invalid_anchor' });
    const last = (await store.read()).at(-1);
    if (last && !(anchor.seq > last.seq)) {
        return reply(res, 409, { error: 'not_newer', last_seq: last.seq });
    }
    await store.append(anchor);
    return reply(res, 201, { appended: anchor.seq });
}

const server = createServer((req, res) => {
    handle(req, res).catch(() => reply(res, 500, { error: 'internal' }));
});
server.listen(Number(origin.port), origin.hostname, () => console.log(`sgn anchor store listening on ${origin.origin}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
