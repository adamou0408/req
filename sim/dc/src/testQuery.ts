// 測試查詢：以被授權者的資料庫角色（SET ROLE）真的去查資料庫，回報允許或拒絕與筆數，不回傳資料內容。
// 允許或拒絕完全由 PostgreSQL 決定（欄位權限、列層級安全）；程式只負責找出目標資料列、
// 以及在被拒絕時從系統目錄讀出原因給人看。整個交易最後一律 rollback，不留下任何東西。
import { findColumn, findFilter, findPackage, ROW_ID, type PackageDef } from './catalog.ts';
import { DataEnvironmentError, dataSchema, exportSchema, parseDataEnvironment, type DataEnvironment } from './dataEnvironment.ts';
import { ident, isPgError, lit, withTx, type Db, type Env } from './db.ts';
import { exportViewName } from './exportView.ts';
import { parsePolicyExpression, referencedColumns } from './policy.ts';
import { roleExists, roleFor, ruleRolesOf } from './roles.ts';
import { isDate } from './ruleset.ts';

interface TestQuery {
    readonly package: string;
    readonly fields: readonly string[];
    readonly row: Readonly<Record<string, string | number>>;
    readonly data_date: string | null;
    readonly action: 'query' | 'export';
    readonly as_of: string;
    // 查哪一區（D93 (3)；沒有寫＝正式區）。驗證的反例「同一份規則在另一區查不到」靠它
    readonly environment: DataEnvironment;
}

type Decision = 'allow' | 'deny' | 'no_data';

export interface TestQueryResult {
    readonly decision: Decision;
    // 拒絕的原因（02 §8.5 的代碼），只供人閱讀；判定以 decision 為準
    readonly reason: string | null;
    readonly db_role: string;
    // 服務本身（資料表擁有者）看得到幾列符合 row 與 data_date 的資料：0 就是「本來就沒有資料」
    readonly rows_matching: number;
    // 以被授權者的角色查到幾列：權限擋下時是 0
    readonly rows_visible: number;
    // existing：用既有的資料列；probe：沒有符合的資料，在這個交易裡插入一列測試資料（最後 rollback）
    readonly row_source: 'existing' | 'probe' | null;
}

export class QueryError extends Error {}

function fail(message: string): never {
    throw new QueryError(message);
}

export function parseTestQuery(raw: unknown): TestQuery {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail('query 必須是物件');
    const q = raw as Record<string, unknown>;
    const pkg = typeof q['package'] === 'string' ? findPackage(q['package']) : undefined;
    if (pkg === undefined) fail(`DC 的目錄沒有主題包 ${String(q['package'])}`);
    const fields = q['fields'];
    if (!Array.isArray(fields) || fields.length === 0) fail('fields 必須是非空陣列');
    for (const f of fields) {
        if (typeof f !== 'string' || f === ROW_ID || findColumn(pkg, f) === undefined) fail(`${pkg.code} 沒有欄位 ${String(f)}`);
    }
    const rowRaw = q['row'] ?? {};
    if (typeof rowRaw !== 'object' || rowRaw === null || Array.isArray(rowRaw)) fail('row 必須是物件');
    const row: Record<string, string | number> = {};
    for (const [code, value] of Object.entries(rowRaw)) {
        const filter = findFilter(pkg, code);
        if (filter === undefined) fail(`${pkg.code} 沒有列條件 ${code}`);
        const ok =
            (filter.valueType === 'enum' && typeof value === 'string') ||
            (filter.valueType === 'number' && typeof value === 'number' && Number.isFinite(value)) ||
            (filter.valueType === 'date' && isDate(value));
        if (!ok) fail(`row.${code} 的值型別不符`);
        row[code] = value as string | number;
    }
    const dataDate = q['data_date'] ?? null;
    if (dataDate !== null && (!isDate(dataDate) || pkg.periodField === null)) {
        fail(pkg.periodField === null ? `${pkg.code} 沒有資料期間欄位，data_date 必須是 null` : 'data_date 必須是日期或 null');
    }
    const action = q['action'];
    if (action !== 'query' && action !== 'export') fail('action 必須是 query 或 export');
    if (!isDate(q['as_of'])) fail('as_of 必須是日期');
    let environment: DataEnvironment;
    try {
        environment = parseDataEnvironment(q['environment'], 'environment');
    } catch (err) {
        if (err instanceof DataEnvironmentError) fail(err.message);
        throw err;
    }
    return { package: pkg.code, fields: fields as string[], row, data_date: dataDate, action, as_of: q['as_of'], environment };
}

interface Target {
    readonly where: string;
    readonly params: (string | number)[];
    readonly columns: string[];
}

function targetOf(pkg: PackageDef, q: TestQuery): Target {
    const parts: string[] = [];
    const params: (string | number)[] = [];
    const columns: string[] = [];
    for (const [code, value] of Object.entries(q.row)) {
        const filter = findFilter(pkg, code);
        const col = filter === undefined ? undefined : findColumn(pkg, filter.column);
        if (filter === undefined || col === undefined) fail(`${pkg.code} 沒有列條件 ${code}`);
        params.push(value);
        columns.push(col.code);
        parts.push(`${ident(col.code)} = $${params.length}::${col.type}`);
    }
    if (q.data_date !== null && pkg.periodField !== null) {
        params.push(q.data_date);
        columns.push(pkg.periodField);
        parts.push(`${ident(pkg.periodField)} = $${params.length}::date`);
    }
    return { where: parts.length === 0 ? 'true' : parts.join(' and '), params, columns };
}

async function targetRows(
    db: Db,
    pkg: PackageDef,
    t: Target,
    probe: boolean,
    environment: DataEnvironment,
): Promise<{ ids: string[]; source: 'existing' | 'probe' | null }> {
    const table = `${dataSchema(environment)}.${ident(pkg.code)}`;
    const found = await db.query<{ row_id: string }>(
        `select ${ROW_ID} from ${table} where ${t.where} order by ${ROW_ID} limit 20`,
        t.params,
    );
    if (found.rowCount !== 0) return { ids: found.rows.map((r) => r.row_id), source: 'existing' };
    if (!probe) return { ids: [], source: null };
    const placeholders = t.columns.map((_, i) => `$${i + 1}::${findColumn(pkg, t.columns[i] ?? '')?.type ?? 'text'}`);
    const sql =
        t.columns.length === 0
            ? `insert into ${table} default values returning ${ROW_ID}`
            : `insert into ${table} (${t.columns.map(ident).join(', ')}) values (${placeholders.join(', ')}) returning ${ROW_ID}`;
    const inserted = await db.query<{ row_id: string }>(sql, t.params);
    return { ids: inserted.rows.map((r) => r.row_id), source: 'probe' };
}

// 以其中一個角色讀一個欄位，回傳它看得到的列（row_id）。權限不足（42501）、匯出檢視表裡沒有這一欄（42703）
// 或這個角色沒有匯出檢視表（42P01）時回 null：這個角色完全不涵蓋這個欄位。
async function visibleIds(db: Db, role: string, relation: string, field: string, ids: string[]): Promise<Set<string> | null> {
    await db.query('savepoint as_grantee');
    try {
        await db.query(`set local role ${ident(role)}`);
        const r = await db.query<{ row_id: string }>(
            `select ${ROW_ID}, ${ident(field)} from ${relation} where ${ROW_ID} = any($1::bigint[])`,
            [ids],
        );
        await db.query('reset role');
        await db.query('release savepoint as_grantee');
        return new Set(r.rows.map((x) => x.row_id));
    } catch (err) {
        await db.query('rollback to savepoint as_grantee');
        await db.query('reset role');
        if (['42501', '42703', '42P01'].some((code) => isPgError(err, code))) return null;
        throw err;
    }
}

interface FieldView {
    readonly field: string;
    // 每個涵蓋這個欄位的角色各自看得到的列
    readonly byRole: Map<string, Set<string>>;
}

// 被授權者的每條規則是各自的角色，欄位權限與列層級安全互不相通：一個欄位要在「涵蓋它的那條規則」的
// 範圍內才讀得到，所以對每個欄位、每個角色各查一次，再看有哪些列的每個欄位都被某條規則放行。
async function readFields(db: Db, roles: string[], pkg: PackageDef, q: TestQuery, ids: string[]): Promise<FieldView[]> {
    const out: FieldView[] = [];
    for (const field of q.fields) {
        const byRole = new Map<string, Set<string>>();
        for (const role of roles) {
            const relation =
                q.action === 'export'
                    ? `${exportSchema(q.environment)}.${ident(exportViewName(pkg.code, role))}`
                    : `${dataSchema(q.environment)}.${ident(pkg.code)}`;
            const seen = await visibleIds(db, role, relation, field, ids);
            if (seen !== null) byRole.set(role, seen);
        }
        out.push({ field, byRole });
    }
    return out;
}

function visibleRows(views: readonly FieldView[], ids: readonly string[]): string[] {
    return ids.filter((id) => views.every((v) => [...v.byRole.values()].some((seen) => seen.has(id))));
}

// 被擋下的列：從 pg_policy 讀出涵蓋這個欄位的角色的 policy，逐一問「這一列為什麼不符合」。
async function rowReason(db: Db, roles: readonly string[], pkg: PackageDef, rowId: string, environment: DataEnvironment): Promise<string> {
    const table = `${dataSchema(environment)}.${ident(pkg.code)}`;
    const policies = await db.query<{ expr: string }>(
        `select pg_get_expr(p.polqual, p.polrelid) as expr
         from pg_policy p
         where p.polrelid = format('%I.%I', $3::text, $2::text)::regclass
           and p.polpermissive and p.polcmd in ('r', '*')
           and exists (select 1 from pg_roles r where r.rolname = any($1::text[]) and r.oid = any (p.polroles))
         order by p.polname`,
        [roles, pkg.code, dataSchema(environment)],
    );
    const reasons: string[] = [];
    for (const { expr } of policies.rows) {
        const spec = parsePolicyExpression(expr);
        if (spec === null) continue;
        const args = referencedColumns(spec).map((c) => `${lit(c)}, ${ident(c)}`);
        const r = await db.query<{ reason: string | null }>(
            `select simdc.rule_reason($1::jsonb, jsonb_build_object(${args.join(', ')})) as reason
             from ${table} where ${ROW_ID} = $2`,
            [JSON.stringify(spec), rowId],
        );
        reasons.push(r.rows[0]?.reason ?? 'row_level_security');
    }
    return reasons[0] ?? 'no_rule';
}

// 被欄位權限擋下時的原因（從系統目錄讀）：沒有任何角色有這張表的權限 → no_rule；查詢的欄位有的沒有任何規則涵蓋
// → field_not_granted；欄位都涵蓋但匯出不行 → export_not_allowed。
async function denyReason(
    db: Db,
    roles: readonly string[],
    pkg: string,
    fields: readonly string[],
    environment: DataEnvironment,
): Promise<string> {
    const r = await db.query<{ any_col: boolean; all_covered: boolean }>(
        `select coalesce(bool_or(has_any_column_privilege(r, format('%I.%I', $4::text, $2::text), 'SELECT')), false) as any_col,
                coalesce((select bool_and(exists (select 1 from unnest($1::text[]) as r2
                                                  where has_column_privilege(r2, format('%I.%I', $4::text, $2::text), f, 'SELECT')))
                          from unnest($3::text[]) as f), false) as all_covered
         from unnest($1::text[]) as r`,
        [roles, pkg, fields, dataSchema(environment)],
    );
    if (r.rows[0]?.any_col !== true) return 'no_rule';
    return r.rows[0].all_covered ? 'export_not_allowed' : 'field_not_granted';
}

// 這個被授權者的角色：被授權者角色本身（正常沒有權限，後門可能給過）與每條規則的角色。
async function rolesOf(db: Db, principalRole: string): Promise<string[]> {
    if (!(await roleExists(db, principalRole))) return [];
    return [principalRole, ...(await ruleRolesOf(db, principalRole))];
}

export async function runTestQuery(env: Env, principalId: string, q: TestQuery, opts: { probe: boolean }): Promise<TestQueryResult> {
    const pkg = findPackage(q.package);
    if (pkg === undefined) fail(`DC 的目錄沒有主題包 ${q.package}`);
    const principalRole = roleFor(env.config.rolePrefix, principalId);
    return withTx(
        env,
        async (db) => {
            await db.query(`select set_config('simdc.as_of', $1, true)`, [q.as_of]);
            const target = targetOf(pkg, q);
            const { ids, source } = await targetRows(db, pkg, target, opts.probe, q.environment);
            const base = { db_role: principalRole, rows_matching: ids.length, row_source: source };
            if (ids.length === 0) return { ...base, decision: 'no_data', reason: null, rows_visible: 0 };
            const roles = await rolesOf(db, principalRole);
            if (roles.length === 0) return { ...base, decision: 'deny', reason: 'no_rule', rows_visible: 0 };
            const views = await readFields(db, roles, pkg, q, ids);
            if (views.some((v) => v.byRole.size === 0)) {
                return {
                    ...base,
                    decision: 'deny',
                    reason: await denyReason(db, roles, pkg.code, q.fields, q.environment),
                    rows_visible: 0,
                };
            }
            const visible = visibleRows(views, ids);
            if (visible.length > 0) return { ...base, decision: 'allow', reason: null, rows_visible: visible.length };
            // 第一個沒有任何一列被放行的欄位（都有的話取第一個）：它的規則為什麼擋下
            const blocked = views.find((v) => [...v.byRole.values()].every((seen) => seen.size === 0)) ?? views[0];
            const reason = await rowReason(db, [...(blocked?.byRole.keys() ?? [])], pkg, ids[0] ?? '', q.environment);
            return { ...base, decision: 'deny', reason, rows_visible: 0 };
        },
        { rollback: true },
    );
}
