// 角色指派變更（控制、平台、治理類角色只能走這裡；不能由人員同步帶入）：提出，或以通行金鑰核准別人提出的變更。
// 能提出哪些角色、能不能核准，只依資料庫回傳的 options 與每張變更的 actions。
import { api } from '../api.js';
import { passkeyNotice } from '../decide.js';
import { t } from '../i18n.js';
import { el, empty, explain, facts, go, section, sheet, dateText } from '../ui.js';
import { signChallenge } from '../webauthn.js';

const r = t.roleChange;

async function approveWithPasskey(request) {
    const challenge = await api.call('role_change_challenge', { request_id: request.request_id });
    const assertion = await signChallenge(challenge.challenge);
    return api.call('role_change_approve_passkey', {
        challenge_id: challenge.challenge_id,
        credential_id: assertion.credentialId,
        authenticator_data: assertion.authenticatorData,
        client_data_json: assertion.clientDataJSON,
        signature: assertion.signature,
    });
}

function confirmApprove(request) {
    const error = el('p', { class: 'result bad', role: 'alert', hidden: true, 'data-testid': 'decision-error' });
    const panel = sheet(
        r.confirmTitle,
        el('p', { 'data-testid': 'consequence' }, r.consequence(request)),
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
            await approveWithPasskey(request);
            panel.remove();
            go('#roles', { text: r.approved, ok: true });
        } catch (err) {
            error.textContent = explain(err);
            error.hidden = false;
        }
    }
}

function requestCard(request) {
    return el(
        'div',
        { class: 'card', 'data-testid': 'role-change-item', 'data-status': request.status },
        el('strong', {}, r.summary(request, r.changeName[request.change])),
        facts([
            [r.reason, request.reason],
            [r.proposedBy, `${request.proposed_by_name}・${dateText(request.proposed_at)}`],
            [r.status, r.statusName[request.status] ?? request.status],
            [r.approvedBy, request.approved_by_name ? `${request.approved_by_name}・${dateText(request.approved_at)}` : null],
        ]),
        request.actions.includes('approve')
            ? el(
                  'button',
                  { class: 'primary wide', 'data-testid': 'role-change-approve', onclick: () => confirmApprove(request) },
                  r.approve,
              )
            : null,
    );
}

function proposeForm(options) {
    const select = (id, items) =>
        el(
            'select',
            { id, name: id, required: true },
            items.map(([value, label]) => el('option', { value }, label)),
        );
    const form = el(
        'form',
        { class: 'card', 'data-testid': 'role-change-form' },
        el('label', { for: 'holder_id' }, r.holder),
        select(
            'holder_id',
            options.people.map((p) => [p.person_id, p.name]),
        ),
        el('label', { for: 'role_code' }, r.role),
        select(
            'role_code',
            options.roles.map((x) => [x.code, `${x.name}（${x.code}）`]),
        ),
        el('label', { for: 'change' }, r.change),
        select('change', [
            ['grant', r.changeName.grant],
            ['revoke', r.changeName.revoke],
        ]),
        el('label', { for: 'reason' }, r.reasonLabel),
        el('textarea', { id: 'reason', name: 'reason', rows: 3, required: true }),
        el('p', {}, el('button', { class: 'primary', type: 'submit', 'data-testid': 'role-change-submit' }, r.submit)),
    );
    form.onsubmit = async (event) => {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(form));
        try {
            await api.call('role_change_propose', { ...data, scope_ref: null });
            go('#roles', { text: r.proposed, ok: true });
        } catch (err) {
            go('#roles', { text: explain(err), ok: false });
        }
    };
    return section('role-change-new', r.newTitle, el('p', { class: 'muted' }, r.newHint), form);
}

export async function renderRoles(ctx) {
    const [options, list] = await Promise.all([api.call('role_change_options'), api.call('role_change_list')]);
    return [
        el('a', { href: '#' }, `← ${t.home}`),
        passkeyNotice(ctx.me),
        section('role-changes', r.title, list.length ? list.map(requestCard) : empty(r.empty)),
        options.roles.length ? proposeForm(options) : null,
    ];
}
