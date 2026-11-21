// 使用紀錄（裁決 D92 (4)、D93 (3)、D94 (7)；格式的唯一來源：docs/contract/02-pack-data-access.md §8.7）。
// 實際操作的人經使用端點（POST {base}/use）以被授權者的身分查一次（和測試查詢相同，由 PostgreSQL 判定），每一次都記一筆
// （這個被授權者在這個主題包上有規則的每一張單各記一筆：允許算查詢或匯出，擋下算被擋）。
// 平台以 GET {base}/usage-summaries 拉一批摘要：每張單 × 每個人 × 每個時段（SIM_DC_USAGE_PERIOD_SECONDS）的查詢、匯出、
// 被擋次數與最後使用時間，只含最近 SIM_DC_USAGE_WINDOW_DAYS 天。每一筆另帶區（單的規則所在的區）、逐欄的次數與最後使用時間、
// 這個時段裡使用方系統帶過的程式版本識別。回應的證明由 server.ts 加上。
import type { DataEnvironment } from './dataEnvironment.ts';
import type { Db } from './db.ts';

export interface Actor {
    readonly provider: string;
    readonly external_id: string;
}

export interface FieldUsage {
    readonly package: string;
    readonly field: string;
    readonly queries: number;
    readonly exports: number;
    readonly blocked: number;
    readonly last_used_at: string | null;
}

export interface UsageItem {
    readonly case_no: string;
    readonly actor: Actor;
    readonly period: { readonly from: string; readonly to: string };
    readonly queries: number;
    readonly exports: number;
    readonly blocked: number;
    readonly last_used_at: string | null;
    readonly environment: DataEnvironment | null;
    readonly fields: readonly FieldUsage[];
    readonly client_versions: readonly string[];
}

/** 這次使用：查哪個主題包的哪些欄位、哪一區，以及使用方系統的程式版本識別（沒有帶是 null）。 */
export interface UseTarget {
    readonly package: string;
    readonly fields: readonly string[];
    readonly environment: DataEnvironment;
    readonly clientVersion: string | null;
}

export class UsageError extends Error {}

/** 使用方系統帶的程式或報表版本識別（D94 (6)）：沒有帶是 null。 */
export function parseClientVersion(raw: unknown): string | null {
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== 'string' || !/^[A-Za-z0-9._@:/+-]{1,128}$/.test(raw)) throw new UsageError('client_version 格式不對');
    return raw;
}

export function parseActor(raw: unknown): Actor {
    const a = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const ok = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9._@-]{1,128}$/.test(v);
    if (!ok(a['provider']) || !ok(a['external_id'])) throw new UsageError('actor 必須有 provider 與 external_id');
    return { provider: a['provider'], external_id: a['external_id'] };
}

/** 這個被授權者在這個主題包、這一區有規則、還沒撤回的單（規則沒有寫區＝正式區）。 */
async function casesFor(db: Db, principalId: string, pkg: string, environment: DataEnvironment): Promise<string[]> {
    const r = await db.query<{ case_no: string }>(
        `select case_no from simdc_meta.rule_set
         where principal_id = $1 and status = 'applied' and coalesce(body ->> 'environment', 'prod') = $3
           and exists (select 1 from jsonb_array_elements(body -> 'rules') as x
                       where x ->> 'package' = $2 and not (x ->> 'rule_id' = any (withdrawn_rule_ids || purged_rule_ids)))
         order by case_no`,
        [principalId, pkg, environment],
    );
    return r.rows.map((x) => x.case_no);
}

/** 記一次使用：每張相關的單一筆。回傳記到哪幾張單。 */
export async function recordUse(
    db: Db,
    principalId: string,
    target: UseTarget,
    actor: Actor,
    action: 'query' | 'export',
    allowed: boolean,
): Promise<string[]> {
    const cases = await casesFor(db, principalId, target.package, target.environment);
    for (const caseNo of cases) {
        await db.query(
            `insert into simdc_meta.usage_event
                 (case_no, actor_provider, actor_external_id, action, allowed, environment, package, fields, client_version)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
                caseNo,
                actor.provider,
                actor.external_id,
                action,
                allowed,
                target.environment,
                target.package,
                target.fields,
                target.clientVersion,
            ],
        );
    }
    return cases;
}

interface SummaryRow {
    case_no: string;
    actor_provider: string;
    actor_external_id: string;
    period_from: Date;
    period_to: Date;
    queries: string;
    exports: string;
    blocked: string;
    last_used_at: Date | null;
    environment: string | null;
    fields: { package: string; field: string; queries: number; exports: number; blocked: number; last_used_at: string | null }[];
    client_versions: string[];
}

/** 最近 windowDays 天的摘要，依單、人、時段分組；每一組另帶區、逐欄的次數與這段時間帶過的程式版本識別。 */
export async function usageSummaries(db: Db, periodSeconds: number, windowDays: number): Promise<UsageItem[]> {
    const r = await db.query<SummaryRow>(
        `with e as (
             select *, to_timestamp(floor(extract(epoch from at) / $1) * $1) as period_from
             from simdc_meta.usage_event
             where at > now() - make_interval(days => $2)
         ),
         f as (
             select e.case_no, e.actor_provider, e.actor_external_id, e.period_from, e.package, x.field,
                    count(*) filter (where e.allowed and e.action = 'query') as queries,
                    count(*) filter (where e.allowed and e.action = 'export') as exports,
                    count(*) filter (where not e.allowed) as blocked,
                    max(e.at) as last_used_at
             from e cross join lateral unnest(e.fields) as x (field)
             group by 1, 2, 3, 4, 5, 6
         )
         select e.case_no, e.actor_provider, e.actor_external_id, e.period_from,
                e.period_from + make_interval(secs => $1) as period_to,
                count(*) filter (where e.allowed and e.action = 'query') as queries,
                count(*) filter (where e.allowed and e.action = 'export') as exports,
                count(*) filter (where not e.allowed) as blocked,
                max(e.at) as last_used_at,
                (select r.body ->> 'environment' from simdc_meta.rule_set as r where r.case_no = e.case_no) as environment,
                coalesce((select jsonb_agg(jsonb_build_object('package', f.package, 'field', f.field, 'queries', f.queries,
                                  'exports', f.exports, 'blocked', f.blocked,
                                  'last_used_at', to_char(f.last_used_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
                                  order by f.package, f.field)
                          from f where f.case_no = e.case_no and f.actor_provider = e.actor_provider
                            and f.actor_external_id = e.actor_external_id and f.period_from = e.period_from), '[]'::jsonb) as fields,
                array(select distinct v from unnest(array_agg(e.client_version)) as v where v is not null order by v) as client_versions
         from e
         group by e.case_no, e.actor_provider, e.actor_external_id, e.period_from
         order by e.case_no, e.actor_provider, e.actor_external_id, e.period_from`,
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
        // 單的規則所在的區（規則沒有寫是 null：平台這一版之前的舊單）
        environment: x.environment === 'prod' || x.environment === 'test' ? x.environment : null,
        fields: x.fields.map((f) => ({ ...f, queries: Number(f.queries), exports: Number(f.exports), blocked: Number(f.blocked) })),
        client_versions: x.client_versions,
    }));
}
