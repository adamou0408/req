/**
 * 把後端當成一個真的程式啟動（node src/server.ts），驗證：
 * 設定錯誤時拒絕啟動並說明原因、正常啟動後 /healthz 回 200、收到 SIGTERM 優雅關機。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { describe, expect, inject, it } from 'vitest';
import { baseEnv as sharedEnv } from './helpers.ts';

/** 這裡啟動的是真的程式（含背景 worker），所以用專屬的資料庫。 */
const baseEnv = (overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> =>
  sharedEnv({ DATABASE_URL: inject('procDbUrl'), ...overrides });

const entry = fileURLToPath(new URL('../src/server.ts', import.meta.url));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

interface Running {
  child: ChildProcess;
  out: () => string;
  exited: Promise<number | null>;
}

function run(env: Record<string, string | undefined>): Running {
  const clean: Record<string, string> = { PATH: process.env.PATH ?? '' };
  for (const [k, v] of Object.entries(env)) if (v !== undefined) clean[k] = v;
  const child = spawn(process.execPath, [entry], { env: clean, stdio: ['ignore', 'pipe', 'pipe'] });
  let text = '';
  child.stdout?.on('data', (c) => (text += c));
  child.stderr?.on('data', (c) => (text += c));
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, out: () => text, exited };
}

async function waitFor(check: () => Promise<boolean> | boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`等不到：${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('啟動與關機', () => {
  it('正式環境拒絕 AUTH_MODE=dev／MFA_MODE=dev：不啟動，結束碼 1', async () => {
    const p = run(baseEnv({ NODE_ENV: 'production', PORT: String(await freePort()) }));
    expect(await p.exited).toBe(1);
    expect(p.out()).toContain('設定錯誤，無法啟動');
    expect(p.out()).toContain('NODE_ENV=production 時禁止 AUTH_MODE=dev');
    expect(p.out()).toContain('NODE_ENV=production 時禁止 MFA_MODE=dev');
    expect(p.out()).not.toContain('後端已啟動');
  });

  it('缺少必要的環境變數：列出缺哪些，結束碼 1', async () => {
    const p = run({ NODE_ENV: 'development' });
    expect(await p.exited).toBe(1);
    for (const name of ['DATABASE_URL', 'PORT', 'SESSION_SECRET', 'AUTH_MODE', 'MAIL_MODE', 'DC_MODE', 'MFA_MODE', 'SCHEDULER_INTERVAL_SEC']) {
      expect(p.out(), name).toContain(`缺少環境變數 ${name}`);
    }
  });

  it('設定錯誤的訊息不會印出金鑰或連線密碼', async () => {
    const p = run(baseEnv({ AUTH_MODE: 'nope', SESSION_SECRET: 'super-secret-value-super-secret-value' }));
    expect(await p.exited).toBe(1);
    expect(p.out()).toContain('AUTH_MODE=nope 不合法');
    expect(p.out()).not.toContain('super-secret-value');
    expect(p.out()).not.toMatch(/postgres:\/\/[^\s]*:[^\s]*@/);
  });

  it('正常啟動 → /healthz 200 → SIGTERM 優雅關機（結束碼 0）', async () => {
    const port = await freePort();
    const p = run(baseEnv({ PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'development', OUTBOX_INTERVAL_SEC: '1', SCHEDULER_INTERVAL_SEC: '1' }));
    try {
      await waitFor(() => p.out().includes('後端已啟動'), '後端已啟動');
      const health = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: 'ok', db: 'ok' });
      const config = await fetch(`http://127.0.0.1:${port}/api/auth/config`);
      expect(await config.json()).toMatchObject({ auth_mode: 'dev', mfa_mode: 'dev' });
      // 兩個 worker 都起來了。
      await waitFor(() => (p.out().match(/worker 啟動/g) ?? []).length === 2, '兩個 worker 啟動');
    } finally {
      p.child.kill('SIGTERM');
    }
    expect(await p.exited).toBe(0);
    const out = p.out();
    expect(out).toContain('收到關機訊號');
    expect((out.match(/worker 停止/g) ?? []).length).toBe(2);
    expect(out).toContain('已關機');
    // 每一行都是結構化的 JSON，而且沒有印出連線字串或金鑰。
    for (const line of out.trim().split('\n')) expect(() => JSON.parse(line), line).not.toThrow();
    expect(out).not.toContain('test-secret-0123456789');
    expect(out).not.toMatch(/postgres:\/\//);
  });

  it('port 被占用：啟動失敗，結束碼 1', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const { port } = blocker.address() as { port: number };
    try {
      const p = run(baseEnv({ PORT: String(port), HOST: '127.0.0.1', OUTBOX_ENABLED: 'false', SCHEDULER_ENABLED: 'false' }));
      expect(await p.exited).toBe(1);
      expect(p.out()).toContain('啟動失敗');
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });
});
