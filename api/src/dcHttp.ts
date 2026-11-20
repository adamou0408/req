// 交付 port 與對帳 port 的 HTTP adapter：外部資料系統（DC）的介面（sim/dc/README.md「端點」與「簽章格式」）。
//   apply     PUT    {base}/rule-sets/{case_no}           簽章
//   withdraw  DELETE {base}/rule-sets/{case_no}           簽章
//   purge     POST   {base}/maintenance/purge-expired
//   verify    POST   {base}/test-queries
//   對帳      GET    {base}/reconciliation                 唯讀的稽核金鑰
// 本文一律送資料庫給的那串文字的 UTF-8 位元組（簽章涵蓋它）；冪等鍵放在 X-Request-Id（撤回與驗證的本文裡也有）。
import type { DeliveryItem, DeliveryOutcome, DeliveryPort, ReconciliationPort } from './deliveryPort.ts';

export type DcHttpOptions = { base: string; key: string; timeoutMs: number };

function route(base: string, item: DeliveryItem): { method: string; url: string } {
    const caseUrl = `${base}/rule-sets/${encodeURIComponent(item.case_no ?? '')}`;
    switch (item.kind) {
        case 'apply':
            return { method: 'PUT', url: caseUrl };
        case 'withdraw':
            return { method: 'DELETE', url: caseUrl };
        case 'purge':
            return { method: 'POST', url: `${base}/maintenance/purge-expired` };
        case 'verify':
            return { method: 'POST', url: `${base}/test-queries` };
    }
}

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
            const { method, url } = route(options.base, item);
            const headers: Record<string, string> = {
                authorization: `Bearer ${options.key}`,
                'content-type': 'application/json',
                'x-request-id': item.request_id,
            };
            if (item.signature !== null) {
                headers['sgn-signature'] = `keyid="${item.signature.key_id}", alg="${item.signature.alg}", sig="${item.signature.sig}"`;
            }
            try {
                const res = await fetch(url, {
                    method,
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
    return {
        async fetchReport(): Promise<unknown> {
            const res = await fetch(`${options.base}/reconciliation`, {
                headers: { authorization: `Bearer ${options.key}` },
                signal: AbortSignal.timeout(options.timeoutMs),
            });
            if (!res.ok) throw new Error(`對帳回報 HTTP ${res.status}`);
            return (await res.json()) as unknown;
        },
    };
}
