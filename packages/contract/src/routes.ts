// 路由表（工程規範第 1 節：API 端點的唯一來源）。每個路由就是一個資料庫 api function，路徑是 /api/<fn>。
// 參數名 session 由後端從 cookie 填入；其餘參數照名稱從請求的 JSON 取，依順序對應 function 的 p_<名稱>。
// 回傳一律是 jsonb，結構寫在 returns；db/tests/kernel/90-contract.test.mjs 檢查 function 的簽章與實際回傳。
// 刻意沒有「只憑工作階段就能做決定」的路由：做決定只有 case_decide_passkey，身分由資料庫從通行金鑰的簽章得出。
import type { Shape } from './shape.ts';

export { shapeProblems, type Shape } from './shape.ts';

export type Call = {
    readonly fn: string;
    readonly params: readonly string[];
    readonly returns: Shape;
};

const exceptionRef: Shape = { object: { id: 'int', rule_code: 'text', opened_at: 'timestamp', event_seq: 'int' } };

const caseFields = {
    case_id: 'uuid',
    case_no: 'int',
    state: 'text',
    version: 'int',
    content: 'json',
    content_sha256: 'hex',
    updated_at: 'timestamp',
    applicant_name: 'text',
    approver_name: { nullable: 'text' },
    exceptions: { array: exceptionRef },
} as const satisfies Record<string, Shape>;

/** 申請單摘要：所有回傳申請單的 function 共用。actions 是這個人現在可以做的動作，畫面依它顯示按鈕。 */
export const caseSummary: Shape = { object: { ...caseFields, actions: { array: 'text' } } };

const challenge: Shape = {
    object: {
        challenge_id: 'uuid',
        challenge: 'b64url',
        binding: { object: { case_id: 'uuid', case_no: 'int', version: 'int', content_sha256: 'hex', decision: 'text' } },
    },
};

const auditCase: Shape = {
    object: {
        case: { object: caseFields },
        events: {
            array: {
                object: {
                    seq: 'int',
                    occurred_at: 'timestamp',
                    event_type: 'text',
                    actor_name: { nullable: 'text' },
                    body: 'base64',
                    prev_hash: 'hex',
                    hash: 'hex',
                },
            },
        },
        proofs: {
            array: {
                object: { kind: 'text', challenge: 'b64url', raw: 'json', raw_sha256: 'hex', public_key: { nullable: 'b64url' } },
            },
        },
    },
};

const chainEvent: Shape = {
    object: {
        seq: 'int',
        occurred_at: 'timestamp',
        event_type: 'text',
        case_id: { nullable: 'uuid' },
        actor_person_id: { nullable: 'uuid' },
        body: 'base64',
        prev_hash: 'hex',
        hash: 'hex',
    },
};

/** 畫面呼叫的路由：POST /api/<fn>。每個使用者動作一個。 */
export const routes = [
    {
        fn: 'me',
        params: ['session'],
        returns: { object: { person_id: 'uuid', name: 'text', passkeys: 'int', capabilities: { array: 'text' } } },
    },
    { fn: 'case_create', params: ['session', 'content'], returns: caseSummary },
    { fn: 'case_submit_new', params: ['session', 'content'], returns: caseSummary },
    { fn: 'case_revise', params: ['session', 'case_id', 'content'], returns: caseSummary },
    { fn: 'case_submit', params: ['session', 'case_id'], returns: caseSummary },
    { fn: 'case_get', params: ['session', 'case_id'], returns: caseSummary },
    { fn: 'case_list_mine', params: ['session'], returns: { array: caseSummary } },
    { fn: 'inbox_list', params: ['session'], returns: { array: caseSummary } },
    { fn: 'challenge_issue', params: ['session', 'case_id', 'decision'], returns: challenge },
    {
        fn: 'case_decide_passkey',
        params: ['challenge_id', 'decision', 'credential_id', 'authenticator_data', 'client_data_json', 'signature'],
        returns: caseSummary,
    },
    { fn: 'passkey_register_begin', params: ['session'], returns: { object: { challenge_id: 'uuid', challenge: 'b64url' } } },
    { fn: 'audit_case', params: ['session', 'case_no'], returns: auditCase },
    { fn: 'audit_chain', params: ['session', 'after_seq', 'limit'], returns: { array: chainEvent } },
    { fn: 'audit_code_fingerprint', params: ['session'], returns: { object: { code_fingerprint: 'hex' } } },
    {
        fn: 'audit_exceptions',
        params: ['session'],
        returns: {
            array: { object: { id: 'int', rule_code: 'text', case_no: { nullable: 'int' }, opened_at: 'timestamp', event_seq: 'int' } },
        },
    },
] as const satisfies readonly Call[];

/** 後端自己的流程（登入、登記通行金鑰的再驗證、登出、啟動）呼叫的 function；不直接開成 /api 路由。 */
export const backendCalls = {
    sessionBegin: { fn: 'session_begin', params: [], returns: { object: { challenge_id: 'uuid', nonce: 'b64url' } } },
    sessionOpen: {
        fn: 'session_open',
        params: ['challenge_id', 'id_token'],
        returns: { object: { session_token: 'b64url', person_id: 'uuid' } },
    },
    sessionClose: { fn: 'session_close', params: ['session'], returns: { object: { closed: 'bool' } } },
    passkeyRegister: {
        fn: 'passkey_register',
        params: ['challenge_id', 'id_token', 'credential_id', 'public_key_spki'],
        returns: { object: { credential_id: 'b64url' } },
    },
    errorCatalog: {
        fn: 'error_catalog',
        params: [],
        returns: { array: { object: { code: 'text', message: 'text', http_status: 'int' } } },
    },
} as const satisfies Record<string, Call>;

/** 存在但刻意不開放給後端的 api function，與理由。 */
export const notExposed: Readonly<Record<string, string>> = {
    case_decide_idp: '身分提供者再驗證的決定等於只靠密碼（Dex 不帶 amr）；只有資料庫測試使用，畫面一律走通行金鑰',
};
