// 遮罩環境的沙箱：執行一組查詢（例如申請人報表的 SQL），回報「實際讀到哪些主題包與欄位、用了哪些條件」。
// 做法：以沙箱角色（只能讀遮罩資料庫的 data schema）在唯讀交易裡
//   1. EXPLAIN (VERBOSE, FORMAT JSON)：從執行計畫的掃描節點取得資料表，從各節點的 Output、Filter 等取得欄
//   2. 真的執行一次，只回筆數
// 限制寫在 docs/handoff/sim-dc.md：以執行計畫為準，所以只回報「計畫需要讀的欄」。
import { findPackage, ROW_ID } from './catalog.ts';
import { ident, singleStatement, withTx, type Db, type Env } from './db.ts';

export class SandboxError extends Error {}

interface PlanNode {
    [key: string]: unknown;
    Plans?: PlanNode[];
}

interface SandboxQueryResult {
    readonly name: string;
    readonly status: 'ok' | 'error';
    readonly error: string | null;
    readonly row_count: number | null;
    readonly packages: { package: string; fields: string[]; conditions: string[] }[];
    readonly other_relations: string[];
}

// 掃描節點（以及原樣轉手的節點）的 Output 可能是整張表的欄（physical tlist 最佳化），不代表查詢需要；
// 只有它是最上層節點時才算。其他節點的 Output 與所有條件、排序、分組的運算式都算。
const PASS_THROUGH = new Set([
    'Seq Scan',
    'Index Scan',
    'Index Only Scan',
    'Bitmap Heap Scan',
    'Tid Scan',
    'Tid Range Scan',
    'Sample Scan',
    'Hash',
    'Materialize',
    'Memoize',
    'Gather',
    'Gather Merge',
]);

const COND_KEYS = ['Filter', 'Index Cond', 'Recheck Cond', 'Join Filter', 'Hash Cond', 'Merge Cond', 'TID Cond'];

function strings(v: unknown, out: string[]): void {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
}

function walk(node: PlanNode, visit: (n: PlanNode, root: boolean) => void, root = true): void {
    visit(node, root);
    for (const child of node.Plans ?? []) walk(child, visit, false);
}

// 欄的寫法是「別名.欄」；計畫裡只有一個資料表時 EXPLAIN 不加別名，改認「這張表的欄名」。
// 字串常數先去掉，'bonus' 這種值才不會被當成 bonus 欄。
function collectColumns(text: string, aliases: ReadonlyMap<string, string>, usage: ReadonlyMap<string, Usage>): void {
    const bare = text.replace(/'(?:[^']|'')*'/g, "''");
    for (const m of bare.matchAll(/(?<![\w."])"?([A-Za-z_]\w*)"?\."?([A-Za-z_]\w*)"?/g)) {
        const rel = m[1] === undefined ? undefined : aliases.get(m[1]);
        const u = rel === undefined ? undefined : usage.get(rel);
        if (u !== undefined && m[2] !== undefined && m[2] !== ROW_ID) u.fields.add(m[2]);
    }
    const only = new Set(aliases.values());
    if (only.size !== 1) return;
    const rel = [...only][0] ?? '';
    const pkg = findPackage(rel);
    const u = usage.get(rel);
    if (pkg === undefined || u === undefined) return;
    for (const m of bare.matchAll(/(?<![\w."])([A-Za-z_]\w*)(?![\w(])/g)) {
        if (m[1] !== undefined && pkg.columns.some((c) => c.code === m[1])) u.fields.add(m[1]);
    }
}

interface Usage {
    fields: Set<string>;
    conditions: Set<string>;
}

function analyze(plan: PlanNode): { usage: Map<string, Usage>; other: Set<string> } {
    const aliases = new Map<string, string>();
    const other = new Set<string>();
    walk(plan, (n) => {
        const rel = n['Relation Name'];
        const schema = n['Schema'];
        const alias = n['Alias'];
        if (typeof rel !== 'string' || typeof alias !== 'string') return;
        if (schema === 'data' && findPackage(rel) !== undefined) aliases.set(alias, rel);
        else other.add(`${String(schema)}.${rel}`);
    });
    const usage = new Map<string, Usage>();
    for (const rel of new Set(aliases.values())) usage.set(rel, { fields: new Set(), conditions: new Set() });
    walk(plan, (n, root) => {
        const texts: string[] = [];
        const skipOutput = !root && PASS_THROUGH.has(String(n['Node Type']));
        for (const [k, v] of Object.entries(n)) {
            if (k !== 'Plans' && !(k === 'Output' && skipOutput)) strings(v, texts);
        }
        for (const text of texts) collectColumns(text, aliases, usage);
        const alias = n['Alias'];
        const rel = typeof alias === 'string' ? aliases.get(alias) : undefined;
        for (const key of COND_KEYS) {
            const cond = n[key];
            if (typeof cond !== 'string') continue;
            const target = rel ?? [...aliases.entries()].find(([a]) => cond.includes(`${a}.`))?.[1];
            if (target !== undefined) usage.get(target)?.conditions.add(cond);
        }
    });
    return { usage, other };
}

async function runOne(db: Db, sandboxRole: string, name: string, sql: string): Promise<SandboxQueryResult> {
    const text = sql.trim().replace(/;\s*$/, '');
    await db.query('savepoint q');
    try {
        await db.query(`set local role ${ident(sandboxRole)}`);
        await db.query(`set local statement_timeout = '5s'`);
        // 以 extended protocol 送出，PostgreSQL 只接受單一語句
        const explain = await db.query<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(singleStatement(`explain (verbose, format json) ${text}`));
        const plan = explain.rows[0]?.['QUERY PLAN'][0]?.Plan;
        if (plan === undefined) throw new SandboxError('沒有執行計畫');
        if (plan['Node Type'] === 'ModifyTable') throw new SandboxError('只接受查詢');
        const count = await db.query<{ n: number }>(singleStatement(`select count(*)::int as n from (${text}) as sandbox_query`));
        await db.query('reset role');
        await db.query('release savepoint q');
        const { usage, other } = analyze(plan);
        return {
            name,
            status: 'ok',
            error: null,
            row_count: count.rows[0]?.n ?? 0,
            packages: [...usage].map(([pkg, u]) => ({ package: pkg, fields: [...u.fields].sort(), conditions: [...u.conditions] })),
            other_relations: [...other].sort(),
        };
    } catch (err) {
        await db.query('rollback to savepoint q');
        await db.query('reset role');
        const message = err instanceof Error ? err.message : String(err);
        return { name, status: 'error', error: message, row_count: null, packages: [], other_relations: [] };
    }
}

export async function runSandbox(env: Env, sandboxRole: string, body: unknown): Promise<{ queries: SandboxQueryResult[] }> {
    if (!env.config.masked) throw new SandboxError('沙箱只在遮罩環境（/masked/v1）提供');
    const queries = (body as { queries?: unknown } | null)?.queries;
    if (!Array.isArray(queries) || queries.length === 0 || queries.length > 50) throw new SandboxError('queries 必須是 1 到 50 筆');
    const parsed = queries.map((q, i) => {
        const o = q as { name?: unknown; sql?: unknown };
        if (typeof o.sql !== 'string' || o.sql.trim() === '') throw new SandboxError(`queries[${i}].sql 必須是非空字串`);
        return { name: typeof o.name === 'string' ? o.name : `q${i + 1}`, sql: o.sql };
    });
    return withTx(
        env,
        async (db) => {
            await db.query('set transaction read only');
            const results: SandboxQueryResult[] = [];
            for (const q of parsed) results.push(await runOne(db, sandboxRole, q.name, q.sql));
            return { queries: results };
        },
        { rollback: true },
    );
}
