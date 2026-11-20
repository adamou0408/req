// 平台送來的規則（data_access_rule_set/1，格式以 pack_data_access.build_fulfilment 的輸出為準）。
// 這裡只檢查「結構能不能執行」：代碼在 DC 的目錄上存在、值的型別對得上。
// 不做任何業務判斷（分級、時限、可不可以匯出），收到什麼就執行什麼。
import { findColumn, findFilter, findPackage, ROW_ID, type FilterValueType } from './catalog.ts';
import { principalIdValid, type Grantee } from './roles.ts';

const RULE_SET_FORMAT = 'data_access_rule_set/1';

interface RowCondition {
    readonly filter: string;
    readonly op: 'in' | 'between';
    readonly values: readonly (string | number | null)[];
}

export interface Rule {
    readonly rule_id: string;
    readonly system: string;
    readonly package: string;
    readonly fields: readonly string[];
    readonly row_filter: readonly RowCondition[];
    readonly data_period: { readonly field: string; readonly from: string | null; readonly to: string | null } | null;
}

export interface RuleSet {
    readonly format: string;
    readonly case_no: string;
    readonly case_version_no: number;
    readonly grantee: Grantee;
    readonly valid: { readonly from: string; readonly to: string };
    readonly export: boolean | null;
    readonly rules: readonly Rule[];
}

export class RuleSetError extends Error {}

const CASE_NO = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;
const RULE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ENUM_VALUE = 200;

export function isDate(v: unknown): v is string {
    if (typeof v !== 'string' || !DATE.test(v)) return false;
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export function caseNoValid(v: string): boolean {
    return CASE_NO.test(v);
}

function fail(message: string): never {
    throw new RuleSetError(message);
}

function obj(v: unknown, where: string): Record<string, unknown> {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(`${where} 必須是物件`);
    return v as Record<string, unknown>;
}

function str(v: unknown, where: string): string {
    if (typeof v !== 'string' || v === '' || v.includes('\u0000')) fail(`${where} 必須是非空字串`);
    return v;
}

function parseValues(type: FilterValueType, values: unknown, where: string): (string | number | null)[] {
    if (!Array.isArray(values)) fail(`${where}.values 必須是陣列`);
    if (type === 'enum') {
        if (values.length === 0) fail(`${where}.values 不可以是空的`);
        return values.map((v, i) => {
            const s = str(v, `${where}.values[${i}]`);
            if (s.length > MAX_ENUM_VALUE) fail(`${where}.values[${i}] 超過 ${MAX_ENUM_VALUE} 字元`);
            return s;
        });
    }
    if (values.length !== 2 || (values[0] === null && values[1] === null)) {
        fail(`${where}.values 必須是 [下限, 上限]，至少一個不是 null`);
    }
    return values.map((v, i) => {
        if (v === null) return null;
        if (type === 'number' && typeof v === 'number' && Number.isFinite(v)) return v;
        if (type === 'date' && isDate(v)) return v;
        return fail(`${where}.values[${i}] 必須是${type === 'number' ? '數字' : '日期'}或 null`);
    });
}

function parseCondition(pkgCode: string, raw: unknown, where: string, seen: Set<string>): RowCondition {
    const pkg = findPackage(pkgCode);
    const c = obj(raw, where);
    const filterCode = str(c['filter'], `${where}.filter`);
    const filter = pkg === undefined ? undefined : findFilter(pkg, filterCode);
    if (filter === undefined) fail(`${where}.filter：${pkgCode} 沒有列條件 ${filterCode}`);
    if (seen.has(filterCode)) fail(`${where}.filter：${filterCode} 重複`);
    seen.add(filterCode);
    const op = filter.valueType === 'enum' ? 'in' : 'between';
    if (c['op'] !== op) fail(`${where}.op：${filterCode} 只接受 ${op}`);
    return { filter: filterCode, op, values: parseValues(filter.valueType, c['values'], where) };
}

function parseRule(raw: unknown, i: number, systems: readonly string[]): Rule {
    const where = `rules[${i}]`;
    const r = obj(raw, where);
    const ruleId = str(r['rule_id'], `${where}.rule_id`);
    if (!RULE_ID.test(ruleId)) fail(`${where}.rule_id 格式不符`);
    const system = str(r['system'], `${where}.system`);
    if (!systems.includes(system)) fail(`${where}.system：本 DC 不接受 ${system} 的規則`);
    const pkgCode = str(r['package'], `${where}.package`);
    const pkg = findPackage(pkgCode);
    if (pkg === undefined) fail(`${where}.package：DC 的目錄沒有 ${pkgCode}`);
    if (!Array.isArray(r['fields']) || r['fields'].length === 0) fail(`${where}.fields 必須是非空陣列`);
    const fields = r['fields'].map((f, j) => {
        const code = str(f, `${where}.fields[${j}]`);
        if (code === ROW_ID || findColumn(pkg, code) === undefined) fail(`${where}.fields[${j}]：${pkgCode} 沒有欄位 ${code}`);
        return code;
    });
    if (new Set(fields).size !== fields.length) fail(`${where}.fields 有重複`);
    if (!Array.isArray(r['row_filter'])) fail(`${where}.row_filter 必須是陣列`);
    const seen = new Set<string>();
    const rowFilter = r['row_filter'].map((c, j) => parseCondition(pkgCode, c, `${where}.row_filter[${j}]`, seen));
    let period: Rule['data_period'] = null;
    if (r['data_period'] !== null && r['data_period'] !== undefined) {
        const p = obj(r['data_period'], `${where}.data_period`);
        if (pkg.periodField === null || p['field'] !== pkg.periodField) {
            fail(`${where}.data_period.field：${pkgCode} 的期間欄位是 ${pkg.periodField ?? '（沒有）'}`);
        }
        const from = p['from'] ?? null;
        const to = p['to'] ?? null;
        if ((from !== null && !isDate(from)) || (to !== null && !isDate(to))) fail(`${where}.data_period 的起迄必須是日期或 null`);
        period = { field: pkg.periodField, from, to };
    }
    return { rule_id: ruleId, system, package: pkgCode, fields, row_filter: rowFilter, data_period: period };
}

function parseGrantee(raw: unknown): Grantee {
    const g = obj(raw, 'grantee');
    const type = g['type'];
    if (type !== 'team' && type !== 'project' && type !== 'agent') fail('grantee.type 必須是 team、project 或 agent');
    const id = typeof g['principal_id'] === 'number' ? String(g['principal_id']) : str(g['principal_id'], 'grantee.principal_id');
    if (!principalIdValid(id)) fail('grantee.principal_id 必須是 UUID 或正整數');
    return { type, principal_id: id, name: str(g['name'], 'grantee.name') };
}

export function parseRuleSet(raw: unknown, systems: readonly string[]): RuleSet {
    const rs = obj(raw, '規則');
    if (rs['format'] !== RULE_SET_FORMAT) fail(`format 必須是 ${RULE_SET_FORMAT}`);
    const caseNo = str(rs['case_no'], 'case_no');
    if (!CASE_NO.test(caseNo)) fail('case_no 格式不符');
    const version = rs['case_version_no'];
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) fail('case_version_no 必須是正整數');
    const valid = obj(rs['valid'], 'valid');
    if (!isDate(valid['from']) || !isDate(valid['to'])) fail('valid.from、valid.to 必須是日期');
    if (valid['from'] > valid['to']) fail('valid.from 晚於 valid.to');
    const exp = rs['export'];
    if (exp !== true && exp !== false && exp !== null) fail('export 必須是 true、false 或 null');
    if (!Array.isArray(rs['rules']) || rs['rules'].length === 0) fail('rules 必須是非空陣列');
    const rules = rs['rules'].map((r, i) => parseRule(r, i, systems));
    if (new Set(rules.map((r) => r.rule_id)).size !== rules.length) fail('rule_id 有重複');
    return {
        format: RULE_SET_FORMAT,
        case_no: caseNo,
        case_version_no: version,
        grantee: parseGrantee(rs['grantee']),
        valid: { from: valid['from'], to: valid['to'] },
        export: exp,
        rules,
    };
}
