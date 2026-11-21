// 套用與撤回。做法：服務記下「收到並接受了哪些規則」（simdc_meta.rule_set），
// 每次異動就把該被授權者在資料庫裡的權限整個重算一次（收回全部 → 依目前的規則重新授予）。
// 所以同一份規則送兩次結果相同（冪等），縮小、撤回也只是重算後少了一些權限。
import { createHash } from 'node:crypto';
import { ROW_ID } from './catalog.ts';
import { dataSchema } from './dataEnvironment.ts';
import { ident, type Db } from './db.ts';
import { grantExport } from './exportView.ts';
import { createPolicySql, specFor } from './policy.ts';
import { clearRole, dropRole, dropSingleRole, ensureRole, roleFor, ruleRoleFor, ruleRolesOf } from './roles.ts';
import { ruleSetEnvironment, type Rule, type RuleSet } from './ruleset.ts';

export class ApplyConflict extends Error {}

/** 整張單撤回過（封存）：任何版本都不再接受。 */
export class CaseArchived extends Error {}

async function archived(db: Db, caseNo: string): Promise<boolean> {
    return (await db.query('select 1 from simdc_meta.archived_case where case_no = $1', [caseNo])).rowCount !== 0;
}

interface StoredRuleSet {
    case_no: string;
    case_version_no: number;
    principal_id: string;
    role_name: string;
    body: RuleSet;
    body_sha256: string;
    status: 'applied' | 'withdrawn';
    withdrawn_rule_ids: string[];
    purged_rule_ids: string[];
    applied_at: string;
}

function dcRef(caseNo: string, version: number): string {
    return `DC-${caseNo}-v${version}`;
}

function sha256(text: string): string {
    return createHash('sha256').update(text).digest('hex');
}

async function lockPrincipal(db: Db, role: string): Promise<void> {
    await db.query('select pg_advisory_xact_lock(hashtext($1))', [role]);
}

async function stored(db: Db, caseNo: string): Promise<StoredRuleSet | null> {
    const r = await db.query<StoredRuleSet>('select * from simdc_meta.rule_set where case_no = $1 for update', [caseNo]);
    return r.rows[0] ?? null;
}

// 依服務記下的規則，重算一個被授權者在資料庫裡的全部權限：每條有效的規則一個角色
// （欄位權限、policy、匯出檢視表都只掛在那個角色上），被撤回、已清除、或被後門略過的規則沒有角色。
async function recompute(db: Db, prefix: string, principalId: string): Promise<void> {
    const role = roleFor(prefix, principalId);
    await lockPrincipal(db, role);
    const sets = await db.query<{ body: RuleSet; withdrawn_rule_ids: string[]; purged_rule_ids: string[] }>(
        `select body, withdrawn_rule_ids, purged_rule_ids from simdc_meta.rule_set
         where principal_id = $1 and status = 'applied' order by case_no`,
        [principalId],
    );
    const sabotaged = new Set((await db.query<{ rule_id: string }>('select rule_id from simdc_meta.sabotage')).rows.map((r) => r.rule_id));
    const live: { body: RuleSet; rule: Rule }[] = [];
    for (const { body, withdrawn_rule_ids: withdrawn, purged_rule_ids: purged } of sets.rows) {
        for (const rule of body.rules) {
            if (withdrawn.includes(rule.rule_id) || purged.includes(rule.rule_id) || sabotaged.has(rule.rule_id)) continue;
            live.push({ body, rule });
        }
    }
    // 被略過（後門）的規則仍算「有規則」：角色留著，只是沒有那條規則的權限
    const remaining = sets.rows.filter((s) =>
        s.body.rules.some((r) => !s.withdrawn_rule_ids.includes(r.rule_id) && !s.purged_rule_ids.includes(r.rule_id)),
    );
    const latest = remaining[remaining.length - 1];
    if (latest === undefined) {
        await dropRole(db, role);
        return;
    }
    await ensureRole(db, role, latest.body.grantee);
    await clearRole(db, role);
    const wanted = new Set(live.map(({ rule }) => ruleRoleFor(role, rule.rule_id)));
    for (const old of await ruleRolesOf(db, role)) {
        if (!wanted.has(old)) await dropSingleRole(db, old);
    }
    for (const { body, rule } of live) await grantRule(db, role, body, rule);
}

async function grantRule(db: Db, principalRole: string, body: RuleSet, rule: Rule): Promise<void> {
    const ruleRole = ruleRoleFor(principalRole, rule.rule_id);
    await ensureRole(db, ruleRole, body.grantee, rule.rule_id);
    await clearRole(db, ruleRole);
    const cols = [ROW_ID, ...rule.fields].map(ident).join(', ');
    // 只給規則那一區的資料表（D93 (3)：兩區是不同的資料庫物件）
    const environment = ruleSetEnvironment(body);
    await db.query(`grant select (${cols}) on ${dataSchema(environment)}.${ident(rule.package)} to ${ident(ruleRole)}`);
    await db.query(createPolicySql(specFor(body, rule), ruleRole));
    // export 是 null 代表平台不設定匯出的限制（02 §5.10 範例 3），所以和 true 一樣給匯出權限
    if (body.export !== false) await grantExport(db, rule.package, ruleRole, rule.fields, environment);
}

interface ApplyResult {
    readonly status: 'applied';
    readonly dc_ref: string;
    readonly unchanged: boolean;
    // 實際套用到的區（已簽的回應帶它，平台比對：D93 (3)）
    readonly environment: string;
}

export async function applyRuleSet(
    db: Db,
    prefix: string,
    rs: RuleSet,
    meta: { keyId: string; requestId: string | null },
): Promise<ApplyResult> {
    const role = roleFor(prefix, rs.grantee.principal_id);
    const canonical = JSON.stringify(rs);
    const hash = sha256(canonical);
    if (await archived(db, rs.case_no)) {
        throw new CaseArchived(`${rs.case_no} 已經整張撤回（封存），不再接受任何版本`);
    }
    const prev = await stored(db, rs.case_no);
    if (prev !== null) {
        if (rs.case_version_no < prev.case_version_no) {
            throw new ApplyConflict(`已套用第 ${prev.case_version_no} 版，不接受較舊的第 ${rs.case_version_no} 版`);
        }
        if (rs.case_version_no === prev.case_version_no) {
            if (prev.status === 'withdrawn') {
                throw new ApplyConflict(`第 ${rs.case_version_no} 版已經撤回，不能再套用同一版（防止重送舊的已簽章規則）`);
            }
            if (prev.body_sha256 !== hash) {
                throw new ApplyConflict(`第 ${rs.case_version_no} 版已經以不同的內容套用過`);
            }
            if (prev.withdrawn_rule_ids.length > 0) {
                throw new ApplyConflict(`第 ${rs.case_version_no} 版有部分規則已經撤回，不能再套用同一版`);
            }
            // 同一份規則再送一次：仍然重算，讓資料庫回到規則描述的狀態
            await recompute(db, prefix, rs.grantee.principal_id);
            return {
                status: 'applied',
                dc_ref: dcRef(rs.case_no, rs.case_version_no),
                unchanged: true,
                environment: ruleSetEnvironment(rs),
            };
        }
    }
    await db.query(
        `insert into simdc_meta.rule_set
             (case_no, case_version_no, principal_id, role_name, body, body_sha256, key_id, request_id, status,
              withdrawn_rule_ids, purged_rule_ids, applied_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'applied', '{}', '{}', now(), now())
         on conflict (case_no) do update set
             case_version_no = excluded.case_version_no, principal_id = excluded.principal_id,
             role_name = excluded.role_name, body = excluded.body, body_sha256 = excluded.body_sha256,
             key_id = excluded.key_id, request_id = excluded.request_id, status = 'applied',
             withdrawn_rule_ids = '{}', purged_rule_ids = '{}', updated_at = now()`,
        [rs.case_no, rs.case_version_no, rs.grantee.principal_id, role, canonical, hash, meta.keyId, meta.requestId],
    );
    await recompute(db, prefix, rs.grantee.principal_id);
    // 新版換了被授權者時，舊的被授權者也要重算（收回它的權限）
    if (prev !== null && prev.principal_id !== rs.grantee.principal_id) {
        await recompute(db, prefix, prev.principal_id);
    }
    return { status: 'applied', dc_ref: dcRef(rs.case_no, rs.case_version_no), unchanged: false, environment: ruleSetEnvironment(rs) };
}

interface WithdrawRequest {
    readonly request_id: string;
    readonly case_no: string;
    readonly rule_ids: readonly string[] | null;
}

export class WithdrawNotFound extends Error {}

/**
 * 撤回。省略 rule_ids（整張單）時先封存這張單：就算這裡從來沒有套用過（not_found），之後送來的任何版本也不收，
 * 所以封存要和回應一起提交，不能因為 404 而回滾。
 */
export async function withdrawRules(db: Db, prefix: string, req: WithdrawRequest): Promise<{ status: 'withdrawn' | 'not_found' }> {
    const seen = await db.query('select 1 from simdc_meta.withdraw_request where request_id = $1', [req.request_id]);
    // 同一個 request_id 重送：不再動作（簽章過的撤回請求被重放，也不會撤掉之後重新套用的規則）
    if (seen.rowCount !== 0) return { status: 'withdrawn' };
    if (req.rule_ids === null) {
        await db.query('insert into simdc_meta.archived_case (case_no, request_id) values ($1, $2) on conflict (case_no) do nothing', [
            req.case_no,
            req.request_id,
        ]);
    }
    const prev = await stored(db, req.case_no);
    if (prev === null) return { status: 'not_found' };
    const all = prev.body.rules.map((r) => r.rule_id);
    const targets = req.rule_ids ?? all;
    const unknown = targets.filter((id) => !all.includes(id));
    if (unknown.length > 0) throw new WithdrawNotFound(`${req.case_no} 沒有規則 ${unknown.join('、')}`);
    const withdrawn = [...new Set([...prev.withdrawn_rule_ids, ...targets])].sort();
    const status = all.every((id) => withdrawn.includes(id)) ? 'withdrawn' : 'applied';
    await db.query(`update simdc_meta.rule_set set withdrawn_rule_ids = $2, status = $3, updated_at = now() where case_no = $1`, [
        req.case_no,
        withdrawn,
        status,
    ]);
    await recompute(db, prefix, prev.principal_id);
    await db.query('insert into simdc_meta.withdraw_request (request_id, case_no, result) values ($1, $2, $3)', [
        req.request_id,
        req.case_no,
        JSON.stringify({ status: 'withdrawn', rule_ids: targets }),
    ]);
    return { status: 'withdrawn' };
}

interface PurgedRule {
    readonly case_no: string;
    readonly rule_id: string;
    readonly db_role: string;
}

// 清除授權期間已經結束的規則：收回它的角色、欄位權限、policy 與匯出檢視表。
// 到期當下 RLS 就一列都不放行，這裡只是把目錄上殘留的權限拿掉。清除是單向的：同一版重送不會讓它回來。
export async function purgeExpired(db: Db, prefix: string, today: string): Promise<PurgedRule[]> {
    const sets = await db.query<StoredRuleSet>(
        `select * from simdc_meta.rule_set where status = 'applied' and (body #>> '{valid,to}')::date < $1::date order by case_no for update`,
        [today],
    );
    const purged: PurgedRule[] = [];
    const principals = new Set<string>();
    for (const set of sets.rows) {
        const todo = set.body.rules.filter((r) => !set.withdrawn_rule_ids.includes(r.rule_id) && !set.purged_rule_ids.includes(r.rule_id));
        if (todo.length === 0) continue;
        const all = [...set.purged_rule_ids, ...todo.map((r) => r.rule_id)].sort();
        await db.query('update simdc_meta.rule_set set purged_rule_ids = $2, updated_at = now() where case_no = $1', [set.case_no, all]);
        const principalRole = roleFor(prefix, set.principal_id);
        for (const r of todo) purged.push({ case_no: set.case_no, rule_id: r.rule_id, db_role: ruleRoleFor(principalRole, r.rule_id) });
        principals.add(set.principal_id);
    }
    for (const principalId of principals) await recompute(db, prefix, principalId);
    return purged;
}

export async function listRuleSets(db: Db, caseNo: string | null): Promise<unknown[]> {
    const r = await db.query<StoredRuleSet & { updated_at: string; key_id: string }>(
        `select * from simdc_meta.rule_set where $1::text is null or case_no = $1 order by case_no`,
        [caseNo],
    );
    return r.rows.map((s) => ({
        case_no: s.case_no,
        case_version_no: s.case_version_no,
        status: s.status,
        dc_ref: dcRef(s.case_no, s.case_version_no),
        grantee: s.body.grantee,
        db_role: s.role_name,
        valid: s.body.valid,
        export: s.body.export,
        rules: s.body.rules.map((rule) => ({
            ...rule,
            withdrawn: s.withdrawn_rule_ids.includes(rule.rule_id),
            purged: s.purged_rule_ids.includes(rule.rule_id),
        })),
        signed_by: s.key_id,
        applied_at: s.applied_at,
        updated_at: s.updated_at,
    }));
}
