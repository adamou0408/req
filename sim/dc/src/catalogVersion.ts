// 目錄版本（裁決 D92 (1)；格式與演算法的唯一來源：docs/contract/02-pack-data-access.md §8.6）。
// DC 用和平台相同的演算法，從自己的目錄（catalog.ts）加上目前的對照（simdc_meta.catalog_remap，測試用的後門可以改）
// 算出雜湊，在套用、驗證與對帳的回應裡回報。對照改了而代碼沒變，雜湊也會變（平台因此看得出來）。
//   快照：{format, packages[{code, name, system, period_field, resource, fields[...], filters[...]}]}，只含平台目錄上的欄位
//   （列條件專用的欄不算欄位），依代碼、列舉值依值排序；雜湊＝RFC 8785 標準化後的 SHA-256（小寫十六進位）。
import { createHash } from 'node:crypto';
import { PACKAGES } from './catalog.ts';
import type { Db } from './db.ts';

type Json = string | null | readonly Json[] | { readonly [key: string]: Json };

/** RFC 8785：快照裡只有字串、null、陣列與物件，所以只要鍵依 UTF-16 排序、字串照 JSON 的寫法。 */
export function canonicalize(value: Json): string {
    if (value === null || typeof value === 'string') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${(value as readonly Json[]).map(canonicalize).join(',')}]`;
    const obj = value as { readonly [key: string]: Json };
    return `{${Object.keys(obj)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k] ?? null)}`)
        .join(',')}}`;
}

const byCode = <T extends { readonly code: string }>(a: T, b: T): number => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);

/** 目錄的標準化快照。remap：「主題包.代碼」→ 實體資源（覆寫預設的對照）。 */
export function catalogSnapshot(remap: ReadonlyMap<string, string> = new Map()): Json {
    const resource = (pkg: string, code: string, fallback: string): string => remap.get(`${pkg}.${code}`) ?? fallback;
    return {
        format: 'data_access_catalog/1',
        packages: [...PACKAGES].sort(byCode).map((p) => ({
            code: p.code,
            name: p.name,
            system: p.system,
            period_field: p.periodField,
            resource: remap.get(p.code) ?? `data.${p.code}`,
            fields: p.columns
                .filter((c) => c.classification !== null)
                .sort(byCode)
                .map((c) => ({ code: c.code, name: c.name, classification: c.classification, resource: resource(p.code, c.code, c.code) })),
            filters: [...p.filters].sort(byCode).map((f) => ({
                code: f.code,
                name: f.name,
                value_type: f.valueType,
                resource: resource(p.code, f.code, f.column),
                values: [...f.values].sort().map((v) => ({ value: v, label: f.labels[v] ?? v })),
            })),
        })),
    };
}

export function catalogSha256(remap: ReadonlyMap<string, string> = new Map()): string {
    return createHash('sha256')
        .update(canonicalize(catalogSnapshot(remap)), 'utf8')
        .digest('hex');
}

/** 這個環境目前的對照覆寫（測試用的後門 remap 寫入；reset 清空）。 */
export async function currentRemap(db: Db): Promise<Map<string, string>> {
    const r = await db.query<{ key: string; resource: string }>('select key, resource from simdc_meta.catalog_remap order by key');
    return new Map(r.rows.map((x) => [x.key, x.resource]));
}

/** 這個環境目前用的目錄版本（雜湊）。 */
export async function currentCatalogSha256(db: Db): Promise<string> {
    return catalogSha256(await currentRemap(db));
}
