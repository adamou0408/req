// 同一套系統裡的兩區（裁決 D93 (3)；格式的唯一來源 docs/contract/02-pack-data-access.md §8.1、§8.8）：
// 正式區的資料表在 schema data、匯出檢視表在 export；測試區的在 data_test、export_test（結構相同，資料是正式區的副本，
// 目錄標示遮罩的欄位已遮罩）。兩區是不同的資料庫物件：規則角色只拿到它那一區的欄位權限、policy 與檢視表。
// 規則沒有寫 environment（平台這一版之前的舊單）一律是正式區。

export type DataEnvironment = 'prod' | 'test';

export const DATA_ENVIRONMENTS: readonly DataEnvironment[] = ['prod', 'test'];

/** 舊單（規則、查詢沒有寫 environment）所在的區。 */
export const LEGACY_ENVIRONMENT: DataEnvironment = 'prod';

const DATA_SCHEMA: Record<DataEnvironment, string> = { prod: 'data', test: 'data_test' };
const EXPORT_SCHEMA: Record<DataEnvironment, string> = { prod: 'export', test: 'export_test' };

export class DataEnvironmentError extends Error {}

/** 沒有寫（undefined、null）是舊單的那一區；其他不認得的值一律拒絕。 */
export function parseDataEnvironment(v: unknown, where: string): DataEnvironment {
    if (v === undefined || v === null) return LEGACY_ENVIRONMENT;
    if (v === 'prod' || v === 'test') return v;
    throw new DataEnvironmentError(`${where} 必須是 ${DATA_ENVIRONMENTS.join('、')}`);
}

export function dataSchema(e: DataEnvironment): string {
    return DATA_SCHEMA[e];
}

export function exportSchema(e: DataEnvironment): string {
    return EXPORT_SCHEMA[e];
}

/** 資料表所在的 schema → 區（不是兩區的 schema 回 undefined）。 */
export function environmentOfSchema(schema: string): DataEnvironment | undefined {
    return DATA_ENVIRONMENTS.find((e) => DATA_SCHEMA[e] === schema || EXPORT_SCHEMA[e] === schema);
}

export const DATA_SCHEMAS: readonly string[] = DATA_ENVIRONMENTS.map(dataSchema);
export const EXPORT_SCHEMAS: readonly string[] = DATA_ENVIRONMENTS.map(exportSchema);
