// 被授權者角色：每個被授權者一個 NOLOGIN 角色。服務以 SET ROLE 代它執行測試查詢；
// 真實的 DC 會再把人員帳號加進這個角色（成員管理不在模擬範圍）。
import { ident, lit, type Db } from './db.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INTEGER = /^[1-9][0-9]{0,18}$/;

export interface Grantee {
    readonly type: 'team' | 'project' | 'agent';
    readonly principal_id: string;
    readonly name: string;
}

// principal_id 只接受 UUID 或正整數：轉成角色名稱時不會撞名、不會超過 63 字元，也不需要跳脫。
export function principalIdValid(id: string): boolean {
    return UUID.test(id) || INTEGER.test(id);
}

export function roleFor(prefix: string, principalId: string): string {
    if (!principalIdValid(principalId)) throw new Error(`principal_id 格式不符：${principalId}`);
    return prefix + principalId.toLowerCase().replaceAll('-', '');
}

export async function roleExists(db: Db, role: string): Promise<boolean> {
    const r = await db.query('select 1 from pg_roles where rolname = $1', [role]);
    return r.rowCount !== 0;
}

// 角色的說明（pg_shdescription）記下它代表哪個被授權者：對帳從系統目錄讀回主體，不讀服務的紀錄。
export async function ensureRole(db: Db, role: string, grantee: Grantee): Promise<void> {
    if (!(await roleExists(db, role))) {
        await db.query(`create role ${ident(role)} nologin`);
    }
    await db.query(`grant ${ident(role)} to current_user with set true, inherit false`);
    const comment = JSON.stringify({ principal_id: grantee.principal_id, type: grantee.type, name: grantee.name });
    await db.query(`comment on role ${ident(role)} is ${lit(comment)}`);
    for (const schema of ['data', 'export', 'simdc']) {
        await db.query(`grant usage on schema ${schema} to ${ident(role)}`);
    }
}

// 收回角色在本資料庫的全部權限與 policy。
export async function clearRole(db: Db, role: string): Promise<void> {
    if (!(await roleExists(db, role))) return;
    const policies = await db.query<{ polname: string; relname: string }>(
        `select p.polname, c.relname
         from pg_policy p
         join pg_class c on c.oid = p.polrelid
         join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'data' and p.polroles = array[(select oid from pg_roles where rolname = $1)]`,
        [role],
    );
    for (const p of policies.rows) {
        await db.query(`drop policy ${ident(p.polname)} on data.${ident(p.relname)}`);
    }
    for (const schema of ['data', 'export']) {
        await db.query(`revoke all on all tables in schema ${schema} from ${ident(role)}`);
    }
    // 欄位層級的權限不會被 revoke ... on all tables 收回，要逐表逐欄收
    const cols = await db.query<{ nspname: string; relname: string; attname: string }>(
        `select n.nspname, c.relname, a.attname
         from pg_attribute a
         join pg_class c on c.oid = a.attrelid
         join pg_namespace n on n.oid = c.relnamespace
         cross join lateral aclexplode(a.attacl) as x
         where n.nspname in ('data', 'export') and a.attnum > 0 and not a.attisdropped
           and x.grantee = (select oid from pg_roles where rolname = $1)`,
        [role],
    );
    for (const c of cols.rows) {
        await db.query(`revoke all (${ident(c.attname)}) on ${ident(c.nspname)}.${ident(c.relname)} from ${ident(role)}`);
    }
}

// 沒有任何規則了就刪掉角色，撤回後連角色都不留。
export async function dropRole(db: Db, role: string): Promise<void> {
    if (!(await roleExists(db, role))) return;
    await clearRole(db, role);
    for (const schema of ['data', 'export', 'simdc']) {
        await db.query(`revoke all on schema ${schema} from ${ident(role)}`);
    }
    await db.query(`drop role ${ident(role)}`);
}

export async function dropManagedRoles(db: Db, prefix: string): Promise<void> {
    const roles = await db.query<{ rolname: string }>(
        `select rolname from pg_roles where starts_with(rolname, $1) and pg_has_role(current_user, oid, 'USAGE')`,
        [prefix],
    );
    for (const { rolname } of roles.rows) {
        // 結構可能還沒建立（第一次啟動）或已經損壞：先收回本資料庫裡它擁有的一切，再刪角色
        await db.query(`drop owned by ${ident(rolname)}`);
        await db.query(`drop role ${ident(rolname)}`);
    }
}
