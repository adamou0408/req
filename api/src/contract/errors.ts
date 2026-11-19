/**
 * ★ 契約檔：SQLSTATE → HTTP 狀態。照 docs/sql-functions.md／docs/api.md 填。
 *
 * 目前「自訂」那一段是範例（假設自訂 SQLSTATE 用 DA 開頭＋HTTP 狀態碼），
 * 契約定案後整段換掉即可，其他程式不用改。機制在 src/errors.ts。
 *
 * 沒列在這裡的 SQLSTATE 一律回 500 internal_error，原始訊息只進 log。
 */
import type { ErrorContract } from '../routing/types.ts';

export const errors: ErrorContract = {
  exact: {
    // ── 自訂（範例，待契約）─────────────────────────────────────
    // SQL 端：raise exception 'request_not_found' using errcode = 'DA404', detail = '找不到這張申請單';
    // 回應  ：404 {"code":"request_not_found","message":"找不到這張申請單"}
    DA400: { status: 400, expose: true, code: 'invalid_request', message: '送出的內容不正確' },
    DA401: { status: 401, expose: true, code: 'unauthenticated', message: '請先登入' },
    DA403: { status: 403, expose: true, code: 'forbidden', message: '你沒有權限做這個動作' },
    DA404: { status: 404, expose: true, code: 'not_found', message: '找不到資料' },
    DA409: { status: 409, expose: true, code: 'conflict', message: '資料狀態已經改變，請重新整理' },
    DA422: { status: 422, expose: true, code: 'rule_violation', message: '不符合規則' },

    // ── PostgreSQL 內建：輸入格式不對（例：uuid、日期轉型失敗）──
    // 不外露原始訊息。
    '22P02': { status: 400, expose: false, code: 'invalid_input', message: '輸入的格式不正確' },
    '22007': { status: 400, expose: false, code: 'invalid_input', message: '輸入的格式不正確' },
    '22008': { status: 400, expose: false, code: 'invalid_input', message: '輸入的格式不正確' },
    '22003': { status: 400, expose: false, code: 'invalid_input', message: '輸入的格式不正確' },
    '22001': { status: 400, expose: false, code: 'invalid_input', message: '輸入的內容太長' },

    // ── PostgreSQL 內建：暫時性問題 ─────────────────────────────
    // 40001／40P01 在 db 層已自動重試過，還是失敗才會到這裡。
    '40001': { status: 409, expose: false, code: 'busy', message: '系統忙碌中，請再試一次' },
    '40P01': { status: 409, expose: false, code: 'busy', message: '系統忙碌中，請再試一次' },
    '57014': { status: 503, expose: false, code: 'timeout', message: '處理逾時，請稍後再試' },
    '57P01': { status: 503, expose: false, code: 'service_unavailable', message: '系統暫時無法使用，請稍後再試' },
    '57P02': { status: 503, expose: false, code: 'service_unavailable', message: '系統暫時無法使用，請稍後再試' },
    '57P03': { status: 503, expose: false, code: 'service_unavailable', message: '系統暫時無法使用，請稍後再試' },
  },
  classes: {
    // 自訂類別的保底（範例，待契約）：DAxxx 沒有個別列出的都當 400。
    DA: { status: 400, expose: true, code: 'invalid_request', message: '無法完成這個操作' },
    // 08＝連線異常、53＝資源不足。
    '08': { status: 503, expose: false, code: 'service_unavailable', message: '系統暫時無法使用，請稍後再試' },
    '53': { status: 503, expose: false, code: 'service_unavailable', message: '系統暫時無法使用，請稍後再試' },
  },
};
