// 被授權者角色：每個被授權者一個 NOLOGIN 角色。服務以 SET ROLE 代它執行測試查詢；
// 真實的 DC 會再把人員帳號加進這個角色（成員管理不在模擬範圍）。
import { ident, lit, type Db } from './db.ts';
import { dropExportViews } from './exportView.ts';

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
    // 資料表層級的 revoke 會一併收回各欄的權限
    await db.query(`revoke all on all tables in schema data from ${ident(role)}`);
    await dropExportViews(db, role);
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

// 重建結構時使用：呼叫前已經 drop schema ... cascade，角色在本資料庫已經沒有任何依賴，可以直接刪。
export async function dropManagedRoles(db: Db, prefix: string): Promise<void> {
    const roles = await db.query<{ rolname: string }>('select rolname from pg_roles where starts_with(rolname, $1)', [prefix]);
    for (const { rolname } of roles.rows) {
        await db.query(`drop role ${ident(rolname)}`);
    }
}
