// 測試共用：以另一組資料庫（sim_dc_check、sim_dc_check_test）、另一組角色前綴與 unix socket
// 啟動一個獨立的服務，不占用 7001，也不碰開發用的 sim_dc。設定由 test.sh 放進環境變數。
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import pg from 'pg';
import { generateKeyPair, signRequest } from '../src/signature.ts';

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

export function platformPrivateKey(): string {
    return readFileSync(join(keyDir, `${TEST_KEY_ID}.private.pem`), 'utf8');
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

export async function putRuleSet(rs: RuleSetInput, base = '/v1'): Promise<Response> {
    const body = JSON.stringify(rs);
    return call('PUT', `${base}/rule-sets/${rs.case_no}`, { body, headers: signed(body) });
}

export async function withdraw(caseNo: string, requestId: string, ruleIds?: string[]): Promise<Response> {
    const body = JSON.stringify({ request_id: requestId, case_no: caseNo, ...(ruleIds === undefined ? {} : { rule_ids: ruleIds }) });
    return call('DELETE', `/v1/rule-sets/${caseNo}`, { body, headers: signed(body) });
}

export interface QueryInput {
    package: string;
    fields: string[];
    row: Record<string, string | number>;
    data_date: string | null;
    action: 'query' | 'export';
    as_of: string;
}

export async function testQuery(principalId: string, query: QueryInput, probe = false): Promise<Record<string, unknown>> {
    const r = await call('POST', '/v1/test-query', {
        body: JSON.stringify({ principal_id: principalId, query, probe_missing_row: probe }),
    });
    if (r.status !== 200) throw new Error(`test-query ${r.status}：${JSON.stringify(r.body)}`);
    return r.body;
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
    return r.body['items'] as ReconItem[];
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
