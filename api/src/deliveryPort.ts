// 交付 port（工程規範第 2 節：對外系統一律走 port 與 adapter；契約 02 §8.5）。核心只認「一筆交付」：
// 資料庫已經決定好要送的種類、方法與路徑、本文（要原樣送出的文字）、簽章與這次領取的一次性亂數；adapter 只負責把它送到
// 外部系統、把外部系統的回應原樣交回。成功、重送、拒絕由資料庫依外部系統的證明判斷（api_delivery.delivery_report，
// 裁決 D81 (2)），adapter 不判斷，也改不了：沒有外部系統證明的回應一律當成沒送到。
// 實作：dcHttp.ts（外部系統的 HTTP 介面，開發與測試連 sim/dc）、dcMock.ts（只用在單元測試）。
// 合約測試：db/tests/kernel/93-delivery-adapter.test.mjs（兩個 adapter 跑同一份）。

/** apply 套用、withdraw 撤回、purge 清除到期、verify 驗證（測試查詢） */
export type DeliveryKind = 'apply' | 'withdraw' | 'purge' | 'verify';

export type DeliverySignature = { key_id: string; alg: 'ed25519'; sig: string };

/** 資料庫領出來的一筆（api_delivery.delivery_claim）。body 的 UTF-8 位元組就是簽章涵蓋的內容，不得重新序列化。 */
export type DeliveryItem = {
    op_id: number;
    lease_token: string;
    kind: DeliveryKind;
    request_id: string;
    case_no: string | null;
    /** 外部系統環境前綴之後的方法與路徑（簽章的信封與外部系統的證明都要相符） */
    method: 'PUT' | 'DELETE' | 'POST';
    path: string;
    /** 這次領取的一次性亂數：外部系統的證明要帶著它 */
    nonce: string;
    body: string;
    signature: DeliverySignature | null;
};

/** 交回資料庫的結果：http_status 為 null 代表連不上（逾時、拒絕連線）。response 是外部系統的回應本文（含它的證明）。 */
export type DeliveryOutcome = { http_status: number | null; response: unknown; error: string | null };

export type DeliveryPort = {
    readonly kind: 'http' | 'mock';
    send(item: DeliveryItem): Promise<DeliveryOutcome>;
};

/**
 * 對帳 port：外部系統實際存在的權限（dc_reconciliation_report/1）與使用紀錄的批次摘要（usage_summary_batch/1，裁決 D92 (4)），
 * 原樣交回外部系統的回應（含證明）。和交付用不同的金鑰。
 */
export type ReconciliationPort = {
    fetchReport(): Promise<unknown>;
    fetchUsage(): Promise<unknown>;
};
