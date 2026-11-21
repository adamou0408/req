// 路由表（工程規範第 1 節：API 端點的唯一來源）。每個路由就是一個資料庫 api function，路徑是 /api/<fn>。
// 參數名 session 由後端從 cookie 填入；其餘參數照名稱從請求的 JSON 取，依順序對應 function 的 p_<名稱>。
// 回傳一律是 jsonb，結構寫在 returns；db/tests/kernel/90-contract.test.mjs 檢查 function 的簽章與實際回傳。
// 刻意沒有「只憑工作階段就能做決定」的路由：做決定只有 case_decide_passkey，身分由資料庫從通行金鑰的簽章得出。
// 這張表也是資料庫執行權限的唯一來源：db/tools/grants-sql.mjs 只把這裡列出的 function 授權給各執行期帳號
// （後端 sgn_app：routes、packRoutes、backendCalls；人員同步 sgn_sync：syncCalls；排程 sgn_scheduler：schedulerCalls；對帳 sgn_reconciler：
//  reconcilerCalls；錨定 sgn_anchor：anchorCalls；寄信 sgn_mailer：mailerCalls；交付程式 sgn_delivery：deliveryCalls；
//  身分提供者金鑰更新 sgn_idp_keys：idpCalls），
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

/** 例外清單的一組：同一規則、同一張單（全公司層級的例外沒有單號）；process_type 讓畫面取流程包的說明 */
const exceptionGroup: Shape = {
    object: {
        rule_code: 'text',
        process_type: { nullable: 'text' },
        case_no: { nullable: 'int' },
        count: 'int',
        first_opened_at: 'timestamp',
        last_opened_at: 'timestamp',
        last_closed_at: { nullable: 'timestamp' },
    },
};
const contentError: Shape = { object: { path: 'text', code: 'text', message: 'text' } };

const principalFields = {
    principal_id: 'uuid',
    kind: 'text',
    name: 'text',
    owner_name: 'text',
    ends_on: { nullable: 'date' },
} as const satisfies Record<string, Shape>;
const principal: Shape = { object: principalFields };

/** 新申請畫面的被授權者選項：mine＝看的人就是負責人（送審時不必多一關「被授權者負責人確認」，裁決 D79 (2)） */
const principalChoice: Shape = { object: { ...principalFields, mine: 'bool' } };

const pathStage: Shape = { object: { seq: 'int', code: 'text', name: 'text', phase: 'text', mode: 'text' } };

/** 畫面上的一個人：內部 id 與名字（同名的人已加上區分）。 */
const personRef: Shape = { object: { id: 'uuid', name: 'text' } };

/** 一個版本在畫面上的樣子（裁決 D75）：被授權者、授權起迄、內容的顯示文字（流程包的 display_content hook）。 */
const versionDisplay = {
    principal: { nullable: { object: { id: 'uuid', name: 'text', kind: 'text', owner: { nullable: personRef } } } },
    validity: { object: { from: { nullable: 'text' }, to: { nullable: 'text' } } },
    content: 'json',
} as const satisfies Record<string, Shape>;

/**
 * 決定畫面的顯示摘要（裁決 D75）：頁面只從它畫出決定畫面，並把它的雜湊簽進去；資料庫驗章時用自己的資料重算。
 * 只有字串、布林、null、陣列與物件。
 */
const caseDisplay: Shape = {
    object: {
        ...versionDisplay,
        case_no: 'text',
        process: { object: { code: 'text', name: 'text' } },
        version: 'text',
        version_sha256: 'hex',
        tier: { nullable: { object: { code: 'text', name: 'text' } } },
        applicant: personRef,
        exceptions: { array: { object: { id: 'text', rule_code: 'text' } } },
        overlap: { nullable: { object: { level: 'text', reason: { nullable: 'text' }, items: 'json' } } },
        /** 與看的人比較的基準版本（他上次決定的那一版，或最近有人決定的那一版）；新申請為 null */
        baseline: { nullable: { object: { ...versionDisplay, version: 'text' } } },
        reduced_by: { nullable: { object: { name: 'text', version: 'text' } } },
        stage: { object: { current: { nullable: 'text' }, next: { nullable: 'text' } } },
    },
};

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
    /**
     * 逾期還沒被處理的工作（裁決 D88 (3)；資料庫算，頁面不自行推斷）：kind 是 grant_expiry（迄日已過還沒到期）、
     * confirmation_expiry（確認期限已過還沒撤銷）或 delivery（交付超過時限沒有結果）；since 是開始逾期的時間。沒有時為 null。
     */
    overdue: { nullable: { object: { kind: 'text', since: 'timestamp' } } },
} as const satisfies Record<string, Shape>;

/**
 * 等申請人確認時的站內待辦（裁決 D84 (6)：不只靠郵件）：期限、剩幾個工作天、是不是已經在提醒期間（K-CONFIRM-REMIND）。其他時候為 null。
 */
const confirmDue: Shape = { nullable: { object: { due_text: 'text', workdays_left: 'int', reminding: 'bool' } } };

/** 申請單摘要：所有回傳申請單清單的 function 共用。actions 是這個人現在可以做的動作，畫面依它顯示按鈕。 */
export const caseSummary: Shape = { object: { ...caseFields, actions: { array: 'text' }, confirm_due: confirmDue } };

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

/**
 * 使用紀錄（裁決 D92 (4)）：使用方系統回報的批次摘要，每個鍵（單、人、時段）取最新的一批。last_used_at 是最後一次使用；
 * queries、exports、blocked、people 是近 recent_days 天（參數 usage.recent_days）的次數與實際使用的人數。這張單沒有任何回報時為 null。
 */
const caseUsage: Shape = {
    nullable: {
        object: {
            last_used_at: { nullable: 'timestamp' },
            last_used_text: { nullable: 'text' },
            recent_days: 'int',
            queries: 'int',
            exports: 'int',
            blocked: 'int',
            people: 'int',
        },
    },
};

/** 申請單詳情：摘要＋每一關與每件工作、版本歷程、重疊檢查、執行內容、授權。 */
export const caseDetail: Shape = {
    object: {
        ...caseFields,
        actions: { array: 'text' },
        confirm_due: confirmDue,
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
        /**
         * 給看的人的重疊提示（K-OVERLAP-SHOWN）：items 經流程包的顯示 hook 換成主題包與欄位的名稱；
         * 對方的單號與期間只在看的人本來就能看那張單時才有值，否則為 null。沒有重疊檢查為 null。
         */
        overlap_shown: { nullable: { object: { level: 'text', reason: { nullable: 'text' }, items: 'json' } } },
        fulfilment: { nullable: { object: { version: 'int', payload: 'json', payload_sha256: 'hex' } } },
        grant: {
            nullable: {
                object: { grant_id: 'uuid', valid_from: { nullable: 'date' }, valid_to: { nullable: 'date' }, status: 'text' },
            },
        },
        display: caseDisplay,
        /** 內容完全相同的其他進行中申請（裁決 D79 (6)：送出時提示並連到既有的那張） */
        duplicates: { array: { object: { case_id: 'uuid', case_no: 'int' } } },
        /** 這張單會經過的關卡（依這張單算，含代填時的「被授權者負責人確認」）；新申請畫面只畫它 */
        path: { array: pathStage },
        /**
         * 退回後修改中的單：這次修改和退回當時那一版比是 reduce（縮小）、same（沒改）還是 expand（擴大），
         * 送出後 resume（從退回的那一關繼續）還是 restart（從第一關重簽）。其他的單為 null。
         */
        resubmit: { nullable: { object: { change_kind: 'text', mode: 'text' } } },
        /**
         * 核准之後的系統對系統交付（裁決 D63）：每一筆交付（套用、撤回、清除、驗證）與每一輪自動驗證。
         * 執行關沒有人工工作時，畫面只顯示這裡的進度；人工退路只在有人工工作時出現。
         */
        delivery: {
            object: {
                ops: {
                    array: {
                        object: {
                            op_id: 'int',
                            channel: 'text',
                            /** apply（套用）、withdraw（撤回）、purge（清除到期）、verify（驗證） */
                            kind: 'text',
                            version: { nullable: 'int' },
                            /** queued、sending、done、rejected、superseded */
                            status: 'text',
                            attempts: 'int',
                            created_at: 'timestamp',
                            finished_at: { nullable: 'timestamp' },
                            next_attempt_at: { nullable: 'timestamp' },
                            last_http_status: { nullable: 'int' },
                            last_error: { nullable: 'text' },
                        },
                    },
                },
                verifications: {
                    array: {
                        object: {
                            run_id: 'int',
                            channel: 'text',
                            version: 'int',
                            /** pending、passed、failed、cancelled */
                            status: 'text',
                            created_at: 'timestamp',
                            finished_at: { nullable: 'timestamp' },
                            /** 流程包標成不驗的案例（例如使用方系統宣告做不到的限制；K-VERIFY-SKIPPED）：代碼、說明與原因 */
                            skipped: { array: { object: { code: 'text', description: 'text', reason: 'text' } } },
                            cases: {
                                array: {
                                    object: {
                                        code: 'text',
                                        description: 'text',
                                        expected: 'text',
                                        actual: { nullable: 'text' },
                                        /** 實際等於預期（核心判斷）；還沒有結果為 null */
                                        match: { nullable: 'bool' },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
        /**
         * 申請人確認驗證結果（K-CONFIRM）：最近一筆確認。status：pending（等申請人確認）、confirmed、disputed（回報不對）、
         * expired（逾期自動撤銷）、cancelled（等確認時被撤銷）。workdays_left 只在 pending 時有值（資料庫依營業日算）。沒有確認為 null。
         */
        confirmation: {
            nullable: {
                object: {
                    status: 'text',
                    version: 'int',
                    opened_at: 'timestamp',
                    due_at: 'timestamp',
                    /** 期限的當地時間（YYYY-MM-DD HH:MM） */
                    due_text: 'text',
                    workdays_left: { nullable: 'int' },
                    /** 開確認時用的參數值 confirmation.due_workdays */
                    due_workdays: 'int',
                    decided_at: { nullable: 'timestamp' },
                    decided_by: { nullable: personRef },
                    reason: { nullable: 'text' },
                },
            },
        },
        usage: caseUsage,
        /**
         * 看的人可以做、要填原因的動作 → 原因會讓誰看到（K-REASON-AUDIENCE）：applicant、principal_owner、
         * applicant_principal_owner 或 record（只記在這張單的紀錄）。畫面只依代碼取文案。
         */
        reason_audience: 'json',
    },
};

/**
 * 一次性亂數（裁決 D68）：瀏覽器用它和畫面上的內容自己算挑戰值再簽（web/lib/signing.js），後端不給可以直接簽的值。
 * input：決定的輸入整理後的樣子（縮小後核准要給簽核人看縮小後的內容）。
 */
const nonce: Shape = { object: { challenge_id: 'uuid', nonce: 'b64url', expires_at: 'timestamp' } };
const challenge: Shape = {
    object: {
        challenge_id: 'uuid',
        nonce: 'b64url',
        input: 'json',
        /** 縮小後核准：縮小後那一版的顯示（畫面只從它畫出要簽的縮小內容，也簽進去）；其他決定為 null */
        display: { nullable: { object: versionDisplay } },
        expires_at: 'timestamp',
    },
};

/**
 * 待核准的通行金鑰登記（裁決 D76）。display 是背書畫面唯一的資料來源（本人、金鑰編號、完整指紋）；
 * 12 位數核對碼由畫面從指紋與 code_cost 自己算（web/lib/signing.js 的 shortCode）。
 */
const enrollmentFields = {
    enrollment_id: 'uuid',
    credential_id: 'b64url',
    status: 'text',
    requested_at: 'timestamp',
    code_cost: 'int',
    /** 背書可以用的核對方式（qr、code）；本人只憑登入撤銷全部金鑰之後只有參數列的方式（預設只有 qr） */
    methods: { array: 'text' },
    display: { object: { person: personRef, credential_id: 'b64url', public_key_sha256: 'hex' } },
    actions: { array: 'text' },
} as const satisfies Record<string, Shape>;
const enrollment: Shape = { object: enrollmentFields };

/** 撤銷的顯示摘要：本人與每一把沒撤銷的金鑰。撤銷畫面只從它畫，簽的是它加上原因。 */
const revocationDisplay: Shape = {
    object: {
        person: personRef,
        credentials: { array: { object: { credential_id: 'b64url', public_key_sha256: 'hex', usable_from: 'timestamp' } } },
    },
};
const revocationResult: Shape = {
    object: {
        person: personRef,
        revoked: 'int',
        cancelled_enrollments: 'int',
        revoked_at: 'timestamp',
        reenroll_methods: { array: 'text' },
    },
};

/** 只憑登入停用自己的全部通行金鑰的結果（裁決 D84 (2)：不是撤銷）。 */
const suspensionResult: Shape = {
    object: {
        person: personRef,
        suspended: 'int',
        cancelled_enrollments: 'int',
        suspended_at: { nullable: 'timestamp' },
        /** 全公司只憑登入的停用超過上限（K-PASSKEY-SUSPEND-FLOOD）：沒有停用，資料庫已開例外；畫面顯示 message。其他時候為 null */
        refused: { nullable: message },
    },
};

/** 本人可以回報「不是我登記的」的新金鑰（K-PASSKEY-NOT-ME）：別人背書、還在冷卻期。畫面只從 display 畫。 */
const disownable: Shape = {
    object: {
        display: {
            object: {
                credential_id: 'b64url',
                public_key_sha256: 'hex',
                endorsed_by: personRef,
                endorsed_at: 'timestamp',
                usable_from: 'timestamp',
            },
        },
        actions: { array: 'text' },
    },
};

/** 恢復的顯示摘要：本人、停用的每一把金鑰、停用時間。恢復畫面只從它畫，本人與背書人簽的都是它。 */
const suspensionDisplay: Shape = {
    object: {
        suspension_id: 'uuid',
        person: personRef,
        credentials: { array: { object: { credential_id: 'b64url', public_key_sha256: 'hex', usable_from: 'timestamp' } } },
        suspended_at: 'timestamp',
    },
};

const auditCase: Shape = {
    object: {
        case: { object: { ...caseFields, confirm_due: confirmDue } },
        usage: caseUsage,
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

/** 角色指派變更的顯示摘要（裁決 D75）：畫面只從它畫、簽的就是它。 */
const roleChangeDisplay: Shape = {
    object: {
        holder: personRef,
        role: { object: { code: 'text', name: 'text' } },
        scope: { nullable: { object: { ref: 'text', label: 'text' } } },
        /** grant（授予）或 revoke（撤除） */
        change: 'text',
        reason: 'text',
        proposed_by: { nullable: personRef },
        approved_by: { nullable: personRef },
    },
};

const roleChange: Shape = {
    object: {
        request_id: 'uuid',
        /** pending、approved、cooling（治理類角色核准後的冷卻期）、blocked（冷卻期內被擋下） */
        status: 'text',
        proposed_at: 'timestamp',
        approved_at: { nullable: 'timestamp' },
        effective_at: { nullable: 'timestamp' },
        blocked_by_name: { nullable: 'text' },
        display: roleChangeDisplay,
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
                /** 只憑登入停用、還沒恢復的金鑰數（K-PASSKEY-SUSPEND） */
                passkey_suspended: 'int',
                passkey_cooling_until: { nullable: 'timestamp' },
                /** 別人背書、還在冷卻期、本人可以回報「不是我登記的」的金鑰數（K-PASSKEY-NOT-ME） */
                passkey_disownable: 'int',
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
    { fn: 'principal_list', params: ['session'], returns: { array: principalChoice } },
    { fn: 'case_create', params: ['session', 'process_type', 'content', 'terms'], returns: caseDetail },
    { fn: 'case_submit_new', params: ['session', 'process_type', 'content', 'terms', 'overlap_reason'], returns: caseDetail },
    { fn: 'case_revise', params: ['session', 'case_id', 'content', 'terms'], returns: caseDetail },
    { fn: 'case_submit', params: ['session', 'case_id', 'overlap_reason'], returns: caseDetail },
    { fn: 'case_get', params: ['session', 'case_id'], returns: caseDetail },
    { fn: 'case_list_mine', params: ['session'], returns: { array: caseSummary } },
    /** 捨棄從沒送審過的草稿（K-CASE-DISCARD）：轉為已取消、留稽核事件，之後不在「我的申請」 */
    { fn: 'case_discard', params: ['session', 'case_id'], returns: caseDetail },
    { fn: 'inbox_list', params: ['session'], returns: { array: caseSummary } },
    { fn: 'task_claim', params: ['session', 'case_id'], returns: caseSummary },
    { fn: 'challenge_issue', params: ['session', 'case_id', 'decision', 'input'], returns: challenge },
    /** 撤銷生效中的授權（不需要簽核，必須填原因）；外部系統上的權限自動撤回 */
    { fn: 'case_revoke', params: ['session', 'case_id', 'reason'], returns: caseDetail },
    /** 生效中的授權只做縮小（不用重簽）；新的一版自動送出並重新驗證 */
    { fn: 'case_reduce', params: ['session', 'case_id', 'content', 'terms', 'reason'], returns: caseDetail },
    /** 申請人確認驗證結果正確，授權才生效（K-CONFIRM；不是簽核決定，不用通行金鑰） */
    { fn: 'case_confirm_verification', params: ['session', 'case_id'], returns: caseDetail },
    /** 申請人回報驗證結果不對：不生效、撤回、開例外並通知（K-CONFIRM-DISPUTE） */
    { fn: 'case_dispute_verification', params: ['session', 'case_id', 'reason'], returns: caseDetail },
    {
        fn: 'case_decide_passkey',
        params: ['challenge_id', 'decision', 'credential_id', 'authenticator_data', 'client_data_json', 'signature'],
        returns: caseSummary,
    },
    { fn: 'passkey_register_begin', params: ['session'], returns: { object: { challenge_id: 'uuid', challenge: 'b64url' } } },
    // 通行金鑰登記的核准（裁決 D65）：本人用舊金鑰，或主管、登記人背書
    { fn: 'passkey_enrollment_list', params: ['session'], returns: { array: enrollment } },
    /** method：qr（掃新裝置的 QR 碼取得完整指紋）或 code（12 位數核對碼） */
    { fn: 'passkey_endorse_challenge', params: ['session', 'enrollment_id', 'method'], returns: nonce },
    {
        fn: 'passkey_endorse_passkey',
        params: ['challenge_id', 'credential_id', 'authenticator_data', 'client_data_json', 'signature'],
        returns: { object: { ...enrollmentFields, usable_from: 'timestamp' } },
    },
    /** 撤銷通行金鑰：actions 是 revoke_self（本人只憑登入，遺失全部裝置）或 revoke（用自己的通行金鑰簽） */
    {
        fn: 'passkey_revocation_list',
        params: ['session'],
        returns: { array: { object: { display: revocationDisplay, actions: { array: 'text' } } } },
    },
    /** 只憑登入＝停用（不是撤銷；裁決 D84 (2)），本人以原金鑰加主管或登記人背書可恢復 */
    { fn: 'passkey_revoke_self', params: ['session', 'reason'], returns: suspensionResult },
    /** 停用中的金鑰：actions 是 restore（本人用原金鑰簽）或 endorse_restore（主管、登記人背書）；status 是 suspended 或 self_confirmed */
    {
        fn: 'passkey_suspension_list',
        params: ['session'],
        returns: { array: { object: { display: suspensionDisplay, status: 'text', actions: { array: 'text' } } } },
    },
    {
        fn: 'passkey_restore_challenge',
        params: ['session', 'suspension_id'],
        returns: {
            object: { challenge_id: 'uuid', nonce: 'b64url', expires_at: 'timestamp', decision: 'text', display: suspensionDisplay },
        },
    },
    {
        fn: 'passkey_restore_passkey',
        params: ['challenge_id', 'credential_id', 'authenticator_data', 'client_data_json', 'signature'],
        returns: { object: { suspension_id: 'uuid', status: 'text', person: personRef } },
    },
    /** 冷卻期內本人只憑登入回報「不是我登記的」（裁決 D88 (1)）：只會收回 */
    { fn: 'passkey_not_me_list', params: ['session'], returns: { array: disownable } },
    {
        fn: 'passkey_report_not_me',
        params: ['session', 'credential_id'],
        returns: {
            object: {
                person: personRef,
                revoked: 'int',
                cancelled_enrollments: 'int',
                revoked_at: 'timestamp',
                reports_left: 'int',
            },
        },
    },
    {
        fn: 'passkey_revoke_challenge',
        params: ['session', 'holder_id', 'reason'],
        returns: { object: { challenge_id: 'uuid', nonce: 'b64url', expires_at: 'timestamp', display: revocationDisplay } },
    },
    {
        fn: 'passkey_revoke_passkey',
        params: ['challenge_id', 'credential_id', 'authenticator_data', 'client_data_json', 'signature'],
        returns: revocationResult,
    },
    { fn: 'audit_case', params: ['session', 'case_no'], returns: auditCase },
    { fn: 'audit_chain', params: ['session', 'after_seq', 'limit'], returns: { array: chainEvent } },
    {
        fn: 'audit_code_fingerprint',
        params: ['session'],
        returns: { object: { code_fingerprint: 'hex', anchor_policy: { object: { max_lag_seconds: 'int', max_lag_events: 'int' } } } },
    },
    {
        fn: 'audit_exceptions',
        params: ['session'],
        returns: {
            array: {
                object: {
                    id: 'int',
                    rule_code: 'text',
                    case_no: { nullable: 'int' },
                    opened_at: 'timestamp',
                    event_seq: 'int',
                    /** 狀況解除時結案（K-EXCEPTION-CLOSE）；未結案為 null */
                    closed_at: { nullable: 'timestamp' },
                },
            },
        },
    },
    /** 稽核首頁的例外清單（K-HOME-ORDER）：同一規則同一張單合成一筆，未結案與已結案分開，順序由資料庫決定 */
    {
        fn: 'audit_exception_groups',
        params: ['session'],
        returns: { object: { open: { array: exceptionGroup }, closed: { array: exceptionGroup } } },
    },
    /**
     * 稽核頁的存活檢查（K-PROGRAM-STALLED）：觸發一次檢查（會開例外與結案，所以不叫 audit_*），
     * 回傳每個背景程式最後一次心跳與每種逾期還沒被處理的工作。
     */
    {
        fn: 'program_health',
        params: ['session'],
        returns: {
            object: {
                programs: {
                    array: {
                        object: {
                            code: 'text',
                            name: 'text',
                            last_seen: { nullable: 'timestamp' },
                            max_seconds: 'int',
                            stalled: 'bool',
                        },
                    },
                },
                overdue: {
                    array: {
                        object: {
                            kind: 'text',
                            count: 'int',
                            oldest_since: 'timestamp',
                            oldest_case_no: { nullable: 'int' },
                            max_seconds: 'int',
                            stalled: 'bool',
                        },
                    },
                },
                opened: 'int',
                closed: 'int',
            },
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
        returns: { object: { challenge_id: 'uuid', nonce: 'b64url', expires_at: 'timestamp', display: roleChangeDisplay } },
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

const catalogPending: Shape = {
    object: {
        exception_id: 'int',
        case_id: 'uuid',
        case_no: 'int',
        from_version_no: 'int',
        to_version_no: 'int',
        due_at: 'timestamp',
        packages: { array: 'text' },
        changes: { array: { object: { code: 'text', before: { nullable: 'text' }, after: { nullable: 'text' } } } },
    },
};

const exportGuidance: Shape = { nullable: { object: { kind: 'text', text: 'text' } } };
const surveyCount: Shape = { object: { code: 'text', name: 'text', cases: 'int', exported: 'int' } };

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
                                fields: {
                                    array: {
                                        object: {
                                            code: 'text',
                                            name: 'text',
                                            classification: 'text',
                                            /** 這個欄位在某一區已去識別或遮罩後的分級（D93 (2)） */
                                            environments: {
                                                array: { object: { environment: 'text', classification: 'text', treatment_name: 'text' } },
                                            },
                                        },
                                    },
                                },
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
                    /** 環境的選項（D93）：is_default＝沒有指定時以它處理；requires_test_basis＝送審要引用測試區單或填理由 */
                    environments: {
                        array: {
                            object: {
                                code: 'text',
                                name: 'text',
                                description: 'text',
                                requires_test_basis: 'bool',
                                is_default: 'bool',
                                applies_to_legacy: 'bool',
                                max_months: 'int',
                            },
                        },
                    },
                    /**
                     * 匯出需求調查的選項（DA-EXPORT-SURVEY）：目的、頻率、方法。guidance 是選了之後要顯示的引導（DA-EXPORT-SURVEY-GUIDE）：
                     * kind 是 redirect（應由另一個系統自己申請）或 alternative（系統內的替代做法）；沒有時為 null
                     */
                    export_survey: {
                        object: {
                            purposes: {
                                array: { object: { code: 'text', name: 'text', requires_description: 'bool', guidance: exportGuidance } },
                            },
                            frequencies: { array: { object: { code: 'text', name: 'text' } } },
                            methods: {
                                array: { object: { code: 'text', name: 'text', requires_description: 'bool', guidance: exportGuidance } },
                            },
                        },
                    },
                },
            },
        },
        /** 匯出需求調查的彙總（DA-EXPORT-SURVEY-SUMMARY）：稽核或 MIS；每個選項有幾張單、其中幾張最後可以匯出 */
        {
            fn: 'data_access_export_survey_summary',
            params: ['session'],
            returns: {
                object: {
                    total: 'int',
                    by_purpose: { array: surveyCount },
                    by_frequency: { array: surveyCount },
                    by_method: { array: surveyCount },
                },
            },
        },
        /** 上線後的使用報告（D94 (4)）：申請人以這張單自己的使用紀錄產生，結掉限期補報告的例外；display 是報告的顯示（同送審的測試報告） */
        {
            fn: 'data_access_usage_report',
            params: ['session', 'case_id'],
            returns: { object: { case_id: 'uuid', report_sha256: 'hex', display: 'json' } },
        },
        /** 首頁：等看的人補的上線後使用報告（D94 (4)） */
        {
            fn: 'data_access_report_pending',
            params: ['session'],
            returns: { array: { object: { exception_id: 'int', case_id: 'uuid', case_no: 'int', due_at: 'timestamp', due_text: 'text' } } },
        },
        /** 申請正式區時可以引用的測試區單（D93 (4)）：涵蓋與否在送審時判定 */
        {
            fn: 'data_access_test_bases',
            params: ['session', 'principal_id'],
            returns: {
                array: {
                    object: {
                        case_id: 'uuid',
                        case_no: 'int',
                        state: 'text',
                        principal_name: { nullable: 'text' },
                        valid_from: { nullable: 'date' },
                        valid_to: { nullable: 'date' },
                        packages: { array: 'text' },
                    },
                },
            },
        },
        /** 等看的人（資料擁有者）確認的目錄異動：只改名稱的項目（D92 (6)）；畫面依這份清單顯示「確認」 */
        { fn: 'data_access_catalog_pending', params: ['session'], returns: { array: catalogPending } },
        { fn: 'data_access_catalog_confirm', params: ['session', 'exception_id'], returns: { array: catalogPending } },
    ],
} as const satisfies Record<string, readonly Call[]>;

/** 後端自己的流程（登入、登記通行金鑰的再驗證、登出、啟動）呼叫的 function；不直接開成 /api 路由。 */
export const backendCalls = {
    /** source：後端依 frontdoor_policy 認定的登入來源（裁決 D78：每個來源各自的上限在資料庫） */
    sessionBegin: { fn: 'session_begin', params: ['source'], returns: { object: { challenge_id: 'uuid', nonce: 'b64url' } } },
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
    /** 入口的參數（登入來源的認定方式、受信任的反向代理），後端啟動時讀一次 */
    frontdoorPolicy: {
        fn: 'frontdoor_policy',
        params: [],
        returns: { object: { client_source: 'text', trusted_proxies: { array: 'text' } } },
    },
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

/**
 * api_job 的 function，依程式分成四個帳號（裁決 D84 (6)：排程、對帳、錨定、寄信各用各的資料庫角色）。
 * 拿到其中一個程式的密鑰，只能執行那個程式的入口：例如寄信程式讀不到稽核鏈、不能交對帳回報；錨定程式不能領通知。
 */
/** 錨定程式（db/tools/anchor.mjs、db/tools/chain-lib.mjs，帳號 sgn_anchor）：讀鏈頭與事件、程式指紋，寫好錨點後告訴資料庫 */
export const anchorCalls = {
    chainHead: { fn: 'chain_head', params: [] },
    eventsAfter: { fn: 'events_after', params: ['after_seq', 'limit'] },
    codeFingerprint: { fn: 'code_fingerprint', params: [] },
    anchorPolicy: { fn: 'anchor_policy', params: [] },
    /** 錨點存放處收下錨點之後回報（資料庫依它判斷錨定有沒有落後，K-ANCHOR-LAG） */
    anchorRecorded: { fn: 'anchor_recorded', params: ['seq', 'hash', 'code_fingerprint'] },
    /** 每一輪回報心跳並檢查其他程式（K-PROGRAM-STALLED；裁決 D88 (3)） */
    anchorHeartbeat: { fn: 'anchor_heartbeat', params: [] },
} as const satisfies Record<string, Grant>;

/** 通知寄送（api/src/mailer.ts，帳號 sgn_mailer；裁決 D76）：領走一批、寄出後回報 */
export const mailerCalls = {
    notificationClaim: { fn: 'notification_claim', params: ['limit'] },
    notificationMark: { fn: 'notification_mark', params: ['id', 'sent', 'error'] },
    /** 每一輪回報心跳並檢查其他程式（K-PROGRAM-STALLED） */
    mailerHeartbeat: { fn: 'mailer_heartbeat', params: [] },
} as const satisfies Record<string, Grant>;

/** 對帳（api/src/reconciler.ts，帳號 sgn_reconciler）：外部系統簽過的對帳回報交給資料庫驗證與比對 */
export const reconcilerCalls = {
    reconciliationSubmit: { fn: 'reconciliation_submit', params: ['channel', 'report'] },
    /** 使用紀錄的批次摘要（外部系統簽過的）交給資料庫驗證與保存（K-USAGE-ATTESTED；裁決 D92 (4)） */
    usageSubmit: { fn: 'usage_submit', params: ['channel', 'response'] },
    /** 每一輪回報心跳並檢查其他程式（K-PROGRAM-STALLED） */
    reconcilerHeartbeat: { fn: 'reconciler_heartbeat', params: [] },
} as const satisfies Record<string, Grant>;

/** 排程（db/tools/jobs.mjs，帳號 sgn_scheduler） */
export const schedulerCalls = {
    /** 每一輪先回報心跳並檢查其他程式（K-PROGRAM-STALLED；排程停了由別的程式與稽核頁發現） */
    schedulerHeartbeat: { fn: 'scheduler_heartbeat', params: [] },
    directorySettle: { fn: 'directory_settle', params: [] },
    authChallengePurge: { fn: 'auth_challenge_purge', params: [] },
    /** 治理類角色的持有人沒有可用的通行金鑰時開例外（裁決 D77） */
    governanceCheck: { fn: 'governance_check', params: [] },
    /** 超過時間還沒寄出的通知開例外 K-NOTIFY-STUCK（寫入通知的交易也會檢查，不只靠排程） */
    notificationStuckCheck: { fn: 'notification_stuck_check', params: [] },
    /** 交付超過時間還沒有結果時開例外 K-DELIVERY-STUCK 並通知升級對象 */
    deliveryStuckCheck: { fn: 'delivery_stuck_check', params: [] },
    /** 授權迄日已過的授權結束並排清除 */
    grantExpireDue: { fn: 'grant_expire_due', params: [] },
    /** 確認期限已過還沒確認的單自動撤銷並撤回（K-CONFIRM-TIMEOUT；交付程式的領取也會檢查） */
    confirmationExpireDue: { fn: 'confirmation_expire_due', params: [] },
    /** 確認期限前的提醒（K-CONFIRM-REMIND；站內待辦標出、提醒對象逐日擴大） */
    confirmationRemindDue: { fn: 'confirmation_remind_due', params: [] },
    /** 超過時間沒有有效的對帳回報時開例外 K-RECON-OVERDUE（裁決 D81 (3)） */
    reconciliationOverdueCheck: { fn: 'reconciliation_overdue_check', params: [] },
    /** 錨定落後超過參數時開例外 K-ANCHOR-LAG（裁決 D84 (7)） */
    anchorLagCheck: { fn: 'anchor_lag_check', params: [] },
    /** 有期限的例外逾期還沒結案時通知升級對象（K-EXCEPTION-FOLLOWUP） */
    exceptionFollowupDue: { fn: 'exception_followup_due', params: [] },
    /** 閒置的授權提醒收回、使用摘要逾期（K-USAGE-IDLE、K-USAGE-OVERDUE） */
    usageChecks: { fn: 'usage_checks', params: [] },
} as const satisfies Record<string, Grant>;

/** 身分提供者的金鑰更新程序（db/tools/idp-keys.mjs，帳號 sgn_idp_keys；裁決 D81 (5)）能執行的 api_idp function。 */
export const idpCalls = {
    idpKeysSync: { fn: 'idp_keys_sync', params: ['issuer', 'jwks'] },
    /** 每一輪回報心跳並檢查其他程式（K-PROGRAM-STALLED） */
    idpKeysHeartbeat: { fn: 'idp_keys_heartbeat', params: [] },
} as const satisfies Record<string, Grant>;

/**
 * 交付程式（api/src/delivery.ts，帳號 sgn_delivery）能執行的 api_delivery function。
 * 和後端（sgn_app）、排程（sgn_scheduler）分開：被入侵的後端不能領取交付，也不能謊報外部系統的結果。
 */
export const deliveryCalls = {
    deliveryClaim: { fn: 'delivery_claim', params: ['channel', 'limit'] },
    deliveryReport: { fn: 'delivery_report', params: ['op_id', 'lease_token', 'outcome'] },
    /** 每一輪回報心跳並檢查其他程式（K-PROGRAM-STALLED） */
    deliveryHeartbeat: { fn: 'delivery_heartbeat', params: [] },
} as const satisfies Record<string, Grant>;
