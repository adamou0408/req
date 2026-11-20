// 交付 port 的模擬 adapter：只用在單元測試（契約 02 §8.5 的 mock）。在記憶體裡照外部系統的規則做：
// 驗簽章（被簽的位元組＝領域分隔＋換行＋本文）、同一張單只收更新的版本、撤回過的同一版不能再套用、撤回以冪等鍵去重、
// 測試查詢照 §8.5 的「規則的語意」計算，並和 sim/dc 一樣以被授權者為單位取聯集。真實 adapter（dcHttp.ts）對著 sim/dc 跑同一份合約測試。
import { createPublicKey, verify, type KeyObject } from 'node:crypto';
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
type Stored = { set: RuleSet; body: string; withdrawn: boolean };

export type DcMockOptions = { trustedKeys: { key_id: string; public_key_pem: string }[]; context: string; today: () => string };

const reply = (http_status: number, response: Record<string, unknown>): DeliveryOutcome => ({
    http_status,
    response,
    error: typeof response['error'] === 'string' ? response['error'] : null,
});

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

function apply(store: Map<string, Stored>, item: DeliveryItem): DeliveryOutcome {
    const set = JSON.parse(item.body) as RuleSet;
    const prev = store.get(set.case_no);
    if (prev !== undefined && set.case_version_no < prev.set.case_version_no)
        return reply(409, { status: 'failed', error: 'older version' });
    if (prev !== undefined && set.case_version_no === prev.set.case_version_no && (prev.withdrawn || prev.body !== item.body)) {
        return reply(409, { status: 'failed', error: 'version conflict' });
    }
    store.set(set.case_no, { set, body: item.body, withdrawn: false });
    return reply(200, { status: 'applied', dc_ref: `mock:${set.case_no}:v${set.case_version_no}` });
}

function withdraw(store: Map<string, Stored>, seen: Set<string>, item: DeliveryItem): DeliveryOutcome {
    const req = JSON.parse(item.body) as { request_id: string; case_no: string };
    if (seen.has(req.request_id)) return reply(200, { status: 'withdrawn' });
    const prev = store.get(req.case_no);
    if (prev === undefined) return reply(404, { status: 'failed', error: 'no such case' });
    prev.withdrawn = true;
    seen.add(req.request_id);
    return reply(200, { status: 'withdrawn' });
}

function testQueries(store: Map<string, Stored>, item: DeliveryItem): DeliveryOutcome {
    const req = JSON.parse(item.body) as { rule_set: RuleSet; cases: { code: string; query: Query }[] };
    const live = [...store.values()]
        .filter((s) => !s.withdrawn && s.set.grantee.principal_id === req.rule_set.grantee.principal_id)
        .map((s) => s.set);
    const results = req.cases.map((c) => ({ code: c.code, ...evaluateUnion(live, req.rule_set, c.query) }));
    return reply(200, { status: 'completed', results });
}

export function dcMockDelivery(options: DcMockOptions): DeliveryPort & { readonly store: ReadonlyMap<string, Stored> } {
    const keys = new Map(options.trustedKeys.map((k) => [k.key_id, createPublicKey(k.public_key_pem)]));
    const store = new Map<string, Stored>();
    const seen = new Set<string>();
    return {
        kind: 'mock',
        store,
        send(item: DeliveryItem): Promise<DeliveryOutcome> {
            if ((item.kind === 'apply' || item.kind === 'withdraw') && !signatureValid(keys, options.context, item)) {
                return Promise.resolve(reply(401, { status: 'failed', error: 'signature' }));
            }
            if (item.kind === 'apply') return Promise.resolve(apply(store, item));
            if (item.kind === 'withdraw') return Promise.resolve(withdraw(store, seen, item));
            if (item.kind === 'verify') return Promise.resolve(testQueries(store, item));
            for (const [caseNo, s] of store) if (s.set.valid.to < options.today()) store.delete(caseNo);
            return Promise.resolve(reply(200, { status: 'purged' }));
        },
    };
}
