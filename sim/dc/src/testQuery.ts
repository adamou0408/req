// 測試查詢：以被授權者的資料庫角色（SET ROLE）真的去查資料庫，回報允許或拒絕與筆數，不回傳資料內容。
// 允許或拒絕完全由 PostgreSQL 決定（欄位權限、列層級安全）；程式只負責找出目標資料列、
// 以及在被拒絕時從系統目錄讀出原因給人看。整個交易最後一律 rollback，不留下任何東西。
import { findColumn, findFilter, findPackage, ROW_ID, type PackageDef } from './catalog.ts';
import { ident, isPgError, lit, withTx, type Db, type Env } from './db.ts';
import { exportViewName } from './exportView.ts';
import { parsePolicyExpression, referencedColumns } from './policy.ts';
import { roleExists, roleFor } from './roles.ts';
import { isDate } from './ruleset.ts';

interface TestQuery {
    readonly package: string;
    readonly fields: readonly string[];
    readonly row: Readonly<Record<string, string | number>>;
    readonly data_date: string | null;
    readonly action: 'query' | 'export';
    readonly as_of: string;
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
    return { package: pkg.code, fields: fields as string[], row, data_date: dataDate, action, as_of: q['as_of'] };
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
): Promise<{ ids: string[]; source: 'existing' | 'probe' | null }> {
    const found = await db.query<{ row_id: string }>(
        `select ${ROW_ID} from data.${ident(pkg.code)} where ${t.where} order by ${ROW_ID} limit 20`,
        t.params,
    );
    if (found.rowCount !== 0) return { ids: found.rows.map((r) => r.row_id), source: 'existing' };
    if (!probe) return { ids: [], source: null };
    const placeholders = t.columns.map((_, i) => `$${i + 1}::${findColumn(pkg, t.columns[i] ?? '')?.type ?? 'text'}`);
    const sql =
        t.columns.length === 0
            ? `insert into data.${ident(pkg.code)} default values returning ${ROW_ID}`
            : `insert into data.${ident(pkg.code)} (${t.columns.map(ident).join(', ')}) values (${placeholders.join(', ')}) returning ${ROW_ID}`;
    const inserted = await db.query<{ row_id: string }>(sql, t.params);
    return { ids: inserted.rows.map((r) => r.row_id), source: 'probe' };
}

async function columnPrivileges(db: Db, role: string, schema: string, pkg: string, cols: readonly string[]): Promise<boolean> {
    const r = await db.query<{ ok: boolean }>(
        `select bool_and(has_column_privilege($1, format('%I.%I', $2::text, $3::text), c, 'SELECT')) as ok
         from unnest($4::text[]) as c`,
        [role, schema, pkg, cols],
    );
    return r.rows[0]?.ok === true;
}

// 以被授權者的角色執行。權限不足（42501）、匯出檢視表裡沒有這一欄（42703）或這個角色沒有匯出檢視表（42P01）時回 null。
async function visibleAs(db: Db, role: string, relation: string, fields: readonly string[], ids: string[]): Promise<number | null> {
    await db.query('savepoint as_grantee');
    try {
        await db.query(`set local role ${ident(role)}`);
        const cols = [ROW_ID, ...fields].map(ident).join(', ');
        const r = await db.query<{ n: number }>(
            `select count(*)::int as n from (select ${cols} from ${relation} where ${ROW_ID} = any($1::bigint[])) as s`,
            [ids],
        );
        await db.query('reset role');
        await db.query('release savepoint as_grantee');
        return r.rows[0]?.n ?? 0;
    } catch (err) {
        await db.query('rollback to savepoint as_grantee');
        await db.query('reset role');
        if (['42501', '42703', '42P01'].some((code) => isPgError(err, code))) return null;
        throw err;
    }
}

// 被列層級安全擋下時，從 pg_policy 讀出這個角色在這張表上的 policy，逐一問「這一列為什麼不符合」。
async function rowReason(db: Db, role: string, pkg: PackageDef, rowId: string): Promise<string> {
    const policies = await db.query<{ expr: string }>(
        `select pg_get_expr(p.polqual, p.polrelid) as expr
         from pg_policy p
         where p.polrelid = format('data.%I', $2::text)::regclass
           and p.polpermissive and p.polcmd in ('r', '*')
           and ((select oid from pg_roles where rolname = $1) = any (p.polroles) or 0::oid = any (p.polroles))
         order by p.polname`,
        [role, pkg.code],
    );
    const reasons: string[] = [];
    for (const { expr } of policies.rows) {
        const spec = parsePolicyExpression(expr);
        if (spec === null) continue;
        const args = referencedColumns(spec).map((c) => `${lit(c)}, ${ident(c)}`);
        const r = await db.query<{ reason: string | null }>(
            `select simdc.rule_reason($1::jsonb, jsonb_build_object(${args.join(', ')})) as reason
             from data.${ident(pkg.code)} where ${ROW_ID} = $2`,
            [JSON.stringify(spec), rowId],
        );
        reasons.push(r.rows[0]?.reason ?? 'row_level_security');
    }
    return reasons[0] ?? 'no_rule';
}

// 被欄位權限擋下時的原因（從系統目錄讀）：完全沒有權限 → no_rule；查詢的欄位不足 → field_not_granted；
// 查詢可以但匯出不行 → export_not_allowed。
async function denyReason(db: Db, role: string, pkg: string, fields: readonly string[]): Promise<string> {
    const anyCol = await db.query<{ ok: boolean }>(`select has_any_column_privilege($1, format('data.%I', $2::text), 'SELECT') as ok`, [
        role,
        pkg,
    ]);
    if (anyCol.rows[0]?.ok !== true) return 'no_rule';
    return (await columnPrivileges(db, role, 'data', pkg, [ROW_ID, ...fields])) ? 'export_not_allowed' : 'field_not_granted';
}

export async function runTestQuery(env: Env, principalId: string, q: TestQuery, opts: { probe: boolean }): Promise<TestQueryResult> {
    const pkg = findPackage(q.package);
    if (pkg === undefined) fail(`DC 的目錄沒有主題包 ${q.package}`);
    const role = roleFor(env.config.rolePrefix, principalId);
    return withTx(
        env,
        async (db) => {
            await db.query(`select set_config('simdc.as_of', $1, true)`, [q.as_of]);
            const target = targetOf(pkg, q);
            const { ids, source } = await targetRows(db, pkg, target, opts.probe);
            const base = { db_role: role, rows_matching: ids.length, row_source: source };
            if (ids.length === 0) return { ...base, decision: 'no_data', reason: null, rows_visible: 0 };
            if (!(await roleExists(db, role))) return { ...base, decision: 'deny', reason: 'no_rule', rows_visible: 0 };
            const relation = q.action === 'export' ? `export.${ident(exportViewName(pkg.code, role))}` : `data.${ident(pkg.code)}`;
            const visible = await visibleAs(db, role, relation, q.fields, ids);
            if (visible === null)
                return { ...base, decision: 'deny', reason: await denyReason(db, role, pkg.code, q.fields), rows_visible: 0 };
            if (visible > 0) return { ...base, decision: 'allow', reason: null, rows_visible: visible };
            return { ...base, decision: 'deny', reason: await rowReason(db, role, pkg, ids[0] ?? ''), rows_visible: 0 };
        },
        { rollback: true },
    );
}
