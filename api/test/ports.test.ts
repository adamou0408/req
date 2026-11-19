import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { allowedFunctions, createSystemCalls } from '../src/contract/index.ts';
import { createPool, Db } from '../src/db.ts';
import { ManualDc } from '../src/ports/adapters/dcManual.ts';
import { evaluate, filterMatches, MockDc } from '../src/ports/adapters/dcMock.ts';
import { JsonFileCatalog, JsonFileDirectory } from '../src/ports/adapters/jsonFile.ts';
import { ConsoleMail } from '../src/ports/adapters/mailConsole.ts';
import { SmtpMail } from '../src/ports/adapters/mailSmtp.ts';
import { OpenidClientOidc } from '../src/ports/adapters/oidcOpenidClient.ts';
import type { DcRule, DcTestCase } from '../src/ports/dc.ts';
import { createPorts } from '../src/ports/index.ts';
import { testContract } from './fixtures/testContract.ts';
import { adminPool, baseEnv } from './helpers.ts';

const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const quiet = { info: () => {} };

describe('DcPort', () => {
  const rule: DcRule = {
    grantee: { type: 'team', id: 't1' },
    columns: ['orders.region', 'orders.amount'],
    row_filters: [
      { column: 'orders.region', op: 'in', values: ['北', '中'] },
      { column: 'orders.order_date', op: 'between', values: ['2024-01-01', '2024-12-31'] },
    ],
    valid_from: '2026-01-01',
    valid_to: '2026-06-30',
    can_export: false,
  };
  const base: DcTestCase = {
    id: 'c1',
    expect: 'allow',
    columns: ['orders.amount'],
    row: { 'orders.region': '北', 'orders.order_date': '2024-05-01' },
    action: 'query',
    on: '2026-03-01',
  };

  it('mock：依規則 JSON 算出查得到／查不到，並說明原因', () => {
    expect(evaluate(rule, base)).toEqual({ actual: 'allow', reason: null });
    const cases: Array<[Partial<DcTestCase>, string]> = [
      [{ columns: ['orders.amount', 'orders.customer_id'] }, 'column_not_granted:orders.customer_id'],
      [{ row: { 'orders.region': '南', 'orders.order_date': '2024-05-01' } }, 'row_filter:orders.region'],
      [{ row: { 'orders.region': '北', 'orders.order_date': '2025-01-01' } }, 'row_filter:orders.order_date'],
      [{ row: { 'orders.region': '北' } }, 'row_filter:orders.order_date'],
      [{ on: '2026-07-01' }, 'outside_validity'],
      [{ on: '2025-12-31' }, 'outside_validity'],
      [{ action: 'export' }, 'export_not_allowed'],
      [{ grantee: { type: 'team', id: 't2' } }, 'grantee_mismatch'],
      [{ grantee: { type: 'agent', id: 't1' } }, 'grantee_mismatch'],
    ];
    for (const [change, reason] of cases) {
      expect(evaluate(rule, { ...base, ...change }), reason).toEqual({ actual: 'deny', reason });
    }
    // 起迄當天都算有效；可匯出的規則允許匯出。
    expect(evaluate(rule, { ...base, on: '2026-01-01' }).actual).toBe('allow');
    expect(evaluate(rule, { ...base, on: '2026-06-30' }).actual).toBe('allow');
    expect(evaluate({ ...rule, can_export: true }, { ...base, action: 'export' }).actual).toBe('allow');
  });

  it('mock：列條件的各種運算', () => {
    const f = (op: DcTestCase['action'] | string, values: (string | number)[]) =>
      ({ column: 'c', op, values }) as Parameters<typeof filterMatches>[0];
    expect(filterMatches(f('eq', [5]), 5)).toBe(true);
    expect(filterMatches(f('eq', [5]), '5')).toBe(false); // 型別不同不算相等
    expect(filterMatches(f('ne', ['a']), 'b')).toBe(true);
    expect(filterMatches(f('not_in', ['a', 'b']), 'c')).toBe(true);
    expect(filterMatches(f('not_in', ['a', 'b']), 'a')).toBe(false);
    expect(filterMatches(f('gt', [10]), 11)).toBe(true);
    expect(filterMatches(f('gte', [10]), 10)).toBe(true);
    expect(filterMatches(f('lt', [10]), 10)).toBe(false);
    expect(filterMatches(f('lte', ['2024-12-31']), '2024-12-31')).toBe(true);
    expect(filterMatches(f('between', [1, 3]), 3)).toBe(true);
    expect(filterMatches(f('between', [1]), 1)).toBe(false); // 少一個邊界
    expect(filterMatches(f('eq', [1]), null)).toBe(false);
    expect(filterMatches(f('ne', [1]), undefined)).toBe(false); // 沒有值一律不成立
    expect(filterMatches(f('like', ['x']), 'x')).toBe(false); // 不認得的運算
  });

  it('mock：runTests 逐案比對預期與實際', async () => {
    const dc = new MockDc();
    expect(dc.mode).toBe('mock');
    expect(await dc.deliverRule(rule)).toEqual({ delivered: true, ref: 'mock-1' });
    const results = await dc.runTests(rule, [
      base,
      { ...base, id: 'c2', expect: 'deny', columns: ['orders.customer_id'] },
      { ...base, id: 'c3', expect: 'allow', action: 'export' }, // 預期查得到，實際被擋 → 沒過
      { ...base, id: 'c4', expect: 'deny' }, // 預期查不到，實際查得到 → 沒過
    ]);
    expect(results).toEqual([
      { id: 'c1', expect: 'allow', actual: 'allow', passed: true, reason: null },
      { id: 'c2', expect: 'deny', actual: 'deny', passed: true, reason: 'column_not_granted:orders.customer_id' },
      { id: 'c3', expect: 'allow', actual: 'deny', passed: false, reason: 'export_not_allowed' },
      { id: 'c4', expect: 'deny', actual: 'allow', passed: false, reason: null },
    ]);
  });

  it('manual：不做事', async () => {
    const dc = new ManualDc();
    expect(dc.mode).toBe('manual');
    expect(await dc.deliverRule(rule)).toEqual({ delivered: false, ref: null });
    expect(await dc.runTests(rule, [base])).toBeNull();
  });
});

describe('MailPort', () => {
  it('console：只記 log，不真的寄', async () => {
    const lines: Array<Record<string, unknown>> = [];
    const mail = new ConsoleMail({ info: (obj) => void lines.push(obj) });
    const result = await mail.send({ to: ['u1@example.test'], subject: '待簽核', text: '有一張單等你簽' });
    expect(result).toEqual({ ref: 'console-1' });
    expect(mail.sent).toHaveLength(1);
    expect(lines[0]).toMatchObject({ mail: { ref: 'console-1', to: ['u1@example.test'], subject: '待簽核' } });
    await mail.close();
  });

  it('smtp：寄不出去會丟例外（由 outbox worker 重試）', async () => {
    const mail = new SmtpMail({ url: 'smtp://127.0.0.1:1', from: 'das@example.test' });
    try {
      await expect(mail.send({ to: ['u1@example.test'], subject: 's', text: 't' })).rejects.toThrow();
    } finally {
      await mail.close();
    }
  });
});

describe('DirectoryPort／CatalogPort（JSON 檔）', () => {
  let dir: string;
  let pool: pg.Pool;
  let admin: pg.Pool;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'das-api-ports-'));
    pool = createPool(loadConfig(baseEnv()));
    admin = adminPool();
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    await pool.end();
    await admin.end();
  });

  it('讀檔', async () => {
    const directory = await new JsonFileDirectory(fixture('directory.json')).fetch();
    expect(directory.people).toHaveLength(3);
    expect(directory.teams[0]).toMatchObject({ id: 't1', name: '資料分析組' });
    const catalog = await new JsonFileCatalog(fixture('catalog.json')).fetch();
    expect(catalog.packages[0]?.columns.map((c) => c.level)).toEqual(['L2', 'L3', 'L4']);
  });

  it('檔案不存在、不是 JSON、缺欄位時，錯誤訊息講清楚', async () => {
    await expect(new JsonFileDirectory(path.join(dir, 'missing.json')).fetch()).rejects.toThrow(/讀不到人員組織檔案/);
    const broken = path.join(dir, 'broken.json');
    await writeFile(broken, '{ not json');
    await expect(new JsonFileCatalog(broken).fetch()).rejects.toThrow(/不是合法的 JSON/);
    const array = path.join(dir, 'array.json');
    await writeFile(array, '[]');
    await expect(new JsonFileCatalog(array).fetch()).rejects.toThrow(/最外層必須是物件/);
    const noTeams = path.join(dir, 'no-teams.json');
    await writeFile(noTeams, '{"people": []}');
    await expect(new JsonFileDirectory(noTeams).fetch()).rejects.toThrow(/缺少陣列欄位「teams」/);
  });

  it('整份交給 SQL function 匯入', async () => {
    const db = new Db(pool, allowedFunctions(testContract));
    const sys = createSystemCalls(db, testContract.sqlNames, null);
    expect(await sys.importDirectory(await new JsonFileDirectory(fixture('directory.json')).fetch())).toEqual({
      people: 3,
      teams: 1,
    });
    expect(await sys.importCatalog(await new JsonFileCatalog(fixture('catalog.json')).fetch())).toEqual({ packages: 1 });
    const { rows } = await admin.query("select data -> 'people' -> 0 ->> 'name' as name from das.imports where kind = 'directory'");
    expect(rows[0].name).toBe('王小明');
  });
});

describe('createPorts：依設定挑實作', () => {
  const make = (env: Record<string, string>) =>
    createPorts({ config: loadConfig(baseEnv(env)), sys: { totpSecret: async () => null }, log: quiet, now: Date.now });

  it('預設（開發）：console、mock、dev，沒有 OIDC', async () => {
    const ports = make({});
    expect(ports.mail.mode).toBe('console');
    expect(ports.dc.mode).toBe('mock');
    expect(ports.mfa.mode).toBe('dev');
    expect(ports.oidc).toBeNull();
    expect(ports.directory).toBeNull();
    expect(ports.catalog).toBeNull();
  });

  it('切換模式', async () => {
    const ports = make({
      MAIL_MODE: 'smtp',
      SMTP_URL: 'smtp://127.0.0.1:1',
      MAIL_FROM: 'das@example.test',
      DC_MODE: 'manual',
      MFA_MODE: 'totp',
      DIRECTORY_FILE: fixture('directory.json'),
      CATALOG_FILE: fixture('catalog.json'),
    });
    expect(ports.mail.mode).toBe('smtp');
    expect(ports.dc.mode).toBe('manual');
    expect(ports.mfa.mode).toBe('totp');
    expect(ports.directory).toBeInstanceOf(JsonFileDirectory);
    expect(ports.catalog).toBeInstanceOf(JsonFileCatalog);
    await ports.mail.close();
  });

  it('OIDC：設定不全不啟用；齊全才建立 adapter', () => {
    expect(make({ AUTH_MODE: 'oidc', OIDC_ISSUER: 'https://idp.example.test' }).oidc).toBeNull();
    const ports = make({
      AUTH_MODE: 'oidc',
      PUBLIC_ORIGIN: 'https://das.example.test',
      OIDC_ISSUER: 'https://idp.example.test',
      OIDC_CLIENT_ID: 'das',
      OIDC_CLIENT_SECRET: 'secret',
    });
    expect(ports.oidc).toBeInstanceOf(OpenidClientOidc);
  });
});
