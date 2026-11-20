// 通行金鑰登記的核准（裁決 D65、D76）：已有金鑰的人由本人用舊金鑰核准；第一把金鑰由本人的主管或登記人背書。
// 都要和新裝置畫面核對：本人念出新裝置上的 12 位數核對碼，這個頁面從清單上的完整指紋自己算一次（慢速雜湊，約一秒），
// 一樣才簽。簽的內容是清單的顯示摘要（本人、金鑰編號、指紋）加上核對方式與成本，資料庫用自己的紀錄重算（D75）。
// 掃 QR 碼（完整指紋）的方式資料庫已支援，畫面還沒有（見 docs/handoff/redteam-fixes-3.md）。
import { api } from '../api.js';
import { passkeyNotice } from '../decide.js';
import { t } from '../i18n.js';
import { groupedCode, shortCode, signingChallenge } from '../lib/signing.js';
import { dateText, el, empty, explain, facts, go, section, sheet } from '../ui.js';
import { signChallenge } from '../webauthn.js';

const k = t.passkeys;

async function endorseWithPasskey(e) {
    const nonce = await api.call('passkey_endorse_challenge', { enrollment_id: e.enrollment_id, method: 'code' });
    const content = { ...e.display, method: 'code', code_cost: e.code_cost };
    const assertion = await signChallenge(
        await signingChallenge({ purpose: 'passkey.enrollment', ref: e.enrollment_id, content, decision: 'endorse', nonce: nonce.nonce }),
    );
    return api.call('passkey_endorse_passkey', {
        challenge_id: nonce.challenge_id,
        credential_id: assertion.credentialId,
        authenticator_data: assertion.authenticatorData,
        client_data_json: assertion.clientDataJSON,
        signature: assertion.signature,
    });
}

function confirmEndorse(e, code) {
    const error = el('p', { class: 'result bad', role: 'alert', hidden: true, 'data-testid': 'decision-error' });
    const panel = sheet(
        k.confirmTitle,
        el('p', { 'data-testid': 'consequence' }, k.consequence(e.display.person.name, code)),
        error,
        el(
            'div',
            { class: 'row sheet-buttons' },
            el('button', { onclick: () => panel.remove() }, t.cancel),
            el('button', { class: 'primary', 'data-testid': 'confirm-passkey', onclick: () => run() }, t.confirmWithPasskey),
        ),
    );
    async function run() {
        try {
            await endorseWithPasskey(e);
            panel.remove();
            go('#passkeys', { text: k.endorsed, ok: true });
        } catch (err) {
            error.textContent = explain(err);
            error.hidden = false;
        }
    }
}

/** 本人念的碼和這個頁面從指紋算的一樣，才打開確認面板；不一樣就不簽。 */
async function checkCode(e, input, result) {
    result.hidden = false;
    result.className = 'result';
    result.textContent = t.passkeyCodeComputing;
    try {
        const expected = await shortCode(e.display.public_key_sha256, e.code_cost);
        if (input.value.replace(/\D/g, '') !== expected) {
            result.className = 'result bad';
            result.textContent = k.codeMismatch;
            return;
        }
        result.hidden = true;
        confirmEndorse(e, groupedCode(expected));
    } catch (err) {
        result.className = 'result bad';
        result.textContent = err instanceof RangeError ? t.passkeyCodeUnavailable : explain(err);
    }
}

function enrollmentCard(e) {
    const id = `code-${e.enrollment_id}`;
    const input = el('input', { id, inputmode: 'numeric', autocomplete: 'off', 'data-testid': 'endorse-code', maxlength: 14 });
    const result = el('p', { role: 'status', hidden: true, 'data-testid': 'endorse-check' });
    return el(
        'div',
        { class: 'card', 'data-testid': 'enrollment-item', 'data-person': e.display.person.name },
        facts([
            [k.person, e.display.person.name],
            [k.requestedAt, dateText(e.requested_at)],
        ]),
        e.actions.includes('endorse')
            ? [
                  el('label', { for: id }, k.codeLabel),
                  input,
                  result,
                  el('button', { class: 'primary wide', 'data-testid': 'endorse', onclick: () => checkCode(e, input, result) }, k.endorse),
              ]
            : null,
    );
}

export async function renderPasskeys(ctx) {
    const list = await api.call('passkey_enrollment_list');
    return [
        el('a', { href: '#' }, `← ${t.home}`),
        passkeyNotice(ctx.me),
        section('passkeys', k.title, el('p', { class: 'muted' }, k.hint), list.length ? list.map(enrollmentCard) : empty(k.empty)),
    ];
}
