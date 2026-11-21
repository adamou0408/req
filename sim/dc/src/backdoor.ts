// ⚠ 只供測試的管理後門 ⚠
// 繞過規則直接改資料庫的權限，製造「實際設定與核准不一致」，用來測試對帳抓不抓得到。
// 需要 admin 金鑰，並且只在 SIM_DC_ENABLE_BACKDOOR=1 時開放。真實的 DC 不會有這種端點。
import { findColumn, findPackage, ROW_ID } from './catalog.ts';
import { currentCatalogSha256 } from './catalogVersion.ts';
import {
    DATA_ENVIRONMENTS,
    DataEnvironmentError,
    dataSchema,
    exportSchema,
    parseDataEnvironment,
    type DataEnvironment,
} from './dataEnvironment.ts';
import { ident, type Db } from './db.ts';
import { exportViewName, grantExport, viewColumns } from './exportView.ts';
import { createPolicySql, parsePolicyExpression, policyName } from './policy.ts';
import { dropRole, ensureRole, roleExists, roleFor, ruleRoleFor, ruleRolesOf } from './roles.ts';

export class BackdoorError extends Error {}

function fail(message: string): never {
    throw new BackdoorError(message);
}

function str(v: unknown, name: string): string {
    if (typeof v !== 'string' || v === '') fail(`${name} 必須是非空字串`);
    return v;
}

// 這個角色在這個主題包上有 policy 的區（沒有回 undefined）。
async function policyEnvironment(db: Db, pkgCode: string, role: string): Promise<DataEnvironment | undefined> {
    for (const environment of DATA_ENVIRONMENTS) {
        const hasPolicy = await db.query(
            `select 1 from pg_policy p where p.polrelid = format('%I.%I', $3::text, $1::text)::regclass
               and (select oid from pg_roles where rolname = $2) = any (p.polroles)`,
            [pkgCode, role, dataSchema(environment)],
        );
        if (hasPolicy.rowCount !== 0) return environment;
    }
    return undefined;
}

interface Target {
    readonly roles: string[];
    // 改哪一區：本文的 environment，沒有給就是那條規則所在的區（找不到規則是正式區）
    readonly environment: DataEnvironment;
}

// 多給時：指定 rule_id 就給那條規則的角色；沒指定就給這個被授權者在該主題包上第一條規則的角色
// （沒有的話給被授權者角色本身）。少給時：被授權者角色與它的每個規則角色都收回。
async function targetRoles(
    db: Db,
    principalRole: string,
    pkgCode: string,
    ruleId: string | null,
    grant: boolean,
    asked: DataEnvironment | null,
): Promise<Target> {
    const pick = (found: DataEnvironment | undefined): DataEnvironment => asked ?? found ?? 'prod';
    if (ruleId !== null) {
        const role = ruleRoleFor(principalRole, ruleId);
        if (!(await roleExists(db, role))) fail(`沒有規則 ${ruleId} 的角色`);
        return { roles: [role], environment: pick(await policyEnvironment(db, pkgCode, role)) };
    }
    const ruleRoles = await ruleRolesOf(db, principalRole);
    if (!grant) {
        let found: DataEnvironment | undefined;
        for (const role of ruleRoles) found ??= await policyEnvironment(db, pkgCode, role);
        return { roles: [principalRole, ...ruleRoles], environment: pick(found) };
    }
    for (const role of ruleRoles) {
        const environment = await policyEnvironment(db, pkgCode, role);
        if (environment !== undefined) return { roles: [role], environment: pick(environment) };
    }
    return { roles: [principalRole], environment: pick(undefined) };
}

function askedEnvironment(body: Record<string, unknown>): DataEnvironment | null {
    if (body['environment'] === undefined) return null;
    try {
        return parseDataEnvironment(body['environment'], 'environment');
    } catch (err) {
        if (err instanceof DataEnvironmentError) fail(err.message);
        throw err;
    }
}

async function grantOrRevokeColumn(db: Db, prefix: string, body: Record<string, unknown>, grant: boolean): Promise<unknown> {
    const principalId = str(body['principal_id'], 'principal_id');
    const pkg = findPackage(str(body['package'], 'package'));
    if (pkg === undefined) fail('沒有這個主題包');
    const field = str(body['field'], 'field');
    if (findColumn(pkg, field) === undefined) fail(`${pkg.code} 沒有欄位 ${field}`);
    const action = body['action'] ?? 'read';
    if (action !== 'read' && action !== 'export') fail('action 必須是 read 或 export');
    const ruleId = body['rule_id'] === undefined ? null : str(body['rule_id'], 'rule_id');
    const principalRole = roleFor(prefix, principalId);
    if (grant) {
        await ensureRole(db, principalRole, { type: 'team', principal_id: principalId, name: '（管理後門建立）' });
    } else if (!(await roleExists(db, principalRole))) {
        fail(`沒有角色 ${principalRole}`);
    }
    const { roles, environment } = await targetRoles(db, principalRole, pkg.code, ruleId, grant, askedEnvironment(body));
    for (const role of roles) await changeColumn(db, role, pkg.code, field, action, grant, environment);
    return { role: roles[0], roles, package: pkg.code, field, action, granted: grant, environment };
}

async function changeColumn(
    db: Db,
    role: string,
    pkgCode: string,
    field: string,
    action: 'read' | 'export',
    grant: boolean,
    environment: DataEnvironment,
): Promise<void> {
    const table = `${dataSchema(environment)}.${ident(pkgCode)}`;
    if (action === 'read') {
        await db.query(
            grant
                ? `grant select (${ident(ROW_ID)}, ${ident(field)}) on ${table} to ${ident(role)}`
                : `revoke select (${ident(field)}) on ${table} from ${ident(role)}`,
        );
        return;
    }
    // 匯出：把這一欄加進（或移出）角色的匯出檢視表
    const view = exportViewName(pkgCode, role);
    const current = (await viewColumns(db, view, environment)) ?? [];
    const next = grant ? [...current, field] : current.filter((c) => c !== field);
    if (next.filter((c) => c !== ROW_ID).length === 0) {
        await db.query(`drop view if exists ${exportSchema(environment)}.${ident(view)}`);
    } else {
        await grantExport(db, pkgCode, role, next, environment);
    }
}

async function policyOf(db: Db, pkgCode: string, ruleId: string): Promise<{ expr: string; roles: string[]; table: string }> {
    for (const environment of DATA_ENVIRONMENTS) {
        const r = await db.query<{ expr: string; roles: string[] }>(
            `select pg_get_expr(p.polqual, p.polrelid) as expr,
                    array(select rolname::text from pg_roles where oid = any (p.polroles)) as roles
             from pg_policy p where p.polrelid = format('%I.%I', $3::text, $1::text)::regclass and p.polname = $2`,
            [pkgCode, policyName(ruleId), dataSchema(environment)],
        );
        const row = r.rows[0];
        if (row !== undefined) return { ...row, table: `${dataSchema(environment)}.${ident(pkgCode)}` };
    }
    return fail(`${pkgCode} 上沒有規則 ${ruleId} 的 policy`);
}

export async function backdoor(db: Db, prefix: string, op: string, body: Record<string, unknown>): Promise<unknown> {
    switch (op) {
        case 'grant_column':
            return grantOrRevokeColumn(db, prefix, body, true);
        case 'revoke_column':
            return grantOrRevokeColumn(db, prefix, body, false);
        case 'drop_policy': {
            const pkg = str(body['package'], 'package');
            const ruleId = str(body['rule_id'], 'rule_id');
            if (findPackage(pkg) === undefined) fail('沒有這個主題包');
            const current = await policyOf(db, pkg, ruleId);
            await db.query(`drop policy ${ident(policyName(ruleId))} on ${current.table}`);
            return { dropped: policyName(ruleId) };
        }
        case 'clear_row_filter': {
            // 把一條規則的列條件拿掉（等於放寬成整張表），欄位與期間不變
            const pkg = str(body['package'], 'package');
            const ruleId = str(body['rule_id'], 'rule_id');
            if (findPackage(pkg) === undefined) fail('沒有這個主題包');
            const current = await policyOf(db, pkg, ruleId);
            const spec = parsePolicyExpression(current.expr);
            const role = current.roles[0];
            if (spec === null || role === undefined) fail('這個 policy 不是服務建立的形式');
            await db.query(`drop policy ${ident(policyName(ruleId))} on ${current.table}`);
            await db.query(createPolicySql({ ...spec, row_filter: [] }, role));
            return { widened: policyName(ruleId) };
        }
        case 'sabotage': {
            // 之後重算權限時默默略過這條規則（套用仍回 applied），製造「核准未設定」
            const ruleId = str(body['rule_id'], 'rule_id');
            if (body['clear'] === true) {
                await db.query('delete from simdc_meta.sabotage where rule_id = $1', [ruleId]);
            } else {
                await db.query('insert into simdc_meta.sabotage (rule_id) values ($1) on conflict do nothing', [ruleId]);
            }
            return { rule_id: ruleId, sabotaged: body['clear'] !== true };
        }
        case 'remap': {
            // 改「代碼 → 實體資源」的對照（key＝主題包，或「主題包.欄位或列條件」；resource 省略＝改回預設），目錄版本跟著變
            const key = str(body['key'], 'key');
            if (findPackage(key.split('.')[0] ?? '') === undefined) fail('沒有這個主題包');
            if (body['resource'] === undefined || body['resource'] === null) {
                await db.query('delete from simdc_meta.catalog_remap where key = $1', [key]);
            } else {
                await db.query(
                    'insert into simdc_meta.catalog_remap (key, resource) values ($1, $2) on conflict (key) do update set resource = excluded.resource',
                    [key, str(body['resource'], 'resource')],
                );
            }
            return { key, catalog_sha256: await currentCatalogSha256(db) };
        }
        case 'reset': {
            const roles = await db.query<{ rolname: string }>('select rolname from pg_roles where starts_with(rolname, $1)', [prefix]);
            for (const { rolname } of roles.rows) await dropRole(db, rolname);
            await db.query(
                'truncate simdc_meta.rule_set, simdc_meta.withdraw_request, simdc_meta.sabotage, simdc_meta.archived_case, ' +
                    'simdc_meta.usage_event, simdc_meta.catalog_remap',
            );
            return { dropped_roles: roles.rows.map((r) => r.rolname) };
        }
        default:
            return fail(`沒有這個操作：${op}`);
    }
}
