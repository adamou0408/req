// 交付 port 的模擬 adapter：只用在單元測試（契約 02 §8.5 的 mock）。在記憶體裡照外部系統交付介面的完整等級做（裁決 D81 (2)）：
// 驗簽章（被簽的位元組＝領域分隔＋換行＋本文）、信封的通道、環境、方法、路徑與期限、同一張單只收更新的版本、
// 整張撤回之後封存（任何版本都不收）、撤回以冪等鍵去重；每個回應都帶證明（請求本文的 SHA-256、這次的一次性亂數、
// HTTP 狀態與結果，以模擬外部系統自己的 P-256 金鑰簽），格式和 sim/dc 相同。
// 測試查詢照 §8.5 的「規則的語意」計算，並和 sim/dc 一樣以被授權者為單位取聯集。真實 adapter（dcHttp.ts）對著 sim/dc 跑同一份合約測試。
import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import type { DeliveryItem, DeliveryOutcome, DeliveryPort } from './deliveryPort.ts';

type Condition = { filter: string; op: string; values: (string | number | null)[] };
type Rule = {
    rule_id: string;
    package: string;
    fields: string[];
    row_filter: Condition[];
    data_period: { from: string; to: string } | null;
};
type RuleSet = {
    case_no: string;
    case_version_no: number;
    grantee: { principal_id: string };
    valid: { from: string; to: string };
    export: boolean | null;
    rules: Rule[];
};
type Query = {
    package: string;
    fields: string[];
    row: Record<string, string | number>;
    data_date: string | null;
    action: string;
    as_of: string;
};
type Stored = { set: RuleSet; payload: string; withdrawn: boolean };
type Reply = { http_status: number; result: Record<string, unknown> };

export type DcMockOptions = {
    trustedKeys: { key_id: string; public_key_pem: string }[];
    context: string;
    today: () => string;
    /** 平台的通道代碼與這個模擬外部系統的環境代碼（信封與證明都要指名） */
    channel: string;
    environment: string;
    /** 回應證明的金鑰（P-256，PKCS#8 PEM）與代號：平台的資料庫要登記它（sgn_internal.channel_key_register） */
    responseKey: { keyId: string; privatePem: string };
};

const reply = (http_status: number, result: Record<string, unknown>): Reply => ({ http_status, result });

function conditionHolds(c: Condition, v: string | number | undefined): boolean {
    if (v === undefined || v === null) return false;
    if (c.op === 'in') return c.values.includes(v);
    const [lo, hi] = c.values;
    return (lo === null || lo === undefined || v >= lo) && (hi === null || hi === undefined || v <= hi);
}

/** 契約 02 §8.5「規則的語意」：一份規則對一個查詢的判斷（含擋下的原因）。 */
export function evaluate(rs: RuleSet, q: Query): { actual: 'allow' | 'deny'; reason: string | null } {
    const r = rs.rules.find((x) => x.package === q.package);
    if (r === undefined) return { actual: 'deny', reason: 'no_rule' };
    if (q.as_of < rs.valid.from) return { actual: 'deny', reason: 'not_yet_valid' };
    if (q.as_of > rs.valid.to) return { actual: 'deny', reason: 'expired' };
    if (q.fields.length === 0 || q.fields.some((f) => !r.fields.includes(f))) return { actual: 'deny', reason: 'field_not_granted' };
    if (r.row_filter.some((c) => !conditionHolds(c, q.row[c.filter]))) return { actual: 'deny', reason: 'row_filter' };
    if (r.data_period !== null && (q.data_date === null || q.data_date < r.data_period.from || q.data_date > r.data_period.to)) {
        return { actual: 'deny', reason: 'data_period' };
    }
    if (q.action === 'export' && rs.export === false) return { actual: 'deny', reason: 'export_not_allowed' };
    return { actual: 'allow', reason: null };
}

/**
 * 外部系統以被授權者的身分查（sim/dc 的規則隔離）：每條規則各自放行，一個欄位只要有一條規則放行那一列就讀得到，
 * 每個欄位都讀得到才 allow。所以同一被授權者的其他單會一起影響結果。
 */
function evaluateUnion(sets: RuleSet[], own: RuleSet, q: Query): { actual: 'allow' | 'deny'; reason: string | null } {
    const fieldAllowed = (f: string) => sets.some((rs) => evaluate(rs, { ...q, fields: [f] }).actual === 'allow');
    if (q.fields.length > 0 && q.fields.every(fieldAllowed)) return { actual: 'allow', reason: null };
    const ownResult = evaluate(own, q);
    return { actual: 'deny', reason: ownResult.reason ?? 'field_not_granted' };
}

function signatureValid(keys: Map<string, KeyObject>, context: string, item: DeliveryItem): boolean {
    const key = item.signature === null ? undefined : keys.get(item.signature.key_id);
    if (key === undefined || item.signature === null) return false;
    const signed = Buffer.concat([Buffer.from(`${context}\n`, 'utf8'), Buffer.from(item.body, 'utf8')]);
    return verify(null, signed, key, Buffer.from(item.signature.sig, 'base64'));
}

type Envelope = { format: string; channel: string; environment: string; method: string; path: string; not_after: string; payload: unknown };

/** 已驗章的信封 → payload；通道、環境、方法、路徑不符或過期時回傳拒絕的回應。 */
function openEnvelope(options: DcMockOptions, item: DeliveryItem): { payload: unknown } | Reply {
    const env = JSON.parse(item.body) as Envelope;
    if (env.format !== 'sgn_dc_request/1') return reply(422, { status: 'failed', code: 'invalid_envelope', error: 'not an envelope' });
    const want = { channel: options.channel, environment: options.environment, method: item.method, path: item.path };
    for (const [k, v] of Object.entries(want)) {
        if (env[k as keyof typeof want] !== v) return reply(409, { status: 'failed', code: 'target_mismatch', error: k });
    }
    if (Date.now() > Date.parse(env.not_after)) return reply(401, { status: 'failed', code: 'signature_expired', error: 'expired' });
    return { payload: env.payload };
}

function apply(store: Map<string, Stored>, archived: Set<string>, payload: unknown): Reply {
    const set = payload as RuleSet;
    const text = JSON.stringify(set);
    if (archived.has(set.case_no)) return reply(409, { status: 'failed', code: 'archived', error: 'archived' });
    const prev = store.get(set.case_no);
    if (prev !== undefined && set.case_version_no < prev.set.case_version_no) {
        return reply(409, { status: 'failed', code: 'conflict', error: 'older version' });
    }
    if (prev !== undefined && set.case_version_no === prev.set.case_version_no && (prev.withdrawn || prev.payload !== text)) {
        return reply(409, { status: 'failed', code: 'conflict', error: 'version conflict' });
    }
    store.set(set.case_no, { set, payload: text, withdrawn: false });
    return reply(200, { status: 'applied', dc_ref: `mock:${set.case_no}:v${set.case_version_no}` });
}

function withdraw(store: Map<string, Stored>, archived: Set<string>, seen: Set<string>, payload: unknown): Reply {
    const req = payload as { request_id: string; case_no: string };
    if (seen.has(req.request_id)) return reply(200, { status: 'withdrawn' });
    seen.add(req.request_id);
    archived.add(req.case_no);
    const prev = store.get(req.case_no);
    if (prev === undefined) return reply(404, { status: 'failed', code: 'not_found', error: 'no such case' });
    prev.withdrawn = true;
    return reply(200, { status: 'withdrawn' });
}

function testQueries(store: Map<string, Stored>, item: DeliveryItem): Reply {
    const req = JSON.parse(item.body) as { rule_set: RuleSet; cases: { code: string; query: Query }[] };
    const live = [...store.values()]
        .filter((s) => !s.withdrawn && s.set.grantee.principal_id === req.rule_set.grantee.principal_id)
        .map((s) => s.set);
    const results = req.cases.map((c) => ({ code: c.code, ...evaluateUnion(live, req.rule_set, c.query) }));
    return reply(200, { status: 'completed', results });
}

type Request = { method: string; path: string; body: string; nonce: string | null };

/** 回應本文＝結果＋證明（和 sim/dc 的 signature.ts 同一個格式）。 */
function attested(options: DcMockOptions, item: Request, r: Reply): DeliveryOutcome {
    const payload = JSON.stringify({
        format: 'sgn_dc_attestation/1',
        channel: options.channel,
        environment: options.environment,
        method: item.method,
        path: item.path,
        query: '',
        request_sha256: createHash('sha256').update(item.body, 'utf8').digest('hex'),
        nonce: item.nonce,
        http_status: r.http_status,
        issued_at: new Date().toISOString(),
        result: r.result,
    });
    const sig = sign('sha256', Buffer.from(`sgn-dc-attestation/1\n${payload}`, 'utf8'), {
        key: createPrivateKey(options.responseKey.privatePem),
        dsaEncoding: 'der',
    });
    const attestation = { payload, key_id: options.responseKey.keyId, alg: 'es256', sig: sig.toString('base64') };
    const error = typeof r.result['error'] === 'string' ? r.result['error'] : null;
    return { http_status: r.http_status, response: { ...r.result, attestation }, error };
}

function handle(
    options: DcMockOptions,
    keys: Map<string, KeyObject>,
    state: { store: Map<string, Stored>; archived: Set<string>; seen: Set<string> },
    item: DeliveryItem,
): Reply {
    if (item.kind === 'verify') return testQueries(state.store, item);
    if (item.kind === 'purge') {
        for (const [caseNo, s] of state.store) if (s.set.valid.to < options.today()) state.store.delete(caseNo);
        return reply(200, { status: 'purged' });
    }
    if (!signatureValid(keys, options.context, item))
        return reply(401, { status: 'failed', code: 'signature_invalid', error: 'signature' });
    const opened = openEnvelope(options, item);
    if (!('payload' in opened)) return opened;
    return item.kind === 'apply'
        ? apply(state.store, state.archived, opened.payload)
        : withdraw(state.store, state.archived, state.seen, opened.payload);
}

export type DcMock = DeliveryPort & {
    readonly store: ReadonlyMap<string, Stored>;
    /** 這個模擬外部系統對某一筆「照實」回覆指定的狀態與結果（帶證明）：測試用來模擬外部系統忙、拒絕等情況 */
    reply(item: DeliveryItem, http_status: number, result: Record<string, unknown>): DeliveryOutcome;
    /** 這個模擬外部系統簽的對帳回應（GET /reconciliation）：測試用來交指定內容的回報 */
    reconciliation(report: Record<string, unknown>): unknown;
};

export function dcMockDelivery(options: DcMockOptions): DcMock {
    const keys = new Map(options.trustedKeys.map((k) => [k.key_id, createPublicKey(k.public_key_pem)]));
    const state = { store: new Map<string, Stored>(), archived: new Set<string>(), seen: new Set<string>() };
    return {
        kind: 'mock',
        store: state.store,
        send(item: DeliveryItem): Promise<DeliveryOutcome> {
            return Promise.resolve(attested(options, item, handle(options, keys, state, item)));
        },
        reply(item: DeliveryItem, http_status: number, result: Record<string, unknown>): DeliveryOutcome {
            return attested(options, item, reply(http_status, result));
        },
        reconciliation(report: Record<string, unknown>): unknown {
            return attested(options, { method: 'GET', path: '/reconciliation', body: '', nonce: null }, reply(200, report)).response;
        },
    };
}
