// 測試共用：以另一組資料庫（sim_dc_check、sim_dc_check_test）、另一組角色前綴與 unix socket
// 啟動一個獨立的服務，不占用 7001，也不碰開發用的 sim_dc。設定由 test.sh 放進環境變數。
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import pg from 'pg';
import { attestationValid, generateKeyPair, REQUEST_FORMAT, signRequest, type Attestation } from '../src/signature.ts';

function env(name: string): string {
    const v = process.env[name];
    if (v === undefined || v === '') throw new Error(`缺少環境變數 ${name}（請用 sim/dc/test.sh 執行）`);
    return v;
}

export const KEYS = {
    platform: env('SIM_DC_KEY_PLATFORM'),
    auditor: env('SIM_DC_KEY_AUDITOR'),
    admin: env('SIM_DC_KEY_ADMIN'),
};

const keyDir = join(env('SIM_DC_TEST_DIR'), 'keys');
export const TEST_KEY_ID = 'test-platform';
/** 遮罩環境信任的是另一把（每個環境各自的信任清單） */
export const MASKED_KEY_ID = 'test-platform-masked';

export function platformPrivateKey(keyId = TEST_KEY_ID): string {
    return readFileSync(join(keyDir, `${keyId}.private.pem`), 'utf8');
}

/** DC 回應證明的公鑰（平台那一側登記的就是它） */
export function responsePublicKey(): string {
    return readFileSync(join(keyDir, 'response.public.pem'), 'utf8');
}

const ENVIRONMENTS: Record<string, string> = { '/v1': env('SIM_DC_DB'), '/masked/v1': env('SIM_DC_DB_MASKED') };

/** 平台簽的信封：通道、環境、方法、路徑（環境前綴之後）與期限都在被簽的內容裡。 */
export function envelope(
    method: string,
    fullPath: string,
    payload: unknown,
    over: Partial<{ channel: string; environment: string; method: string; path: string; not_after: string }> = {},
): string {
    const base = fullPath.startsWith('/masked/v1/') ? '/masked/v1' : '/v1';
    return JSON.stringify({
        format: REQUEST_FORMAT,
        channel: env('SIM_DC_CHANNEL'),
        environment: ENVIRONMENTS[base],
        method,
        path: fullPath.slice(base.length),
        not_after: new Date(Date.now() + 300_000).toISOString(),
        ...over,
        payload,
    });
}

export interface AttestationPayload {
    format: string;
    channel: string;
    environment: string;
    method: string;
    path: string;
    query: string;
    request_sha256: string;
    nonce: string | null;
    http_status: number;
    issued_at: string;
    result: Record<string, unknown>;
}

/** 驗回應的證明並打開它（平台的資料庫做同樣的事）。驗不過就丟錯。 */
export function attested(r: Response): AttestationPayload {
    const a = r.body['attestation'] as Attestation | undefined;
    if (a === undefined || !attestationValid(responsePublicKey(), a)) throw new Error(`回應沒有有效的證明：${JSON.stringify(r.body)}`);
    return JSON.parse(a.payload) as AttestationPayload;
}

// 另一把不受信任的金鑰：用它簽的規則必須被拒絕
export const untrustedKey = generateKeyPair().privatePem;

export interface Response {
    readonly status: number;
    readonly body: Record<string, unknown>;
}

export function call(
    method: string,
    path: string,
    opts: { key?: string | null; body?: string | Buffer; headers?: Record<string, string> } = {},
): Promise<Response> {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    const key = opts.key === undefined ? KEYS.platform : opts.key;
    if (key !== null) headers['authorization'] = `Bearer ${key}`;
    if (opts.body !== undefined) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = String(Buffer.byteLength(opts.body));
    }
    return new Promise((resolve, reject) => {
        const req = request({ socketPath: env('SIM_DC_SOCKET'), path, method, headers }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                resolve({ status: res.statusCode ?? 0, body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) });
            });
        });
        req.on('error', reject);
        if (opts.body !== undefined) req.write(opts.body);
        req.end();
    });
}

export function signed(body: string, privateKey = platformPrivateKey(), keyId = TEST_KEY_ID): Record<string, string> {
    return { 'sgn-signature': signRequest(privateKey, keyId, Buffer.from(body, 'utf8')) };
}

/** 以該環境信任的平台金鑰簽一個信封並送出。 */
export async function sendSigned(method: string, fullPath: string, payload: unknown): Promise<Response> {
    const body = envelope(method, fullPath, payload);
    const keyId = fullPath.startsWith('/masked/v1/') ? MASKED_KEY_ID : TEST_KEY_ID;
    return call(method, fullPath, { body, headers: signed(body, platformPrivateKey(keyId), keyId) });
}

export async function putRuleSet(rs: RuleSetInput, base = '/v1'): Promise<Response> {
    return sendSigned('PUT', `${base}/rule-sets/${rs.case_no}`, rs);
}

export async function withdraw(caseNo: string, requestId: string, ruleIds?: string[], base = '/v1'): Promise<Response> {
    const payload = { request_id: requestId, case_no: caseNo, ...(ruleIds === undefined ? {} : { rule_ids: ruleIds }) };
    return sendSigned('DELETE', `${base}/rule-sets/${caseNo}`, payload);
}

export interface QueryInput {
    package: string;
    fields: string[];
    row: Record<string, string | number>;
    data_date: string | null;
    action: 'query' | 'export';
    as_of: string;
    environment?: 'prod' | 'test';
}

export async function testQuery(principalId: string, query: QueryInput, probe = false): Promise<Record<string, unknown>> {
    const r = await call('POST', '/v1/test-query', {
        body: JSON.stringify({ principal_id: principalId, query, probe_missing_row: probe }),
    });
    if (r.status !== 200) throw new Error(`test-query ${r.status}：${JSON.stringify(r.body)}`);
    return attested(r).result;
}

export interface ReconItem {
    item_key: string;
    subject: { id: string };
    resource: { id: string };
    action: { name: string };
    constraints: Record<string, unknown>;
    properties: Record<string, unknown>;
}

export async function reconciliation(base = '/v1'): Promise<ReconItem[]> {
    const r = await call('GET', `${base}/reconciliation`, { key: KEYS.auditor });
    if (r.status !== 200) throw new Error(`reconciliation ${r.status}`);
    return attested(r).result['items'] as ReconItem[];
}

export async function backdoor(op: string, body: Record<string, unknown>): Promise<Response> {
    return call('POST', `/v1/admin/${op}`, { key: KEYS.admin, body: JSON.stringify(body) });
}

// 直接連資料庫（服務角色）讀系統目錄，確認權限真的在資料庫裡
export async function sql<T extends pg.QueryResultRow>(text: string, params: unknown[] = [], database = env('SIM_DC_DB')): Promise<T[]> {
    const client = new pg.Client({
        host: env('SIM_DC_PG_HOST'),
        port: Number(env('SIM_DC_PG_PORT')),
        database,
        user: env('SIM_DC_SERVICE_ROLE'),
        password: env('SIM_DC_SERVICE_PASSWORD'),
    });
    await client.connect();
    try {
        return (await client.query<T>(text, params)).rows;
    } finally {
        await client.end();
    }
}

export interface RuleSetInput {
    format: string;
    case_no: string;
    case_version_no: number;
    grantee: { type: string; principal_id: string; name: string };
    valid: { from: string; to: string };
    export: boolean | null;
    rules: {
        rule_id: string;
        system: string;
        package: string;
        fields: string[];
        row_filter: { filter: string; op: string; values: (string | number | null)[] }[];
        data_period: { field: string; from: string | null; to: string | null } | null;
    }[];
    environment?: string;
}

// 02 §5.10 範例 1（驗收案例 1）的規則；principal_id 用 UUID（build_fulfilment 的實際輸出）
export function example1(principalId: string, caseNo = 'DA-2026-0004'): RuleSetInput {
    return {
        format: 'data_access_rule_set/1',
        case_no: caseNo,
        case_version_no: 1,
        grantee: { type: 'team', principal_id: principalId, name: '通路業務組' },
        valid: { from: '2026-11-16', to: '2027-05-15' },
        export: false,
        rules: [
            {
                rule_id: `${caseNo}-1`,
                system: 'dc',
                package: 'customer_master',
                fields: ['contract_end_date', 'customer_id', 'customer_name'],
                row_filter: [{ filter: 'region', op: 'in', values: ['central', 'north'] }],
                data_period: null,
            },
            {
                rule_id: `${caseNo}-2`,
                system: 'dc',
                package: 'sales_order',
                fields: ['amount', 'customer_id', 'order_date', 'order_no'],
                row_filter: [{ filter: 'region', op: 'in', values: ['central', 'north'] }],
                data_period: { field: 'order_date', from: '2025-01-01', to: '2026-12-31' },
            },
        ],
    };
}

export const PRINCIPAL_A = '0b9f6c3e-0000-4000-8000-00000000000a';
export const PRINCIPAL_B = '0b9f6c3e-0000-4000-8000-00000000000b';

let server: ChildProcess | null = null;

export async function startServer(): Promise<void> {
    const socket = env('SIM_DC_SOCKET');
    if (existsSync(socket)) rmSync(socket);
    const log: Buffer[] = [];
    server = spawn(process.execPath, [join(import.meta.dirname, '..', 'src', 'cli.ts'), 'serve', '--reset'], {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout?.on('data', (c: Buffer) => log.push(c));
    server.stderr?.on('data', (c: Buffer) => log.push(c));
    for (let i = 0; i < 300; i += 1) {
        if (existsSync(socket)) return;
        if (server.exitCode !== null) break;
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`測試用的服務沒有啟動：${Buffer.concat(log).toString('utf8')}`);
}

export async function stopServer(): Promise<void> {
    const s = server;
    if (s === null || s.exitCode !== null) return;
    await new Promise<void>((resolve) => {
        s.on('exit', () => resolve());
        s.kill('SIGTERM');
    });
    server = null;
}
