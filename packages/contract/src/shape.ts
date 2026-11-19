// 回傳結構的描述與檢查。每個 api function 回傳 jsonb；結構寫在路由表裡（唯一來源），
// 資料庫測試（db/tests/kernel/90-contract.test.mjs）以真的呼叫檢查每個 function 的回傳完全符合（不多不少）。

export type Scalar =
    | 'uuid'
    | 'text'
    | 'int'
    | 'bool'
    | 'timestamp'
    | 'hex' // 小寫十六進位
    | 'b64url' // base64url，無 padding
    | 'base64' // 標準 base64
    | 'json'; // 任意 JSON（例如申請人填的內容）

export type Shape =
    | Scalar
    | { readonly nullable: Shape }
    | { readonly array: Shape }
    | { readonly object: Readonly<Record<string, Shape>> };

const scalarChecks: Record<Scalar, (v: unknown) => boolean> = {
    uuid: (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v),
    text: (v) => typeof v === 'string',
    int: (v) => Number.isSafeInteger(v),
    bool: (v) => typeof v === 'boolean',
    timestamp: (v) => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/.test(v),
    hex: (v) => typeof v === 'string' && /^([0-9a-f]{2})+$/.test(v),
    b64url: (v) => typeof v === 'string' && /^[A-Za-z0-9_-]+$/.test(v),
    base64: (v) => typeof v === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(v),
    json: () => true,
};

/** 檢查 value 是否完全符合 shape（物件的鍵不能多也不能少）。回傳問題清單；空陣列代表符合。 */
export function shapeProblems(value: unknown, shape: Shape, path = '$'): string[] {
    if (typeof shape === 'string') return scalarChecks[shape](value) ? [] : [`${path}: 應為 ${shape}，實際 ${JSON.stringify(value)}`];
    if ('nullable' in shape) return value === null ? [] : shapeProblems(value, shape.nullable, path);
    if ('array' in shape) {
        if (!Array.isArray(value)) return [`${path}: 應為陣列`];
        return value.flatMap((item, i) => shapeProblems(item, shape.array, `${path}[${i}]`));
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return [`${path}: 應為物件`];
    const record = value as Record<string, unknown>;
    const expected = Object.keys(shape.object);
    const extra = Object.keys(record).filter((k) => !expected.includes(k));
    return [
        ...extra.map((k) => `${path}.${k}: 多出來的欄位`),
        ...expected.flatMap((k) => (k in record ? shapeProblems(record[k], shape.object[k], `${path}.${k}`) : [`${path}.${k}: 缺少`])),
    ];
}
