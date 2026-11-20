// API 呼叫層：頁面只透過這裡和後端溝通。後端在另一個來源（config.js 的 API_ORIGIN；裁決 D68），請求一律帶 cookie。
// 路徑一律是 /api/<function 名稱>，名稱與參數以 packages/contract 的路由表為準
// （db/tests/kernel/90-contract.test.mjs 檢查這裡用到的名稱都在路由表裡）。錯誤訊息直接用後端回傳的（來自資料庫的錯誤目錄）。
import { API_ORIGIN } from './config.js';

export class ApiFailure extends Error {
    constructor(code, message, status) {
        super(message);
        this.code = code;
        this.status = status;
    }
}

const send = (path, init = {}) => fetch(`${API_ORIGIN}${path}`, { credentials: 'include', mode: 'cors', ...init });

async function post(path, body = {}) {
    const response = await send(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok) throw new ApiFailure(payload.error.code, payload.error.message, response.status);
    return payload.result;
}

export const api = {
    /** 呼叫一個路由：fn 是 function 名稱，body 是除了 session 以外的參數。 */
    call: (fn, body = {}) => post(`/api/${fn}`, body),
    passkeyReauth: (body) => post('/auth/passkey', body),
    logout: () => post('/auth/logout'),
    loginUrl: () => `${API_ORIGIN}/auth/login`,
    /** 錯誤目錄（代碼 → 訊息）；登入頁只收網址上的錯誤代碼，文字從這裡取。 */
    messages: async () => (await (await send('/errors')).json()).result,
};
