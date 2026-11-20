// 角色指派變更（控制、平台、治理類角色只能走這裡；不能由人員同步帶入）：提出、核准、冷卻期內擋下，都要通行金鑰。
// 挑戰值由這個頁面從畫面上顯示的內容自己算（裁決 D68）。能提出哪些角色、能做什麼，只依資料庫回傳的 options 與每張變更的 actions。
import { api } from '../api.js';
import { passkeyNotice } from '../decide.js';
import { t } from '../i18n.js';
import { signingChallenge } from '../lib/signing.js';
import { el, empty, explain, facts, go, section, sheet, dateText } from '../ui.js';
import { signChallenge } from '../webauthn.js';

const r = t.roleChange;

/** 要簽的內容：畫面上顯示的被指派人（id 與名字）、角色（代碼與名稱）、範圍、授予或撤除、原因。 */
const shownContent = (q) => ({
    holder_id: q.holder_id,
    holder_name: q.holder_name,
    role_code: q.role_code,
    role_name: q.role_name,
    scope_ref: q.scope_ref,
    change: q.change,
    reason: q.reason,
});

const assertionBody = (a) => ({
    credential_id: a.credentialId,
    authenticator_data: a.authenticatorData,
    client_data_json: a.clientDataJSON,
    signature: a.signature,
});

async function decideWithPasskey(request, decision) {
    const nonce = await api.call('role_change_challenge', { request_id: request.request_id, decision });
    const toSign = await signingChallenge({
        purpose: 'role_change.decision',
        ref: request.request_id,
        content: shownContent(request),
        decision,
        nonce: nonce.nonce,
    });
    const assertion = await signChallenge(toSign);
    return api.call('role_change_decide_passkey', { challenge_id: nonce.challenge_id, decision, ...assertionBody(assertion) });
}

async function proposeWithPasskey(q) {
    const nonce = await api.call('role_change_propose_challenge', {
        holder_id: q.holder_id,
        role_code: q.role_code,
        scope_ref: q.scope_ref,
        change: q.change,
        reason: q.reason,
    });
    const toSign = await signingChallenge({
        purpose: 'role_change.propose',
        ref: 'new',
        content: shownContent(q),
        decision: 'propose',
        nonce: nonce.nonce,
    });
    return api.call('role_change_propose_passkey', { challenge_id: nonce.challenge_id, ...assertionBody(await signChallenge(toSign)) });
}

/** 確認面板：內容寫清楚，按下後用通行金鑰簽。 */
function confirmSheet(title, consequence, action, okText) {
    const error = el('p', { class: 'result bad', role: 'alert', hidden: true, 'data-testid': 'decision-error' });
    const panel = sheet(
        title,
        el('p', { 'data-testid': 'consequence' }, consequence),
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
            await action();
            panel.remove();
            go('#roles', { text: okText, ok: true });
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
            [r.scope, request.scope_ref ?? r.scopeAll],
            [r.reason, request.reason],
            [r.proposedBy, `${request.proposed_by_name}・${dateText(request.proposed_at)}`],
            [r.status, r.statusName[request.status] ?? request.status],
            [r.approvedBy, request.approved_by_name ? `${request.approved_by_name}・${dateText(request.approved_at)}` : null],
            [r.effectiveAt, request.effective_at ? dateText(request.effective_at) : null],
            [r.blockedBy, request.blocked_by_name],
        ]),
        request.actions.includes('approve')
            ? el(
                  'button',
                  {
                      class: 'primary wide',
                      'data-testid': 'role-change-approve',
                      onclick: () =>
                          confirmSheet(r.confirmTitle, r.consequence(request), () => decideWithPasskey(request, 'approve'), r.approved),
                  },
                  r.approve,
              )
            : null,
        request.actions.includes('block')
            ? el(
                  'button',
                  {
                      class: 'wide',
                      'data-testid': 'role-change-block',
                      onclick: () =>
                          confirmSheet(
                              r.confirmBlockTitle,
                              r.blockConsequence(request),
                              () => decideWithPasskey(request, 'block'),
                              r.blocked,
                          ),
                  },
                  r.block,
              )
            : null,
    );
}

function proposeForm(options) {
    // 範圍可以不選（＝不限範圍），所以只有其他欄位是必填
    const select = (id, items, required = true) =>
        el(
            'select',
            { id, name: id, required },
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
        el('label', { for: 'scope_ref' }, r.scope),
        select('scope_ref', [['', r.scopeAll], ...options.scopes.map((x) => [x.scope_ref, `${x.label}（${x.scope_ref}）`])], false),
        el('label', { for: 'change' }, r.change),
        select('change', [
            ['grant', r.changeName.grant],
            ['revoke', r.changeName.revoke],
        ]),
        el('label', { for: 'reason' }, r.reasonLabel),
        el('textarea', { id: 'reason', name: 'reason', rows: 3, required: true }),
        el('p', {}, el('button', { class: 'primary', type: 'submit', 'data-testid': 'role-change-submit' }, r.submit)),
    );
    form.onsubmit = (event) => {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(form));
        // 畫面上選的人名與角色名（要簽的就是這些；後端換掉對應關係，簽章就對不上）
        const q = {
            holder_id: data.holder_id,
            holder_name: form.holder_id.selectedOptions[0].textContent,
            role_code: data.role_code,
            role_name: options.roles.find((x) => x.code === data.role_code)?.name,
            scope_ref: data.scope_ref || null,
            change: data.change,
            reason: data.reason,
        };
        confirmSheet(r.confirmProposeTitle, r.proposeConsequence(q), () => proposeWithPasskey(q), r.proposed);
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
