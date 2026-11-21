// 使用紀錄（裁決 D92 (4)；格式的唯一來源：docs/contract/02-pack-data-access.md §8.7）。
// 實際操作的人經使用端點（POST {base}/use）以被授權者的身分查一次（和測試查詢相同，由 PostgreSQL 判定），每一次都記一筆
// （這個被授權者在這個主題包上有規則的每一張單各記一筆：允許算查詢或匯出，擋下算被擋）。
// 平台以 GET {base}/usage-summaries 拉一批摘要：每張單 × 每個人 × 每個時段（SIM_DC_USAGE_PERIOD_SECONDS）的查詢、匯出、
// 被擋次數與最後使用時間，只含最近 SIM_DC_USAGE_WINDOW_DAYS 天。回應的證明由 server.ts 加上。
import type { Db } from './db.ts';

export interface Actor {
    readonly provider: string;
    readonly external_id: string;
}

export interface UsageItem {
    readonly case_no: string;
    readonly actor: Actor;
    readonly period: { readonly from: string; readonly to: string };
    readonly queries: number;
    readonly exports: number;
    readonly blocked: number;
    readonly last_used_at: string | null;
}

export class UsageError extends Error {}

export function parseActor(raw: unknown): Actor {
    const a = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const ok = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9._@-]{1,128}$/.test(v);
    if (!ok(a['provider']) || !ok(a['external_id'])) throw new UsageError('actor 必須有 provider 與 external_id');
    return { provider: a['provider'], external_id: a['external_id'] };
}

/** 這個被授權者在這個主題包上有規則、還沒撤回的單。 */
async function casesFor(db: Db, principalId: string, pkg: string): Promise<string[]> {
    const r = await db.query<{ case_no: string }>(
        `select case_no from simdc_meta.rule_set
         where principal_id = $1 and status = 'applied'
           and exists (select 1 from jsonb_array_elements(body -> 'rules') as x
                       where x ->> 'package' = $2 and not (x ->> 'rule_id' = any (withdrawn_rule_ids || purged_rule_ids)))
         order by case_no`,
        [principalId, pkg],
    );
    return r.rows.map((x) => x.case_no);
}

/** 記一次使用：每張相關的單一筆。回傳記到哪幾張單。 */
export async function recordUse(
    db: Db,
    principalId: string,
    pkg: string,
    actor: Actor,
    action: 'query' | 'export',
    allowed: boolean,
): Promise<string[]> {
    const cases = await casesFor(db, principalId, pkg);
    for (const caseNo of cases) {
        await db.query(
            `insert into simdc_meta.usage_event (case_no, actor_provider, actor_external_id, action, allowed) values ($1, $2, $3, $4, $5)`,
            [caseNo, actor.provider, actor.external_id, action, allowed],
        );
    }
    return cases;
}

/** 最近 windowDays 天的摘要，依單、人、時段分組。 */
export async function usageSummaries(db: Db, periodSeconds: number, windowDays: number): Promise<UsageItem[]> {
    const r = await db.query<{
        case_no: string;
        actor_provider: string;
        actor_external_id: string;
        period_from: Date;
        period_to: Date;
        queries: string;
        exports: string;
        blocked: string;
        last_used_at: Date | null;
    }>(
        `with e as (
             select *, to_timestamp(floor(extract(epoch from at) / $1) * $1) as period_from
             from simdc_meta.usage_event
             where at > now() - make_interval(days => $2)
         )
         select case_no, actor_provider, actor_external_id, period_from,
                period_from + make_interval(secs => $1) as period_to,
                count(*) filter (where allowed and action = 'query') as queries,
                count(*) filter (where allowed and action = 'export') as exports,
                count(*) filter (where not allowed) as blocked,
                max(at) as last_used_at
         from e
         group by case_no, actor_provider, actor_external_id, period_from
         order by case_no, actor_provider, actor_external_id, period_from`,
        [periodSeconds, windowDays],
    );
    return r.rows.map((x) => ({
        case_no: x.case_no,
        actor: { provider: x.actor_provider, external_id: x.actor_external_id },
        period: { from: x.period_from.toISOString(), to: x.period_to.toISOString() },
        queries: Number(x.queries),
        exports: Number(x.exports),
        blocked: Number(x.blocked),
        last_used_at: x.last_used_at === null ? null : x.last_used_at.toISOString(),
    }));
}
