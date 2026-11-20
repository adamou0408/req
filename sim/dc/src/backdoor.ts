// ⚠ 只供測試的管理後門 ⚠
// 繞過規則直接改資料庫的權限，製造「實際設定與核准不一致」，用來測試對帳抓不抓得到。
// 需要 admin 金鑰，並且只在 SIM_DC_ENABLE_BACKDOOR=1 時開放。真實的 DC 不會有這種端點。
import { findColumn, findPackage, ROW_ID } from './catalog.ts';
import { ident, type Db } from './db.ts';
import { exportViewName, grantExport, viewColumns } from './exportView.ts';
import { createPolicySql, parsePolicyExpression, policyName } from './policy.ts';
import { dropRole, ensureRole, roleExists, roleFor } from './roles.ts';

export class BackdoorError extends Error {}

function fail(message: string): never {
    throw new BackdoorError(message);
}

function str(v: unknown, name: string): string {
    if (typeof v !== 'string' || v === '') fail(`${name} 必須是非空字串`);
    return v;
}

async function grantOrRevokeColumn(db: Db, prefix: string, body: Record<string, unknown>, grant: boolean): Promise<unknown> {
    const principalId = str(body['principal_id'], 'principal_id');
    const pkg = findPackage(str(body['package'], 'package'));
    if (pkg === undefined) fail('沒有這個主題包');
    const field = str(body['field'], 'field');
    if (findColumn(pkg, field) === undefined) fail(`${pkg.code} 沒有欄位 ${field}`);
    const action = body['action'] ?? 'read';
    if (action !== 'read' && action !== 'export') fail('action 必須是 read 或 export');
    const role = roleFor(prefix, principalId);
    if (grant) {
        await ensureRole(db, role, { type: 'team', principal_id: principalId, name: '（管理後門建立）' });
    } else if (!(await roleExists(db, role))) {
        fail(`沒有角色 ${role}`);
    }
    if (action === 'read') {
        await db.query(
            grant
                ? `grant select (${ident(ROW_ID)}, ${ident(field)}) on data.${ident(pkg.code)} to ${ident(role)}`
                : `revoke select (${ident(field)}) on data.${ident(pkg.code)} from ${ident(role)}`,
        );
    } else {
        // 匯出：把這一欄加進（或移出）角色的匯出檢視表
        const current = (await viewColumns(db, exportViewName(pkg.code, role))) ?? [];
        const next = grant ? [...current, field] : current.filter((c) => c !== field);
        if (next.filter((c) => c !== ROW_ID).length === 0) {
            await db.query(`drop view if exists export.${ident(exportViewName(pkg.code, role))}`);
        } else {
            await grantExport(db, pkg.code, role, next);
        }
    }
    return { role, package: pkg.code, field, action, granted: grant };
}

async function policyOf(db: Db, pkgCode: string, ruleId: string): Promise<{ expr: string; roles: string[] }> {
    const r = await db.query<{ expr: string; roles: string[] }>(
        `select pg_get_expr(p.polqual, p.polrelid) as expr,
                array(select rolname::text from pg_roles where oid = any (p.polroles)) as roles
         from pg_policy p where p.polrelid = format('data.%I', $1::text)::regclass and p.polname = $2`,
        [pkgCode, policyName(ruleId)],
    );
    const row = r.rows[0];
    if (row === undefined) fail(`${pkgCode} 上沒有規則 ${ruleId} 的 policy`);
    return row;
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
            await policyOf(db, pkg, ruleId);
            await db.query(`drop policy ${ident(policyName(ruleId))} on data.${ident(pkg)}`);
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
            await db.query(`drop policy ${ident(policyName(ruleId))} on data.${ident(pkg)}`);
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
        case 'reset': {
            const roles = await db.query<{ rolname: string }>('select rolname from pg_roles where starts_with(rolname, $1)', [prefix]);
            for (const { rolname } of roles.rows) await dropRole(db, rolname);
            await db.query('truncate simdc_meta.rule_set, simdc_meta.withdraw_request, simdc_meta.sabotage');
            return { dropped_roles: roles.rows.map((r) => r.rolname) };
        }
        default:
            return fail(`沒有這個操作：${op}`);
    }
}
