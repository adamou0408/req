import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.ts';

const valid = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/das',
  PORT: '3000',
  SESSION_SECRET: 'k'.repeat(40),
  AUTH_MODE: 'dev',
  MAIL_MODE: 'console',
  DC_MODE: 'mock',
  MFA_MODE: 'dev',
  SCHEDULER_INTERVAL_SEC: '60',
};

const prod = {
  ...valid,
  NODE_ENV: 'production',
  AUTH_MODE: 'oidc',
  MFA_MODE: 'totp',
};

function problems(env: Record<string, string | undefined>): string[] {
  try {
    loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
  return [];
}

describe('設定', () => {
  it('必要的變數都有時可以載入，其餘用預設值', () => {
    const c = loadConfig(valid);
    expect(c).toMatchObject({
      nodeEnv: 'development',
      port: 3000,
      apiPrefix: '/api',
      authMode: 'dev',
      mailMode: 'console',
      dcMode: 'mock',
      mfaMode: 'dev',
      mfaTtlSec: 300,
      schedulerIntervalSec: 60,
      schedulerEnabled: true,
      outboxEnabled: true,
      cookieSecure: false,
      cookieName: 'das_session',
      webDist: null,
      trustProxy: false,
    });
  });

  it('缺少必要變數時，一次列出全部缺的', () => {
    const p = problems({});
    for (const name of [
      'DATABASE_URL',
      'PORT',
      'SESSION_SECRET',
      'AUTH_MODE',
      'MAIL_MODE',
      'DC_MODE',
      'MFA_MODE',
      'SCHEDULER_INTERVAL_SEC',
    ]) {
      expect(p.some((line) => line.includes(name)), name).toBe(true);
    }
  });

  it('錯誤訊息點名變數與可用值', () => {
    expect(() => loadConfig({ ...valid, AUTH_MODE: 'ldap' })).toThrow(/AUTH_MODE=ldap 不合法（可用值：dev｜oidc）/);
    expect(() => loadConfig({ ...valid, PORT: 'abc' })).toThrow(/PORT=abc 必須是整數/);
    expect(() => loadConfig({ ...valid, SESSION_SECRET: 'short' })).toThrow(/至少 32 個字元/);
    expect(() => loadConfig({ ...valid, SCHEDULER_INTERVAL_SEC: '0' })).toThrow(/SCHEDULER_INTERVAL_SEC=0 超出範圍/);
  });

  it('空字串視為沒有設定', () => {
    expect(problems({ ...valid, DATABASE_URL: '  ' })).toEqual(['缺少環境變數 DATABASE_URL']);
  });

  it('正式環境拒絕 AUTH_MODE=dev', () => {
    expect(problems({ ...prod, AUTH_MODE: 'dev' })).toEqual(['NODE_ENV=production 時禁止 AUTH_MODE=dev']);
  });

  it('正式環境拒絕 MFA_MODE=dev', () => {
    expect(problems({ ...prod, MFA_MODE: 'dev' })).toEqual(['NODE_ENV=production 時禁止 MFA_MODE=dev']);
  });

  it('正式環境兩個都是 dev 時兩個都報', () => {
    expect(problems({ ...valid, NODE_ENV: 'production' })).toEqual([
      'NODE_ENV=production 時禁止 AUTH_MODE=dev',
      'NODE_ENV=production 時禁止 MFA_MODE=dev',
    ]);
  });

  it('正式環境拒絕範例金鑰', () => {
    expect(problems({ ...prod, SESSION_SECRET: 'change-me-change-me-change-me-change-me' })).toEqual([
      'SESSION_SECRET 看起來是範例值；正式環境請換成隨機字串',
    ]);
  });

  it('正式環境預設 cookie 加上 Secure 與 __Host- 前綴', () => {
    const c = loadConfig(prod);
    expect(c.cookieSecure).toBe(true);
    expect(c.cookieName).toBe('__Host-das_session');
  });

  it('AUTH_MODE=oidc 但設定不全：可以啟動，OIDC 不啟用，並記下缺什麼', () => {
    const c = loadConfig({ ...prod, OIDC_ISSUER: 'https://idp.example.test' });
    expect(c.oidc).toBeNull();
    expect(c.oidcMissing).toEqual(['OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_REDIRECT_URI（或 PUBLIC_ORIGIN）']);
  });

  it('OIDC 設定齊全時啟用；redirect URI 可由 PUBLIC_ORIGIN 推出', () => {
    const c = loadConfig({
      ...prod,
      PUBLIC_ORIGIN: 'https://das.example.test',
      OIDC_ISSUER: 'https://idp.example.test',
      OIDC_CLIENT_ID: 'das',
      OIDC_CLIENT_SECRET: 's3cret',
    });
    expect(c.oidc).toEqual({
      issuer: 'https://idp.example.test',
      clientId: 'das',
      clientSecret: 's3cret',
      redirectUri: 'https://das.example.test/api/auth/oidc/callback',
      scope: 'openid profile email',
      allowInsecure: false,
    });
  });

  it('OIDC_ISSUER 是 http://：開發時允許（接模擬器），正式環境拒絕', () => {
    const oidcEnv = { OIDC_ISSUER: 'http://localhost:9000', OIDC_CLIENT_ID: 'das', OIDC_CLIENT_SECRET: 's', OIDC_REDIRECT_URI: 'http://localhost:3000/api/auth/oidc/callback' };
    expect(loadConfig({ ...valid, AUTH_MODE: 'oidc', ...oidcEnv }).oidc?.allowInsecure).toBe(true);
    expect(problems({ ...prod, ...oidcEnv })).toEqual(['NODE_ENV=production 時 OIDC_ISSUER 必須是 https://']);
  });

  it('MAIL_MODE=smtp 需要 SMTP_URL 與 MAIL_FROM', () => {
    expect(problems({ ...valid, MAIL_MODE: 'smtp' })).toEqual(['缺少環境變數 SMTP_URL', '缺少環境變數 MAIL_FROM']);
    const c = loadConfig({ ...valid, MAIL_MODE: 'smtp', SMTP_URL: 'smtp://mail.example.test:25', MAIL_FROM: 'das@example.test' });
    expect(c.smtp).toEqual({ url: 'smtp://mail.example.test:25', from: 'das@example.test' });
  });

  it('SESSION_SECRET 可以放多把（輪替）', () => {
    const c = loadConfig({ ...valid, SESSION_SECRET: `${'a'.repeat(32)}, ${'b'.repeat(32)}` });
    expect(c.sessionSecrets).toEqual(['a'.repeat(32), 'b'.repeat(32)]);
  });

  it('TRUST_PROXY、API_PREFIX、開關類變數', () => {
    const c = loadConfig({
      ...valid,
      TRUST_PROXY: '1',
      API_PREFIX: '/',
      SCHEDULER_ENABLED: 'false',
      OUTBOX_ENABLED: '0',
      PUBLIC_ORIGIN: 'https://das.example.test/',
      ALLOWED_ORIGINS: 'http://localhost:5173, http://127.0.0.1:5173',
    });
    expect(c.trustProxy).toBe(1);
    expect(c.apiPrefix).toBe('');
    expect(c.schedulerEnabled).toBe(false);
    expect(c.outboxEnabled).toBe(false);
    expect(c.publicOrigin).toBe('https://das.example.test');
    expect(c.allowedOrigins).toEqual(['http://localhost:5173', 'http://127.0.0.1:5173']);
    expect(() => loadConfig({ ...valid, PUBLIC_ORIGIN: 'https://das.example.test/app' })).toThrow(/PUBLIC_ORIGIN 必須是 origin/);
    expect(() => loadConfig({ ...valid, SCHEDULER_ENABLED: 'maybe' })).toThrow(/必須是 true 或 false/);
  });
});
