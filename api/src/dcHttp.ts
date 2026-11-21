// 交付 port 與對帳 port 的 HTTP adapter：外部資料系統（DC）的介面（sim/dc/README.md「端點」與「簽章格式」）。
// 方法與路徑由資料庫決定（領取時給；簽章的信封與外部系統的證明都涵蓋它們），這裡只接在 {base}（環境前綴）後面：
//   apply     PUT    {base}/rule-sets/{case_no}           簽章
//   withdraw  DELETE {base}/rule-sets/{case_no}           簽章
//   purge     POST   {base}/maintenance/purge-expired
//   verify    POST   {base}/test-queries
//   對帳      GET    {base}/reconciliation                 唯讀的稽核金鑰
//   使用紀錄  GET    {base}/usage-summaries                唯讀的稽核金鑰（批次摘要，裁決 D92 (4)）
// 本文一律送資料庫給的那串文字的 UTF-8 位元組（簽章涵蓋它）；冪等鍵放在 X-Request-Id（撤回與驗證的本文裡也有），
// 這次領取的一次性亂數放在 Sgn-Nonce（外部系統的證明要帶著它）。回應原樣交回資料庫。
import type { DeliveryItem, DeliveryOutcome, DeliveryPort, ReconciliationPort } from './deliveryPort.ts';

export type DcHttpOptions = { base: string; key: string; timeoutMs: number };

async function parse(res: Response): Promise<unknown> {
    const text = await res.text();
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return { status: 'unparsable', body: text.slice(0, 500) };
    }
}

function errorOf(response: unknown): string | null {
    if (typeof response === 'object' && response !== null && 'error' in response) return String((response as { error: unknown }).error);
    return null;
}

export function dcHttpDelivery(options: DcHttpOptions): DeliveryPort {
    return {
        kind: 'http',
        async send(item: DeliveryItem): Promise<DeliveryOutcome> {
            const headers: Record<string, string> = {
                authorization: `Bearer ${options.key}`,
                'content-type': 'application/json',
                'x-request-id': item.request_id,
                'sgn-nonce': item.nonce,
            };
            if (item.signature !== null) {
                headers['sgn-signature'] = `keyid="${item.signature.key_id}", alg="${item.signature.alg}", sig="${item.signature.sig}"`;
            }
            try {
                const res = await fetch(`${options.base}${item.path}`, {
                    method: item.method,
                    headers,
                    body: Buffer.from(item.body, 'utf8'),
                    signal: AbortSignal.timeout(options.timeoutMs),
                });
                const response = await parse(res);
                return { http_status: res.status, response, error: errorOf(response) };
            } catch (err) {
                return { http_status: null, response: null, error: err instanceof Error ? err.message : String(err) };
            }
        },
    };
}

export function dcHttpReconciliation(options: DcHttpOptions): ReconciliationPort {
    // 不論 HTTP 狀態都原樣交給資料庫：採不採信由外部系統的證明決定
    const get = async (path: string): Promise<unknown> =>
        parse(
            await fetch(`${options.base}${path}`, {
                headers: { authorization: `Bearer ${options.key}` },
                signal: AbortSignal.timeout(options.timeoutMs),
            }),
        );
    return { fetchReport: () => get('/reconciliation'), fetchUsage: () => get('/usage-summaries') };
}
