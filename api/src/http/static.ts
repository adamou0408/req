/**
 * 正式模式：由後端直接提供前端 build 出來的靜態檔（WEB_DIST），並做 SPA fallback。
 * 只處理 GET／HEAD；API_PREFIX 與 /healthz 底下的路徑不會落到這裡。
 */
import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
};

export interface StaticSite {
  /** 回 true＝已經處理（送出檔案或 index.html）；false＝這裡沒有東西可以給。 */
  serve(req: FastifyRequest, reply: FastifyReply): Promise<boolean>;
}

/** 啟動時就檢查目錄與 index.html，找不到直接報錯。 */
export function createStaticSite(webDist: string): StaticSite {
  const resolved = path.resolve(webDist);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error(`WEB_DIST 指到的目錄不存在：${resolved}`);
  }
  const root = realpathSync(resolved);
  const indexFile = path.join(root, 'index.html');
  if (!existsSync(indexFile)) throw new Error(`WEB_DIST 裡找不到 index.html：${root}`);

  /**
   * 把網址路徑對到 root 底下的實體檔案。
   * 回 null＝沒有這個檔案；回 'rejected'＝路徑可疑（..、隱藏檔、跳出 root 的連結），連 SPA fallback 都不給。
   */
  async function locate(urlPath: string): Promise<{ file: string; size: number; mtimeMs: number } | 'rejected' | null> {
    let decoded: string;
    try {
      decoded = decodeURIComponent(urlPath);
    } catch {
      return 'rejected';
    }
    if (decoded.includes('\0') || decoded.includes('\\')) return 'rejected';
    const segments = decoded.split('/').filter((s) => s !== '');
    // 不給 ..，也不給隱藏檔（.env、.git…）。
    if (segments.some((s) => s === '..' || (s.startsWith('.') && s !== '.well-known'))) return 'rejected';
    if (segments.length === 0) return null;
    const candidate = path.join(root, ...segments);
    try {
      // 解開符號連結後還必須在 root 底下。
      const real = await realpath(candidate);
      if (real !== root && !real.startsWith(root + path.sep)) return 'rejected';
      const info = await stat(real);
      if (!info.isFile()) return null;
      return { file: real, size: info.size, mtimeMs: info.mtimeMs };
    } catch {
      return null;
    }
  }

  function send(
    req: FastifyRequest,
    reply: FastifyReply,
    found: { file: string; size: number; mtimeMs: number },
    cacheControl: string,
  ): void {
    const etag = `W/"${found.size.toString(16)}-${Math.floor(found.mtimeMs).toString(16)}"`;
    reply.header('cache-control', cacheControl).header('etag', etag);
    if (req.headers['if-none-match'] === etag) {
      reply.code(304).send();
      return;
    }
    reply
      .code(200)
      .type(MIME[path.extname(found.file).toLowerCase()] ?? 'application/octet-stream')
      .header('content-length', found.size);
    if (req.method === 'HEAD') {
      reply.send();
      return;
    }
    reply.send(createReadStream(found.file));
  }

  return {
    async serve(req, reply) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return false;
      const urlPath = (req.url.split('?')[0] ?? '/').split('#')[0] ?? '/';
      const found = await locate(urlPath);
      if (found === 'rejected') return false;
      if (found) {
        // Vite 產生的 /assets/* 檔名帶雜湊，可以永久快取；其餘每次都要重新確認。
        const immutable = urlPath.startsWith('/assets/');
        send(req, reply, found, immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
        return true;
      }
      // 看起來是在要檔案（最後一段有副檔名）卻找不到：回 404，不要回 index.html。
      const last = urlPath.split('/').pop() ?? '';
      if (/\.[A-Za-z0-9]{1,8}$/.test(last)) return false;
      // SPA fallback：其餘路徑都交給前端路由。
      const index = await locate('/index.html');
      if (!index || index === 'rejected') return false;
      send(req, reply, index, 'no-cache');
      return true;
    },
  };
}
