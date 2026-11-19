// RFC 8785（JSON Canonicalization Scheme）。資料庫的 sgn_internal.jcs 與這裡必須算出相同的位元組（PRB-CONTENT-HASH）。
// 瀏覽器（稽核人員自己重算內容與證明的雜湊）與 Node（跨語言對照測試）共用這一份。
// ECMAScript 本身就是 RFC 8785 的定義來源：字串用 JSON.stringify 的跳脫、數字用 Number 的 toString，
// 鍵用預設排序（UTF-16 code unit），所以這裡只需要遞迴與排序。
export function canonicalize(value) {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new RangeError('JSON 不能表示 NaN 或 Infinity');
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
}
