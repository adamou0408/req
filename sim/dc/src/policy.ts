// 一條規則 → 一個列層級安全的 policy。規則內容（JSON）就寫在 policy 的運算式裡，
// 所以「資料庫裡實際有什麼限制」可以直接從系統目錄（pg_policy）讀回來。
import { createHash } from 'node:crypto';
import { findFilter, findPackage } from './catalog.ts';
import { ident, lit } from './db.ts';
import type { Rule, RuleSet } from './ruleset.ts';

interface PolicyCondition {
    readonly filter: string;
    readonly op: 'in' | 'between';
    readonly values: readonly (string | number | null)[];
    readonly type: 'enum' | 'number' | 'date';
    readonly column: string;
}

// 寫進 policy 的規則內容。fields 與 export 不參與列的判斷，放進來是為了對帳時知道這條 policy 屬於哪條規則的哪些欄位。
export interface PolicySpec {
    readonly v: 1;
    readonly case_no: string;
    readonly case_version_no: number;
    readonly rule_id: string;
    readonly principal_id: string;
    readonly package: string;
    readonly fields: readonly string[];
    readonly export: boolean | null;
    readonly valid: { readonly from: string; readonly to: string };
    readonly row_filter: readonly PolicyCondition[];
    readonly data_period: { readonly field: string; readonly from: string | null; readonly to: string | null } | null;
}

export function policyName(ruleId: string): string {
    const safe = ruleId
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '_')
        .slice(0, 48);
    return `rule_${safe}_${createHash('sha256').update(ruleId).digest('hex').slice(0, 8)}`;
}

export function specFor(rs: RuleSet, rule: Rule): PolicySpec {
    const pkg = findPackage(rule.package);
    if (pkg === undefined) throw new Error(`沒有主題包 ${rule.package}`);
    return {
        v: 1,
        case_no: rs.case_no,
        case_version_no: rs.case_version_no,
        rule_id: rule.rule_id,
        principal_id: rs.grantee.principal_id,
        package: rule.package,
        fields: [...rule.fields].sort(),
        export: rs.export,
        valid: rs.valid,
        row_filter: rule.row_filter.map((c) => {
            const f = findFilter(pkg, c.filter);
            if (f === undefined) throw new Error(`沒有列條件 ${c.filter}`);
            return { filter: c.filter, op: c.op, values: c.values, type: f.valueType, column: f.column };
        }),
        data_period: rule.data_period,
    };
}

export function referencedColumns(spec: PolicySpec): string[] {
    const cols = new Set(spec.row_filter.map((c) => c.column));
    if (spec.data_period !== null) cols.add(spec.data_period.field);
    return [...cols].sort();
}

function policyExpression(spec: PolicySpec): string {
    const row = referencedColumns(spec)
        .map((c) => `${lit(c)}, ${ident(c)}`)
        .join(', ');
    return `simdc.rule_match(${lit(JSON.stringify(spec))}::jsonb, jsonb_build_object(${row}))`;
}

export function createPolicySql(spec: PolicySpec, role: string): string {
    return (
        `create policy ${ident(policyName(spec.rule_id))} on data.${ident(spec.package)} ` +
        `as permissive for select to ${ident(role)} using (${policyExpression(spec)})`
    );
}

// pg_get_expr 讀回的運算式 → 規則內容。只認得服務自己產生的形式；其他形式（例如有人直接在資料庫
// 建了 using (true) 的 policy）回 null，對帳時當成「沒有可辨識的限制」。
const EXPR = /^simdc\.rule_match\('((?:[^']|'')*)'::jsonb, jsonb_build_object\((.*)\)\)$/s;

export function parsePolicyExpression(expr: string): PolicySpec | null {
    const m = EXPR.exec(expr.trim());
    if (m === null || m[1] === undefined || m[2] === undefined) return null;
    let spec: PolicySpec;
    try {
        spec = JSON.parse(m[1].replaceAll("''", "'")) as PolicySpec;
    } catch {
        return null;
    }
    if (spec.v !== 1 || !Array.isArray(spec.row_filter)) return null;
    // 第二個參數必須正好把每個條件欄位傳成同名的鍵，否則條件判斷的不是那一欄
    const expected = referencedColumns(spec)
        .map((c) => `'${c}', ${c}`)
        .join(', ');
    return m[2] === expected ? spec : null;
}
