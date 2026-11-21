// 被授權者的負責人離職或停用（K-OWNER-CONTINUITY）：首頁區塊。
// 原負責人的主管或治理角色從資料庫給的候選人裡指定新負責人（不能選的人與原因也由資料庫給）；被指定的人看資料庫產生的顯示摘要，
// 用通行金鑰確認接下（挑戰值由這個頁面從同一份摘要算；裁決 D68、D75）。能做什麼只依資料庫回傳的 actions。
import { api } from '../api.js';
import { passkeyNotice } from '../decide.js';
import { t } from '../i18n.js';
import { signingChallenge } from '../lib/signing.js';
import { el, explain, facts, go, section, sheet } from '../ui.js';
import { signChallenge } from '../webauthn.js';

const o = t.ownerGap;

/** 用通行金鑰簽：挑戰值由這個頁面從面板上顯示的同一份摘要（ch.display）算。 */
async function acceptWithPasskey(gap, ch) {
    const toSign = await signingChallenge({
        purpose: 'principal.owner_accept',
        ref: gap.gap_id,
        content: ch.display,
        decision: 'accept',
        nonce: ch.nonce,
    });
    const a = await signChallenge(toSign);
    return api.call('principal_owner_accept_passkey', {
        challenge_id: ch.challenge_id,
        credential_id: a.credentialId,
        authenticator_data: a.authenticatorData,
        client_data_json: a.clientDataJSON,
        signature: a.signature,
    });
}

/** 確認接下的面板：先向資料庫取挑戰值與要簽的顯示摘要，面板只從這一份畫（簽的就是看到的）。 */
async function acceptSheet(gap) {
    let ch;
    try {
        ch = await api.call('principal_owner_challenge', { gap_id: gap.gap_id });
    } catch (err) {
        go('#', { text: explain(err), ok: false });
        return;
    }
    const h = ch.display;
    const error = el('p', { class: 'result bad', role: 'alert', hidden: true, 'data-testid': 'decision-error' });
    const panel = sheet(
        o.acceptTitle,
        el('p', { 'data-testid': 'consequence' }, o.acceptConsequence(h)),
        facts([
            [o.principal, `${h.principal.name}（${t.principalKind[h.principal.kind] ?? h.principal.kind}）`],
            [o.departed, h.departed.name],
            [o.newOwner, h.new_owner.name],
            [o.proposedBy, h.proposed_by.name],
            [o.reason, h.reason],
            [o.due, h.due],
        ]),
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
            await acceptWithPasskey(gap, ch);
            panel.remove();
            go('#', { text: o.accepted(h.principal.name), ok: true });
        } catch (err) {
            error.textContent = explain(err);
            error.hidden = false;
        }
    }
}

/** 指定新負責人的表單：候選人由資料庫給，不能選的人顯示原因（錯誤目錄的訊息）。 */
function proposeForm(gap, messages) {
    const id = `owner-${gap.gap_id}`;
    const form = el(
        'form',
        { 'data-testid': 'owner-propose' },
        el('label', { for: `${id}-who` }, o.newOwner),
        el(
            'select',
            { id: `${id}-who`, name: 'new_owner', required: true, 'data-testid': 'owner-candidate' },
            el('option', { value: '' }, o.choose),
            gap.candidates.map((c) =>
                el(
                    'option',
                    { value: c.person.id, disabled: c.problem !== null },
                    c.problem ? `${c.person.name}（${messages[c.problem] ?? c.problem}）` : c.person.name,
                ),
            ),
        ),
        el('label', { for: `${id}-reason` }, o.reasonLabel),
        el('textarea', { id: `${id}-reason`, name: 'reason', rows: 2, required: true, 'data-testid': 'owner-reason' }),
        el('p', {}, el('button', { class: 'primary wide', type: 'submit', 'data-testid': 'owner-propose-submit' }, o.propose)),
    );
    form.onsubmit = async (event) => {
        event.preventDefault();
        const data = new FormData(form);
        try {
            await api.call('principal_owner_propose', { gap_id: gap.gap_id, new_owner: data.get('new_owner'), reason: data.get('reason') });
            go('#', { text: o.proposed, ok: true });
        } catch (err) {
            go('#', { text: explain(err), ok: false });
        }
    };
    return form;
}

function gapCard(gap, messages) {
    return el(
        'div',
        { class: 'card', 'data-testid': 'owner-gap', 'data-gap': gap.gap_id },
        el('strong', {}, o.title(gap)),
        facts([
            [o.due, gap.due_text],
            [o.cases, o.casesText(gap)],
            [o.handover, gap.handover ? o.waiting(gap.handover) : null],
        ]),
        el('p', { class: 'muted' }, o.consequence),
        gap.actions.includes('reassign') ? proposeForm(gap, messages) : null,
        gap.actions.includes('accept')
            ? el('button', { class: 'primary wide', 'data-testid': 'owner-accept', onclick: () => acceptSheet(gap) }, o.accept)
            : null,
    );
}

export async function ownerSection(ctx) {
    const [gaps, messages] = await Promise.all([api.call('principal_owner_gaps'), api.messages()]);
    return section(
        'owner-gaps',
        o.section,
        // 確認接下要用通行金鑰：沒有可用的金鑰時在這裡就提示登記
        gaps.some((g) => g.actions.includes('accept')) ? passkeyNotice(ctx.me) : null,
        gaps.map((g) => gapCard(g, messages)),
    );
}
