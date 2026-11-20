// 通行金鑰登記的核准（裁決 D65）：本人的主管或登記人，和本人當面或電話核對短碼後，用自己的通行金鑰背書；
// 本人已有生效的金鑰時，用舊金鑰核准自己的新金鑰。短碼由這個頁面從指紋自己算，挑戰值也由這個頁面算（D68）。
import { api } from '../api.js';
import { passkeyNotice } from '../decide.js';
import { t } from '../i18n.js';
import { shortCode, signingChallenge } from '../lib/signing.js';
import { dateText, el, empty, explain, facts, go, section, sheet } from '../ui.js';
import { signChallenge } from '../webauthn.js';

const k = t.passkeys;

async function endorseWithPasskey(e) {
    const nonce = await api.call('passkey_endorse_challenge', { enrollment_id: e.enrollment_id });
    const content = {
        person_id: e.person_id,
        person_name: e.person_name,
        credential_id: e.credential_id,
        public_key_sha256: e.public_key_sha256,
        short_code: shortCode(e.public_key_sha256),
    };
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

function confirmEndorse(e) {
    const error = el('p', { class: 'result bad', role: 'alert', hidden: true, 'data-testid': 'decision-error' });
    const panel = sheet(
        k.confirmTitle,
        el('p', { 'data-testid': 'consequence' }, k.consequence(e, shortCode(e.public_key_sha256))),
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

function enrollmentCard(e) {
    return el(
        'div',
        { class: 'card', 'data-testid': 'enrollment-item', 'data-person': e.person_name },
        facts([
            [k.person, e.person_name],
            [k.shortCode, el('span', { class: 'code', 'data-testid': 'endorse-short-code' }, shortCode(e.public_key_sha256))],
            [k.requestedAt, dateText(e.requested_at)],
        ]),
        e.actions.includes('endorse')
            ? el('button', { class: 'primary wide', 'data-testid': 'endorse', onclick: () => confirmEndorse(e) }, k.endorse)
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
