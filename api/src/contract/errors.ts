/**
 * ★ 契約檔：PostgreSQL 內建 SQLSTATE → HTTP 狀態。
 *
 * 業務錯誤不寫在這裡：它們的代碼、訊息、HTTP 狀態只存在資料庫的錯誤目錄，
 * 後端啟動時透過 sqlNames.errorCatalog 指到的 function 讀進來（機制在 src/errors.ts）。
 * 這裡只處理「不是 SQL function 刻意丟的」那些：輸入轉型失敗、逾時、資料庫暫時不可用。
 *
 * 沒列在這裡、也不在錯誤目錄裡的 SQLSTATE 一律回 500 internal_error，原始訊息只進 log。
 */
import { BACKEND_ERRORS } from '../errors.ts';
import type { ErrorContract, ErrorRule } from '../routing/types.ts';

const INVALID_INPUT: ErrorRule = { status: 400, expose: false, code: 'invalid_input', message: '輸入的格式不正確' };
const BUSY: ErrorRule = { status: 409, expose: false, code: 'busy', message: '系統忙碌中，請再試一次' };
const UNAVAILABLE: ErrorRule = {
  status: BACKEND_ERRORS.service_unavailable[0],
  expose: false,
  code: 'service_unavailable',
  message: BACKEND_ERRORS.service_unavailable[1],
};

export const errors: ErrorContract = {
  exact: {
    // 參數轉型失敗（例：把 "abc" 傳給 bigint 參數）。原始訊息含使用者輸入與型別名稱，不外露。
    '22P02': INVALID_INPUT,
    '22007': INVALID_INPUT,
    '22008': INVALID_INPUT,
    '22003': INVALID_INPUT,
    '22001': { ...INVALID_INPUT, message: '輸入的內容太長' },

    // 序列化衝突與死結：db 層已自動重試過，還是失敗才會到這裡。
    '40001': BUSY,
    '40P01': BUSY,

    // 超過 statement_timeout。
    '57014': { status: 503, expose: false, code: 'timeout', message: '處理逾時，請稍後再試' },

    // 資料庫正在關機或啟動。
    '57P01': UNAVAILABLE,
    '57P02': UNAVAILABLE,
    '57P03': UNAVAILABLE,
  },
  classes: {
    // 08＝連線異常、53＝資源不足。
    '08': UNAVAILABLE,
    '53': UNAVAILABLE,
  },
};
