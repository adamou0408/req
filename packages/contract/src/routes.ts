// 路由表（工程規範第 1 節：API 端點的唯一來源）。每個路由就是一個資料庫 api function，路徑是 /api/<fn>。
// 參數名 session 由後端從 cookie 填入；其餘參數照名稱從請求的 JSON 取，依順序對應 function 的 p_<名稱>。
// 回傳一律是 jsonb，結構寫在 returns；db/tests/kernel/90-contract.test.mjs 檢查 function 的簽章與實際回傳。
// 刻意沒有「只憑工作階段就能做決定」的路由：做決定只有 case_decide_passkey，身分由資料庫從通行金鑰的簽章得出。
// 這張表也是資料庫執行權限的唯一來源：db/tools/grants-sql.mjs 只把這裡列出的 function 授權給各執行期帳號
// （後端 sgn_app：routes、packRoutes、backendCalls；人員同步 sgn_sync：syncCalls；排程 sgn_job：jobCalls），
// db/tests/kernel/12-grants.test.mjs 檢查實際權限與這裡完全相等。
import type { Shape } from './shape.ts';

export { shapeProblems, type Shape } from './shape.ts';

export type Call = {
    readonly fn: string;
    readonly params: readonly string[];
    readonly returns: Shape;
};

const exceptionRef: Shape = { object: { id: 'int', rule_code: 'text', opened_at: 'timestamp', event_seq: 'int' } };

const message: Shape = { object: { code: 'text', message: 'text' } };
const contentError: Shape = { object: { path: 'text', code: 'text', message: 'text' } };

const principal: Shape = {
    object: { principal_id: 'uuid', kind: 'text', name: 'text', owner_name: 'text', ends_on: { nullable: 'date' } },
};

const pathStage: Shape = { object: { seq: 'int', code: 'text', name: 'text', phase: 'text', mode: 'text' } };

const caseFields = {
    case_id: 'uuid',
    case_no: 'int',
    process_type: 'text',
    state: 'text',
    tier: 'text',
    version: 'int',
    content: 'json',
    content_sha256: 'hex',
    version_sha256: 'hex',
    /** 核心保存與判定的欄位（不在流程包的內容裡）：被授權者、授權起迄（YYYY-MM-DD，申請人填的原值） */
    terms: { object: { principal: { nullable: principal }, valid_from: { nullable: 'text' }, valid_to: { nullable: 'text' } } },
    updated_at: 'timestamp',
    applicant_name: 'text',
    /** 目前開著（或停住＝halted）的那一關 */
    current_stage: { nullable: { object: { seq: 'int', code: 'text', name: 'text', phase: 'text', status: 'text' } } },
    /** 目前等誰處理（指派對象，或等認領的候選人） */
    waiting_on: { array: 'text' },
    /** 整理內容時的提示（例如 L1、L2 欄位已自動移除） */
    notices: { array: message },
    /** 送審前必須修正的地方（只有草稿與退回的單有） */
    errors: { array: contentError },
    exceptions: { array: exceptionRef },
} as const satisfies Record<string, Shape>;

/** 申請單摘要：所有回傳申請單清單的 function 共用。actions 是這個人現在可以做的動作，畫面依它顯示按鈕。 */
export const caseSummary: Shape = { object: { ...caseFields, actions: { array: 'text' } } };

const task: Shape = {
    object: {
        task_id: 'int',
        assignee_name: { nullable: 'text' },
        status: 'text',
        scope_refs: { array: 'text' },
        decided_version: { nullable: 'int' },
        reason: { nullable: 'text' },
        closed_at: { nullable: 'timestamp' },
    },
};

/** 申請單詳情：摘要＋每一關與每件工作、版本歷程、重疊檢查、執行內容、授權。 */
export const caseDetail: Shape = {
    object: {
        ...caseFields,
        actions: { array: 'text' },
        stages: {
            array: {
                object: {
                    seq: 'int',
                    code: 'text',
                    name: 'text',
                    phase: 'text',
                    status: 'text',
                    opened_at: 'timestamp',
                    closed_at: { nullable: 'timestamp' },
                    tasks: { array: task },
                },
            },
        },
        versions: {
            array: {
                object: {
                    version: 'int',
                    change_kind: 'text',
                    tier: 'text',
                    created_by_name: { nullable: 'text' },
                    created_at: 'timestamp',
                    content_sha256: 'hex',
                    version_sha256: 'hex',
                    /** 這一版的內容與 terms：畫面顯示「與前一版的差異」用 */
                    content: 'json',
                    terms: caseFields.terms,
                },
            },
        },
        overlap: { nullable: { object: { level: 'text', items: 'json', reason: { nullable: 'text' }, version: 'int' } } },
        fulfilment: { nullable: { object: { version: 'int', payload: 'json', payload_sha256: 'hex' } } },
        grant: {
            nullable: {
                object: { grant_id: 'uuid', valid_from: { nullable: 'date' }, valid_to: { nullable: 'date' }, status: 'text' },
            },
        },
    },
};

/**
 * 一次性亂數（裁決 D68）：瀏覽器用它和畫面上的內容自己算挑戰值再簽（web/lib/signing.js），後端不給可以直接簽的值。
 * input：決定的輸入整理後的樣子（縮小後核准要給簽核人看縮小後的內容）。
 */
const nonce: Shape = { object: { challenge_id: 'uuid', nonce: 'b64url', expires_at: 'timestamp' } };
const challenge: Shape = { object: { challenge_id: 'uuid', nonce: 'b64url', input: 'json', expires_at: 'timestamp' } };

/** 待核准的通行金鑰登記（短碼由畫面從指紋自己算）。 */
const enrollmentFields = {
    enrollment_id: 'uuid',
    person_id: 'uuid',
    person_name: 'text',
    credential_id: 'b64url',
    public_key_sha256: 'hex',
    status: 'text',
    requested_at: 'timestamp',
    actions: { array: 'text' },
} as const satisfies Record<string, Shape>;
const enrollment: Shape = { object: enrollmentFields };

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

const roleChange: Shape = {
    object: {
        request_id: 'uuid',
        holder_id: 'uuid',
        holder_name: 'text',
        role_code: 'text',
        role_name: 'text',
        scope_ref: { nullable: 'text' },
        /** grant（授予）或 revoke（撤除） */
        change: 'text',
        reason: 'text',
        /** pending、approved、cooling（治理類角色核准後的冷卻期）、blocked（冷卻期內被擋下） */
        status: 'text',
        proposed_by_name: 'text',
        proposed_at: 'timestamp',
        approved_by_name: { nullable: 'text' },
        approved_at: { nullable: 'timestamp' },
        effective_at: { nullable: 'timestamp' },
        blocked_by_name: { nullable: 'text' },
        actions: { array: 'text' },
    },
};

/**
 * 畫面呼叫的核心路由：POST /api/<fn>。每個使用者動作一個。
 * 決定（核准、縮小後核准、退回、駁回、撤回、執行完成）都是 challenge_issue → case_decide_passkey 兩步；
 * challenge_issue 的 input：退回、駁回、撤回 {reason}；縮小後核准 {content, terms}；其他 {}。
 * 第一步只回一次性亂數；瀏覽器從畫面上的單號、內容版本、決定種類與輸入自己算出挑戰值再簽（裁決 D68）。
 */
export const routes = [
    {
        fn: 'me',
        params: ['session'],
        returns: {
            object: {
                person_id: 'uuid',
                name: 'text',
                /** 可以簽章的通行金鑰數（已核准、已過冷卻期） */
                passkeys: 'int',
                passkey_cooling_until: { nullable: 'timestamp' },
                passkey_pending: { array: enrollment },
                capabilities: { array: 'text' },
            },
        },
    },
    {
        fn: 'process_type_list',
        params: ['session'],
        returns: {
            array: {
                object: {
                    code: 'text',
                    name: 'text',
                    options: 'json',
                    /** 每個級別在目前路徑上會經過的關卡（新申請畫面即時顯示） */
                    tiers: { array: { object: { code: 'text', name: 'text', stages: { array: pathStage } } } },
                },
            },
        },
    },
    { fn: 'principal_list', params: ['session'], returns: { array: principal } },
    { fn: 'case_create', params: ['session', 'process_type', 'content', 'terms'], returns: caseDetail },
    { fn: 'case_submit_new', params: ['session', 'process_type', 'content', 'terms', 'overlap_reason'], returns: caseDetail },
    { fn: 'case_revise', params: ['session', 'case_id', 'content', 'terms'], returns: caseDetail },
    { fn: 'case_submit', params: ['session', 'case_id', 'overlap_reason'], returns: caseDetail },
    { fn: 'case_get', params: ['session', 'case_id'], returns: caseDetail },
    { fn: 'case_list_mine', params: ['session'], returns: { array: caseSummary } },
    { fn: 'inbox_list', params: ['session'], returns: { array: caseSummary } },
    { fn: 'task_claim', params: ['session', 'case_id'], returns: caseSummary },
    { fn: 'challenge_issue', params: ['session', 'case_id', 'decision', 'input'], returns: challenge },
    {
        fn: 'case_decide_passkey',
        params: ['challenge_id', 'decision', 'credential_id', 'authenticator_data', 'client_data_json', 'signature'],
        returns: caseSummary,
    },
    { fn: 'passkey_register_begin', params: ['session'], returns: { object: { challenge_id: 'uuid', challenge: 'b64url' } } },
    // 通行金鑰登記的核准（裁決 D65）：本人用舊金鑰，或主管、登記人背書
    { fn: 'passkey_enrollment_list', params: ['session'], returns: { array: enrollment } },
    { fn: 'passkey_endorse_challenge', params: ['session', 'enrollment_id'], returns: nonce },
    {
        fn: 'passkey_endorse_passkey',
        params: ['challenge_id', 'credential_id', 'authenticator_data', 'client_data_json', 'signature'],
        returns: { object: { ...enrollmentFields, usable_from: 'timestamp' } },
    },
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
    // 角色指派變更（控制、平台、治理類角色只能走這裡）：提出與決定都要通行金鑰（裁決 D68、D69）
    {
        fn: 'role_change_options',
        params: ['session'],
        returns: {
            object: {
                roles: { array: { object: { code: 'text', name: 'text', category: 'text' } } },
                people: { array: { object: { person_id: 'uuid', name: 'text' } } },
                scopes: { array: { object: { scope_ref: 'text', label: 'text' } } },
            },
        },
    },
    { fn: 'role_change_list', params: ['session'], returns: { array: roleChange } },
    {
        fn: 'role_change_propose_challenge',
        params: ['session', 'holder_id', 'role_code', 'scope_ref', 'change', 'reason'],
        returns: nonce,
    },
    {
        fn: 'role_change_propose_passkey',
        params: ['challenge_id', 'credential_id', 'authenticator_data', 'client_data_json', 'signature'],
        returns: roleChange,
    },
    /** decision：approve（核准）或 block（冷卻期內擋下） */
    { fn: 'role_change_challenge', params: ['session', 'request_id', 'decision'], returns: nonce },
    {
        fn: 'role_change_decide_passkey',
        params: ['challenge_id', 'decision', 'credential_id', 'authenticator_data', 'client_data_json', 'signature'],
        returns: roleChange,
    },
] as const satisfies readonly Call[];

/** 流程包專屬的路由（api.<流程包>_*）；結構由各流程包的資料庫測試檢查（db/tests/packs/<流程包>/）。 */
export const packRoutes = {
    data_access: [
        {
            fn: 'data_access_catalog',
            params: ['session'],
            returns: {
                object: {
                    packages: {
                        array: {
                            object: {
                                code: 'text',
                                name: 'text',
                                period_field: { nullable: 'text' },
                                fields: { array: { object: { code: 'text', name: 'text', classification: 'text' } } },
                                filters: {
                                    array: {
                                        object: {
                                            code: 'text',
                                            name: 'text',
                                            value_type: 'text',
                                            values: { array: { object: { value: 'text', label: 'text' } } },
                                        },
                                    },
                                },
                            },
                        },
                    },
                    purpose_categories: { array: { object: { code: 'text', name: 'text', requires_description: 'bool' } } },
                },
            },
        },
    ],
} as const satisfies Record<string, readonly Call[]>;

/** 後端自己的流程（登入、登記通行金鑰的再驗證、登出、啟動）呼叫的 function；不直接開成 /api 路由。 */
export const backendCalls = {
    sessionBegin: { fn: 'session_begin', params: [], returns: { object: { challenge_id: 'uuid', nonce: 'b64url' } } },
    sessionOpen: {
        fn: 'session_open',
        params: ['challenge_id', 'id_token'],
        returns: { object: { session_token: 'b64url', person_id: 'uuid' } },
    },
    sessionClose: { fn: 'session_close', params: ['session'], returns: { object: { closed: 'bool' } } },
    /** 身分提供者再驗證之後只建立待核准的登記（裁決 D65） */
    passkeyRegister: {
        fn: 'passkey_register',
        params: ['challenge_id', 'id_token', 'credential_id', 'public_key_spki'],
        returns: { object: { credential_id: 'b64url', enrollment_id: 'uuid', status: 'text', public_key_sha256: 'hex' } },
    },
    /** 入口的參數（每個來源每分鐘的登入次數），後端啟動時讀一次 */
    frontdoorPolicy: { fn: 'frontdoor_policy', params: [], returns: { object: { login_attempts_per_minute: 'int' } } },
    errorCatalog: {
        fn: 'error_catalog',
        params: [],
        returns: { array: { object: { code: 'text', message: 'text', http_status: 'int' } } },
    },
} as const satisfies Record<string, Call>;

/** 只有名稱與參數的呼叫（人員同步、排程）：回傳不是畫面用的 jsonb 結構，由各自的工具讀取。 */
export type Grant = {
    readonly fn: string;
    readonly params: readonly string[];
};

/** 人員同步工具（db/tools/directory-sync.mjs，帳號 sgn_sync）能執行的 api_sync function。 */
export const syncCalls = {
    directoryApply: { fn: 'directory_apply', params: ['source', 'kind', 'total', 'entries'] },
} as const satisfies Record<string, Grant>;

/** 錨定與排程（db/tools/chain-lib.mjs，帳號 sgn_job）能執行的 api_job function。 */
export const jobCalls = {
    chainHead: { fn: 'chain_head', params: [] },
    eventsAfter: { fn: 'events_after', params: ['after_seq', 'limit'] },
    codeFingerprint: { fn: 'code_fingerprint', params: [] },
    directorySettle: { fn: 'directory_settle', params: [] },
    authChallengePurge: { fn: 'auth_challenge_purge', params: [] },
    anchorPolicy: { fn: 'anchor_policy', params: [] },
} as const satisfies Record<string, Grant>;
