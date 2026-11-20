// 決定（核准、縮小後核准、退回、駁回、撤回、標記已套用）：確認面板 → 資料庫發挑戰值（綁定版本與輸入）
// → 裝置上的通行金鑰簽章 → 資料庫驗證並套用。認領不是決定，不需要通行金鑰。
import { api } from './api.js';
import { t } from './i18n.js';
import { el, explain, flash, sheet } from './ui.js';
import { createPasskey, signChallenge } from './webauthn.js';

/** 有沒有通行金鑰由 me.passkeys 判斷；沒有就提示先登記。 */
export function passkeyNotice(me) {
    if (me.passkeys > 0) return null;
    return el(
        'div',
        { class: 'result warn', 'data-testid': 'passkey-missing' },
        el('p', {}, t.passkeyMissing),
        el('button', { class: 'primary', onclick: () => registerPasskey(me) }, t.passkeyRegister),
    );
}

export async function registerPasskey(me) {
    try {
        const begin = await api.call('passkey_register_begin');
        const created = await createPasskey(me);
        const { redirect } = await api.passkeyReauth({
            challenge_id: begin.challenge_id,
            challenge: begin.challenge,
            credential_id: created.credentialId,
            spki: created.spki,
        });
        sessionStorage.setItem('sgn.after-passkey', location.hash);
        location.href = redirect;
    } catch (err) {
        flash(explain(err));
    }
}

async function sign(c, decision, input) {
    const challenge = await api.call('challenge_issue', { case_id: c.case_id, decision, input });
    const assertion = await signChallenge(challenge.challenge);
    return api.call('case_decide_passkey', {
        challenge_id: challenge.challenge_id,
        decision,
        credential_id: assertion.credentialId,
        authenticator_data: assertion.authenticatorData,
        client_data_json: assertion.clientDataJSON,
        signature: assertion.signature,
    });
}

function reasonBox() {
    return [
        el('label', { for: 'decision-reason' }, t.reasonLabel),
        el('textarea', { id: 'decision-reason', rows: 3, 'data-testid': 'decision-reason', required: true }),
    ];
}

/**
 * 打開確認面板。needsReason：退回、駁回、撤回要填原因；input：縮小後核准的內容。
 * 成功時呼叫 done(結果)；失敗時面板留著並顯示錯誤（例如沒填原因、內容不是縮小），可以修正後再按。
 */
export function confirmDecision(c, decision, { input = {}, needsReason = false, consequence, done }) {
    const error = el('p', { class: 'result bad', role: 'alert', hidden: true, 'data-testid': 'decision-error' });
    const panel = sheet(
        t.confirmTitle[decision],
        el('p', { 'data-testid': 'consequence' }, consequence),
        needsReason ? reasonBox() : null,
        el('p', { class: 'muted mono' }, t.binding(c.case_no, c.version, c.content_sha256.slice(0, 12))),
        error,
        el(
            'div',
            { class: 'row sheet-buttons' },
            el('button', { onclick: () => panel.remove() }, t.cancel),
            el('button', { class: 'primary', 'data-testid': 'confirm-passkey', onclick: () => run() }, t.confirmWithPasskey),
        ),
    );
    async function run() {
        const reason = needsReason ? { reason: panel.querySelector('#decision-reason').value } : {};
        try {
            const result = await sign(c, decision, { ...input, ...reason });
            panel.remove();
            await done(result);
        } catch (err) {
            error.textContent = explain(err);
            error.hidden = false;
        }
    }
    return panel;
}
