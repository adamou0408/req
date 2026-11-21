// 匯出與查詢分開：查詢讀 data.<主題包>（測試區 data_test）；匯出只能讀 export（測試區 export_test）裡「這個角色專屬」的檢視表，
// 需要另外授予。檢視表以呼叫者身分讀底表（security_invoker），所以欄位權限與列層級安全照樣生效。
// 為什麼每個角色一個檢視表：security_invoker 的檢視表會以呼叫者身分檢查它引用的「每一個」底表欄位，
// 共用一個 select * 的檢視表，只有部分欄位權限的角色就完全讀不到。
import { createHash } from 'node:crypto';
import { PACKAGES, ROW_ID } from './catalog.ts';
import {
    DATA_ENVIRONMENTS,
    DATA_SCHEMAS,
    EXPORT_SCHEMAS,
    dataSchema,
    environmentOfSchema,
    exportSchema,
    type DataEnvironment,
} from './dataEnvironment.ts';
import { ident, type Db } from './db.ts';

export function exportViewName(pkg: string, role: string): string {
    return `${pkg}__${createHash('sha256').update(role).digest('hex').slice(0, 10)}`;
}

export async function viewColumns(db: Db, view: string, environment: DataEnvironment): Promise<string[] | null> {
    const r = await db.query<{ attname: string }>(
        `select a.attname from pg_attribute a
         where a.attrelid = to_regclass(format('%I.%I', $2::text, $1::text)) and a.attnum > 0 and not a.attisdropped
         order by a.attnum`,
        [view, exportSchema(environment)],
    );
    return r.rowCount === 0 ? null : r.rows.map((x) => x.attname);
}

// 建立（或換掉）一個角色在一個主題包上（某一區）的匯出檢視表，內容是 row_id 與給定的欄位。
export async function grantExport(
    db: Db,
    pkg: string,
    role: string,
    fields: Iterable<string>,
    environment: DataEnvironment,
): Promise<void> {
    const view = exportViewName(pkg, role);
    const cols = [ROW_ID, ...[...new Set(fields)].filter((f) => f !== ROW_ID).sort()];
    const ex = exportSchema(environment);
    await db.query(`drop view if exists ${ex}.${ident(view)}`);
    await db.query(
        `create view ${ex}.${ident(view)} with (security_invoker = true) as select ${cols.map(ident).join(', ')} from ${dataSchema(environment)}.${ident(pkg)}`,
    );
    await db.query(`grant select on ${ex}.${ident(view)} to ${ident(role)}`);
}

export async function dropExportViews(db: Db, role: string): Promise<void> {
    for (const environment of DATA_ENVIRONMENTS) {
        for (const pkg of PACKAGES) {
            await db.query(`drop view if exists ${exportSchema(environment)}.${ident(exportViewName(pkg.code, role))}`);
        }
    }
}

interface ExportPrivilege {
    rolname: string;
    tbl: string;
    col: string;
    environment: DataEnvironment;
}

// 從系統目錄讀：哪些角色可以經由 export schema 的哪個檢視表讀到哪個底表的哪一欄
// （檢視表的欄位權限，加上底表同一欄的權限，兩者都要有）。
export async function exportPrivileges(db: Db): Promise<ExportPrivilege[]> {
    // 檢視表與它的底表可以在不同的區（例如有人手動建了跨區的檢視表）：以底表所在的區為準
    const r = await db.query<{ rolname: string; tbl: string; col: string; nspname: string }>(
        `select distinct r.rolname, t.relname as tbl, a.attname as col, tn.nspname
         from pg_class v
         join pg_namespace vn on vn.oid = v.relnamespace and vn.nspname = any($1::text[])
         join pg_rewrite rw on rw.ev_class = v.oid
         join pg_depend d on d.objid = rw.oid and d.classid = 'pg_rewrite'::regclass and d.refclassid = 'pg_class'::regclass
         join pg_class t on t.oid = d.refobjid
         join pg_namespace tn on tn.oid = t.relnamespace and tn.nspname = any($2::text[])
         join pg_attribute a on a.attrelid = v.oid and a.attnum > 0 and not a.attisdropped
         cross join pg_roles r
         where v.relkind = 'v' and not r.rolsuper and r.rolname !~ '^pg_' and r.rolname <> current_user
           and has_column_privilege(r.oid, v.oid, a.attname, 'SELECT')
           and has_column_privilege(r.oid, t.oid, a.attname, 'SELECT')
         order by 1, 2, 3, 4`,
        [EXPORT_SCHEMAS, DATA_SCHEMAS],
    );
    return r.rows.flatMap((x) => {
        const environment = environmentOfSchema(x.nspname);
        return environment === undefined ? [] : [{ rolname: x.rolname, tbl: x.tbl, col: x.col, environment }];
    });
}
