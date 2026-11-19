// 路由表：每個 API 路徑就是一個資料庫 api function。路徑由 function 名稱產生（/api/<名稱>）。
// 參數名 session 由後端從 cookie 填入；其餘參數照順序從請求的 JSON 取。
// 刻意沒有「只憑工作階段就能做決定」的路由：做決定只有 case_decide_passkey，身分由資料庫從通行金鑰的簽章得出。

export type Route = {
    fn: string;
    params: readonly string[];
    result: 'value' | 'row' | 'rows';
};

const table: readonly Route[] = [
    { fn: 'api.me', params: ['session'], result: 'value' },
    { fn: 'api.case_create', params: ['session', 'content'], result: 'row' },
    { fn: 'api.case_submit', params: ['session', 'case_id'], result: 'value' },
    { fn: 'api.case_list_mine', params: ['session'], result: 'value' },
    { fn: 'api.inbox_list', params: ['session'], result: 'value' },
    { fn: 'api.challenge_issue', params: ['session', 'case_id', 'decision'], result: 'row' },
    {
        fn: 'api.case_decide_passkey',
        params: ['challenge_id', 'decision', 'credential_id', 'authenticator_data', 'client_data_json', 'signature'],
        result: 'value',
    },
    { fn: 'api.passkey_register_begin', params: ['session'], result: 'row' },
    { fn: 'api.audit_case', params: ['session', 'case_no'], result: 'value' },
    { fn: 'api.audit_chain', params: ['session', 'after_seq', 'limit'], result: 'rows' },
    { fn: 'api.audit_code_fingerprint', params: ['session'], result: 'value' },
];

export const routes: ReadonlyMap<string, Route> = new Map(table.map((r) => [`/api/${r.fn.slice('api.'.length)}`, r]));
