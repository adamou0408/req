// 決定（核准、縮小後核准、退回、駁回、撤回、標記已套用）：確認面板 → 資料庫給一次性亂數 → 這個頁面從畫面上的內容
// 自己算挑戰值（web/lib/signing.js；裁決 D68）→ 裝置上的通行金鑰簽章 → 資料庫用自己的紀錄重算比對並套用。
// 認領不是決定，不需要通行金鑰。
import { api } from './api.js';
import { t } from './i18n.js';
import { fingerprintPayload, qrMatrix, qrPath } from './lib/qr.js';
import { decisionContent, groupedCode, keyFingerprint, shortCode, signingChallenge } from './lib/signing.js';
import { el, explain, flash, go, sheet } from './ui.js';
import { createPasskey, signChallenge, unb64url } from './webauthn.js';

const PENDING_KEY = 'sgn.passkey-pending';

/**
 * 通行金鑰的狀態提示：沒有金鑰就提示登記；登記了在等核准就顯示 QR 碼（完整指紋）與 12 位數核對碼（這個瀏覽器從自己保存的
 * 新金鑰指紋產生，不用後端給的；裁決 D76）；核准了在冷卻期就顯示什麼時候生效。都依 me 的欄位，不自己推斷。
 * 這筆登記只能當面核對（methods 只有 qr：本人只憑登入撤銷了金鑰）時不顯示核對碼。
 */
export function passkeyNotice(me) {
    if (me.passkeys > 0) return null;
    if (me.passkey_pending.length > 0) {
        const saved = savedEnrollment(me.passkey_pending);
        return el(
            'div',
            { class: 'result warn', 'data-testid': 'passkey-pending' },
            el('p', {}, saved && !saved.methods.includes('code') ? t.passkeyQrOnly : t.passkeyPending),
            saved ? enrollmentCode(saved) : el('p', {}, t.passkeyPendingNoCode),
        );
    }
    // 停用中（K-PASSKEY-SUSPEND）：不能另登新的，要用原來的金鑰申請恢復
    if (me.passkey_suspended > 0) {
        return el(
            'div',
            { class: 'result warn', 'data-testid': 'passkey-suspended' },
            el('p', {}, t.passkeySuspended),
            el('a', { href: '#passkeys', 'data-testid': 'open-passkey-restore-self' }, t.passkeys.restore),
        );
    }
    if (me.passkey_cooling_until) {
        return el(
            'div',
            { class: 'result warn', 'data-testid': 'passkey-cooling' },
            el('p', {}, t.passkeyCooling(me.passkey_cooling_until)),
            // 別人背書的新金鑰（例如被撤銷之後）：冷卻期內本人只憑登入就能回報不是自己登記的（K-PASSKEY-NOT-ME）
            me.passkey_disownable > 0 ? el('a', { href: '#passkeys', 'data-testid': 'open-not-me' }, t.passkeys.notMeOpen) : null,
        );
    }
    return el(
        'div',
        { class: 'result warn', 'data-testid': 'passkey-missing' },
        el('p', {}, t.passkeyMissing),
        el('button', { class: 'primary', onclick: () => registerPasskey(me) }, t.passkeyRegister),
    );
}

const SVG = 'http://www.w3.org/2000/svg';

/** 新裝置畫面上的 QR 碼（背書人的相機掃它取得完整指紋）。 */
function fingerprintQr(fingerprint) {
    const { path, size } = qrPath(qrMatrix(fingerprintPayload(fingerprint)));
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
    svg.setAttribute('class', 'qr');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', t.passkeyQrLabel);
    svg.setAttribute('data-testid', 'device-qr');
    svg.setAttribute('shape-rendering', 'crispEdges');
    const background = document.createElementNS(SVG, 'rect');
    background.setAttribute('width', String(size));
    background.setAttribute('height', String(size));
    background.setAttribute('fill', '#fff');
    const modules = document.createElementNS(SVG, 'path');
    modules.setAttribute('d', path);
    modules.setAttribute('fill', '#000');
    svg.append(background, modules);
    return svg;
}

/** 核對碼要一秒左右才算得出來，先顯示「計算中」。成本不在允許範圍就不顯示。 */
function codeLine(fingerprint, cost) {
    const code = el('p', { class: 'code', 'data-testid': 'short-code' }, t.passkeyCodeComputing);
    try {
        shortCode(fingerprint, cost).then(
            (value) => (code.textContent = groupedCode(value)),
            () => (code.textContent = t.passkeyCodeUnavailable),
        );
    } catch {
        code.textContent = t.passkeyCodeUnavailable;
    }
    return code;
}

/** 新裝置畫面上的 QR 碼、核對碼（這筆登記允許念碼時）與完整指紋。 */
function enrollmentCode({ fingerprint, cost, methods }) {
    return [
        methods.includes('qr') ? fingerprintQr(fingerprint) : null,
        methods.includes('code') ? codeLine(fingerprint, cost) : null,
        el('p', { class: 'muted mono', 'data-testid': 'device-fingerprint' }, t.passkeyFingerprint(fingerprint)),
    ];
}

/** 這個瀏覽器登記的新金鑰（自己保存的指紋）；只有它還在待核准清單裡才回傳，成本取那一筆登記的。 */
function savedEnrollment(pending) {
    try {
        const saved = JSON.parse(localStorage.getItem(PENDING_KEY) ?? 'null');
        const entry = pending.find((e) => e.credential_id === saved?.credentialId);
        return entry ? { fingerprint: saved.fingerprint, cost: entry.code_cost, methods: entry.methods } : null;
    } catch {
        return null;
    }
}

export async function registerPasskey(me) {
    try {
        const begin = await api.call('passkey_register_begin');
        const created = await createPasskey(me);
        const fingerprint = await keyFingerprint(unb64url(created.spki));
        try {
            localStorage.setItem(PENDING_KEY, JSON.stringify({ credentialId: created.credentialId, fingerprint }));
            sessionStorage.setItem('sgn.after-passkey', location.hash);
        } catch {
            // 存不了就只是回來時看不到核對碼，登記本身不受影響
        }
        const { redirect } = await api.passkeyReauth({
            challenge_id: begin.challenge_id,
            challenge: begin.challenge,
            credential_id: created.credentialId,
            spki: created.spki,
        });
        location.href = redirect;
    } catch (err) {
        flash(explain(err));
    }
}

/** 決定要簽的輸入（畫面上看得到的）：原因是使用者打的，縮小後的內容與顯示是資料庫整理過、在面板上顯示的那一份。 */
function signedInput(c, decision, typed, issued) {
    if (decision === 'approve_reduced') return { ...issued.input, display: issued.display };
    if (decision === 'fulfil') return { payload: c.fulfilment?.payload };
    return { reason: typed.reason?.replace(/^ +| +$/g, '') };
}

async function sign(c, decision, typed, issued) {
    const challenge = issued ?? (await api.call('challenge_issue', { case_id: c.case_id, decision, input: typed }));
    // 簽的是畫面畫出決定畫面用的那一份顯示摘要（D75）
    const content = await decisionContent(c.display, decision, signedInput(c, decision, typed, challenge));
    const toSign = await signingChallenge({ purpose: 'case.decision', ref: c.display.case_no, content, decision, nonce: challenge.nonce });
    const assertion = await signChallenge(toSign);
    return api.call('case_decide_passkey', {
        challenge_id: challenge.challenge_id,
        decision,
        credential_id: assertion.credentialId,
        authenticator_data: assertion.authenticatorData,
        client_data_json: assertion.clientDataJSON,
        signature: assertion.signature,
    });
}

function reasonBox(quickReasons, submit) {
    return [
        quickReasons.length
            ? el(
                  'div',
                  { class: 'quick-reasons', 'data-testid': 'quick-reasons' },
                  el('p', {}, t.quickReasons),
                  quickReasons.map((r) =>
                      el('button', { type: 'button', 'data-testid': 'quick-reason', onclick: () => submit(r) }, t.quickReturn(r)),
                  ),
                  el('p', {}, t.orTypeReason),
              )
            : null,
        el('label', { for: 'decision-reason' }, t.reasonLabel),
        el('textarea', { id: 'decision-reason', rows: 3, 'data-testid': 'decision-reason', required: true }),
    ];
}

/**
 * 打開確認面板。needsReason：退回、駁回、撤回要填原因；input：縮小後核准的內容（先請資料庫整理，面板上顯示整理後要簽的那一份）。
 * shown：面板上顯示要簽的內容（縮小後核准用）。quickReasons：常見原因（流程包提供；按一下就以它為原因簽，退回用）。
 * 成功時呼叫 done(結果)；失敗時面板留著並顯示錯誤，可以修正後再按。
 */
export function confirmDecision(
    c,
    decision,
    { input = {}, needsReason = false, quickReasons = [], consequence, issued = null, shown = null, done },
) {
    const error = el('p', { class: 'result bad', role: 'alert', hidden: true, 'data-testid': 'decision-error' });
    const panel = sheet(
        t.confirmTitle[decision],
        el('p', { 'data-testid': 'consequence' }, consequence),
        shown,
        needsReason ? reasonBox(quickReasons, (r) => run(r)) : null,
        el('p', { class: 'muted mono' }, t.binding(c.display.case_no, c.display.version, c.display.version_sha256.slice(0, 12))),
        error,
        el(
            'div',
            { class: 'row sheet-buttons' },
            el('button', { onclick: () => panel.remove() }, t.cancel),
            el('button', { class: 'primary', 'data-testid': 'confirm-passkey', onclick: () => run() }, t.confirmWithPasskey),
        ),
    );
    async function run(quick = null) {
        const reason = needsReason ? { reason: quick ?? panel.querySelector('#decision-reason').value } : {};
        try {
            const result = await sign(c, decision, { ...input, ...reason }, issued);
            panel.remove();
            await done(result);
        } catch (err) {
            error.textContent = explain(err);
            error.hidden = false;
        }
    }
    return panel;
}

/** 縮小後核准：先請資料庫整理並檢查縮小後的內容（拿到 nonce），面板上顯示整理後的內容，簽的就是它。 */
export async function confirmReduced(c, input, { consequence, view, done }) {
    try {
        const issued = await api.call('challenge_issue', { case_id: c.case_id, decision: 'approve_reduced', input });
        confirmDecision(c, 'approve_reduced', { input, consequence, issued, shown: view(issued.display), done });
    } catch (err) {
        go(`#case/${c.case_id}`, { text: explain(err), ok: false });
    }
}
