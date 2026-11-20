// 對帳回報：列出資料庫裡「實際存在」的權限。全部從系統目錄讀：
//   欄位權限  has_column_privilege（含資料表層級的授權、角色繼承、PUBLIC、pg_read_all_data）
//   列的限制  pg_policy 的運算式（pg_get_expr），解析回規則內容
//   主體      角色說明（pg_shdescription）
// 不讀服務自己記的規則表（simdc_meta.rule_set）。格式對齊 05-integration.md §8.3 的上傳項目。
import { PACKAGES, ROW_ID } from './catalog.ts';
import type { Db } from './db.ts';
import { exportPrivileges } from './exportView.ts';
import { parsePolicyExpression, type PolicySpec } from './policy.ts';

interface Privilege {
    rolname: string;
    tbl: string;
    col: string;
}

interface PolicyRow {
    relname: string;
    polname: string;
    expr: string | null;
    roles: string[];
}

interface Subject {
    readonly type: 'principal';
    readonly id: string;
    readonly properties: Record<string, unknown>;
}

interface ReconciliationItem {
    readonly item_key: string;
    readonly subject: Subject;
    readonly resource: { readonly type: 'data_field'; readonly id: string };
    readonly action: { readonly name: 'read' | 'export' };
    readonly entitlement_id: null;
    readonly constraints: Record<string, unknown>;
    readonly properties: Record<string, unknown>;
}

async function privileges(db: Db): Promise<Privilege[]> {
    const tables: string[] = [];
    const cols: string[] = [];
    for (const pkg of PACKAGES) {
        for (const c of pkg.columns) {
            tables.push(pkg.code);
            cols.push(c.code);
        }
    }
    // 排除：superuser（另外列出）、內建的 pg_* 角色（它們的成員會各自出現）、資料表擁有者（服務自己）
    const r = await db.query<Privilege>(
        `select r.rolname, x.tbl, x.col
         from pg_roles r
         cross join unnest($1::text[], $2::text[]) as x (tbl, col)
         where not r.rolsuper and r.rolname !~ '^pg_' and r.rolname <> current_user
           and has_column_privilege(r.oid, format('data.%I', x.tbl), x.col, 'SELECT')
         order by r.rolname, x.tbl, x.col`,
        [tables, cols],
    );
    return r.rows;
}

async function policies(db: Db): Promise<PolicyRow[]> {
    const r = await db.query<PolicyRow>(
        `select c.relname, p.polname, pg_get_expr(p.polqual, p.polrelid) as expr,
                array(select case when o = 0 then 'public' else (select rolname::text from pg_roles where oid = o) end
                      from unnest(p.polroles) as o) as roles
         from pg_policy p
         join pg_class c on c.oid = p.polrelid
         join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'data' and p.polpermissive and p.polcmd in ('r', '*')
         order by c.relname, p.polname`,
    );
    return r.rows;
}

async function subjects(db: Db, roles: string[]): Promise<Map<string, Subject>> {
    const r = await db.query<{ rolname: string; comment: string | null }>(
        `select rolname, shobj_description(oid, 'pg_authid') as comment from pg_roles where rolname = any($1)`,
        [roles],
    );
    const out = new Map<string, Subject>();
    for (const { rolname, comment } of r.rows) {
        let parsed: { principal_id?: unknown; type?: unknown } = {};
        try {
            parsed = comment === null ? {} : (JSON.parse(comment) as typeof parsed);
        } catch {
            parsed = {};
        }
        out.set(
            rolname,
            typeof parsed.principal_id === 'string'
                ? { type: 'principal', id: parsed.principal_id, properties: { provider: 'sgn', kind: parsed.type } }
                : // 不是服務建立的角色：沒有被授權者可以對應，用角色名稱回報（平台會判為未核准）
                  { type: 'principal', id: rolname, properties: { provider: 'dc_db_role' } },
        );
    }
    return out;
}

async function memberships(db: Db, roles: string[], policyRoles: string[]): Promise<Set<string>> {
    const r = await db.query<{ member: string; role: string }>(
        `select m.rolname as member, p.rolname as role
         from pg_roles m cross join pg_roles p
         where m.rolname = any($1) and p.rolname = any($2) and m.oid <> p.oid and pg_has_role(m.oid, p.oid, 'MEMBER')`,
        [roles, policyRoles],
    );
    return new Set(r.rows.map((x) => `${x.member}\u0000${x.role}`));
}

function constraintsOf(spec: PolicySpec): Record<string, unknown> {
    const out: Record<string, unknown> = {
        row_filter: spec.row_filter.map((c) => ({ filter: c.filter, op: c.op, values: c.values })),
    };
    if (spec.data_period !== null) out['data_period'] = spec.data_period;
    return out;
}

interface ReconciliationReport {
    readonly format: 'dc_reconciliation_report/1';
    readonly observed_at: string;
    readonly database: string;
    readonly process_type: 'data_access';
    readonly resource_type: 'data_field';
    readonly items: ReconciliationItem[];
    readonly superusers: string[];
    readonly rls_disabled: string[];
}

export async function reconciliationReport(db: Db, today: string): Promise<ReconciliationReport> {
    const observedAt = new Date().toISOString();
    const privs = await privileges(db);
    const pols = await policies(db);
    const roles = [...new Set(privs.map((p) => p.rolname))];
    const subj = await subjects(db, roles);
    const member = await memberships(db, roles, [...new Set(pols.flatMap((p) => p.roles))]);
    const rls = await db.query<{ relname: string; relrowsecurity: boolean }>(
        `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'data' and c.relkind = 'r'`,
    );
    const rlsOn = new Map(rls.rows.map((r) => [r.relname, r.relrowsecurity]));
    const supers = await db.query<{ rolname: string }>(`select rolname from pg_roles where rolsuper order by rolname`);
    const exportable = new Set((await exportPrivileges(db)).map((p) => `${p.rolname}|${p.tbl}|${p.col}`));

    const items: ReconciliationItem[] = [];
    for (const p of privs) {
        if (p.col === ROW_ID) continue;
        const subject = subj.get(p.rolname);
        if (subject === undefined) continue;
        const actions: ('read' | 'export')[] = ['read'];
        // 匯出要同時有匯出檢視表與底表的權限（檢視表以呼叫者身分讀底表）
        if (exportable.has(`${p.rolname}|${p.tbl}|${p.col}`)) actions.push('export');
        const applicable = pols.filter(
            (x) =>
                x.relname === p.tbl &&
                (x.roles.includes(p.rolname) || x.roles.includes('public') || x.roles.some((r) => member.has(`${p.rolname}\u0000${r}`))),
        );
        const entries: { constraints: Record<string, unknown>; properties: Record<string, unknown>; policy: string }[] = [];
        if (rlsOn.get(p.tbl) !== true) {
            entries.push({ constraints: {}, properties: { row_level_security: 'disabled' }, policy: '-' });
        } else {
            const parsed = applicable.map((x) => ({ x, spec: x.expr === null ? null : parsePolicyExpression(x.expr) }));
            for (const { x, spec } of parsed) {
                if (spec === null) {
                    entries.push({
                        constraints: {},
                        properties: { policy_expression: x.expr, unrecognized_policy: true },
                        policy: x.polname,
                    });
                } else if (spec.fields.includes(p.col) || parsed.every((e) => e.spec === null || !e.spec.fields.includes(p.col))) {
                    entries.push({
                        constraints: constraintsOf(spec),
                        properties: {
                            rule_id: spec.rule_id,
                            case_no: spec.case_no,
                            case_version_no: spec.case_version_no,
                            valid: spec.valid,
                            effective_now: spec.valid.from <= today && today <= spec.valid.to,
                            ...(spec.fields.includes(p.col) ? {} : { column_not_in_rule: true }),
                        },
                        policy: x.polname,
                    });
                }
            }
            if (entries.length === 0) {
                // 有欄位權限但沒有任何 policy：目前一列都看不到，但權限確實存在（例如 policy 被刪掉）
                entries.push({ constraints: {}, properties: { rows_visible: 'none', no_policy: true }, policy: '-' });
            }
        }
        for (const action of actions) {
            for (const e of entries) {
                items.push({
                    item_key: `${p.rolname}|${p.tbl}.${p.col}|${action}|${e.policy}`,
                    subject,
                    resource: { type: 'data_field', id: `${p.tbl}.${p.col}` },
                    action: { name: action },
                    entitlement_id: null,
                    constraints: e.constraints,
                    properties: { db_role: p.rolname, policy: e.policy, ...e.properties },
                });
            }
        }
    }
    return {
        format: 'dc_reconciliation_report/1',
        observed_at: observedAt,
        database: (await db.query<{ d: string }>('select current_database() as d')).rows[0]?.d ?? '',
        process_type: 'data_access',
        resource_type: 'data_field',
        items,
        superusers: supers.rows.map((r) => r.rolname),
        rls_disabled: [...rlsOn].filter(([, on]) => !on).map(([t]) => t),
    };
}
