// API 呼叫層：頁面只透過這裡和後端溝通。錯誤訊息直接用後端回傳的（來自資料庫的錯誤目錄）。
export class ApiFailure extends Error {
    constructor(code, message, status) {
        super(message);
        this.code = code;
        this.status = status;
    }
}

async function post(path, body = {}) {
    const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok) throw new ApiFailure(payload.error.code, payload.error.message, response.status);
    return payload.result;
}

export const api = {
    me: () => post('/api/me'),
    caseCreate: (content) => post('/api/case_create', { content }),
    caseSubmit: (caseId) => post('/api/case_submit', { case_id: caseId }),
    caseListMine: () => post('/api/case_list_mine'),
    inboxList: () => post('/api/inbox_list'),
    challengeIssue: (caseId, decision) => post('/api/challenge_issue', { case_id: caseId, decision }),
    caseDecidePasskey: (challengeId, decision, assertion) =>
        post('/api/case_decide_passkey', {
            challenge_id: challengeId,
            decision,
            credential_id: assertion.credentialId,
            authenticator_data: assertion.authenticatorData,
            client_data_json: assertion.clientDataJSON,
            signature: assertion.signature,
        }),
    passkeyRegisterBegin: () => post('/api/passkey_register_begin'),
    passkeyReauth: (body) => post('/auth/passkey', body),
    auditCase: (caseNo) => post('/api/audit_case', { case_no: caseNo }),
    auditChain: (afterSeq, limit) => post('/api/audit_chain', { after_seq: afterSeq, limit }),
    auditCodeFingerprint: () => post('/api/audit_code_fingerprint'),
    anchors: async () => {
        const text = await (await fetch('/anchors')).text();
        return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    },
    logout: () => post('/auth/logout'),
};
