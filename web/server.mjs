#!/usr/bin/env node
// 頁面的靜態伺服器（裁決 D68）：頁面程式和後端分開部署、分開來源，「拿到後端」不等於「能改使用者看到的畫面與算挑戰值的程式」。
// 只送 web/ 底下的固定檔案；/config.js 告訴頁面後端在哪裡。每個回應都帶 CSP：程式只能從這個來源載入，
// 連線只能到這個來源與後端（connect-src）。
// 用法：node web/server.mjs（tools/run-all.sh 啟動；位址是 db/sgn.env 的 SGN_WEB_ORIGIN）
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { loadConfig } from '../db/tools/lib/env.mjs';

const config = loadConfig();
const web = new URL(config.db.SGN_WEB_ORIGIN);
const api = new URL(config.db.SGN_RP_ORIGIN).origin;
const root = import.meta.dirname;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const CSP = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self'",
    `connect-src 'self' ${api}`,
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
].join('; ');
const headers = (type) => ({
    'content-type': type,
    'cache-control': 'no-store',
    'content-security-policy': CSP,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
});
const configJs = `// 自動產生（web/server.mjs），請勿手動修改。\nexport const API_ORIGIN = ${JSON.stringify(api)};\n`;

async function respond(req, res) {
    const path = new URL(req.url ?? '/', web).pathname;
    if (req.method !== 'GET' && req.method !== 'HEAD') return notFound(res);
    if (path === '/config.js') {
        res.writeHead(200, headers(TYPES['.js']));
        return res.end(req.method === 'HEAD' ? undefined : configJs);
    }
    const file = normalize(join(root, path === '/' ? 'index.html' : decodeURIComponent(path)));
    const type = TYPES[extname(file)];
    if (!type || !file.startsWith(root + sep)) return notFound(res);
    try {
        const content = await readFile(file);
        res.writeHead(200, headers(type));
        res.end(req.method === 'HEAD' ? undefined : content);
    } catch {
        notFound(res);
    }
}

function notFound(res) {
    res.writeHead(404, headers('text/plain; charset=utf-8'));
    res.end('not found');
}

const server = createServer((req, res) => {
    respond(req, res).catch(() => notFound(res));
});
server.listen(Number(web.port), web.hostname, () => console.log(`sgn web listening on ${web.origin}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
