// 頁面。要顯示哪些區塊與按鈕，只依資料庫回傳的 capabilities 與 actions，不自己依狀態或角色推斷。
import { api, ApiFailure } from './api.js';
import { t } from './i18n.js';
import { verifyCase } from './verify.js';
import { createPasskey, signChallenge } from './webauthn.js';

const main = document.getElementById('main');
let me = null;

function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === 'onclick' || k === 'onsubmit') node[k] = v;
        else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : v);
    }
    node.append(...children.flat().filter((c) => c !== null && c !== undefined));
    return node;
}

function flash(text, ok = false) {
    const box = document.getElementById('flash');
    box.textContent = text;
    box.className = ok ? 'flash ok' : 'flash';
    box.hidden = !text;
}

function explain(err) {
    if (err instanceof ApiFailure) return err.message;
    if (err?.name === 'NotAllowedError' || err?.name === 'AbortError') return t.passkeyCancelled;
    console.error(err);
    return t.errorRetry;
}

const facts = (c) =>
    el(
        'dl',
        {},
        el('dt', {}, t.caseNo), el('dd', {}, String(c.case_no)),
        el('dt', {}, t.applicant), el('dd', {}, c.applicant_name),
        el('dt', {}, t.dataset), el('dd', {}, c.content.dataset),
        el('dt', {}, t.purpose), el('dd', {}, c.content.purpose),
        el('dt', {}, t.until), el('dd', {}, c.content.until),
        el('dt', {}, t.approver), el('dd', {}, c.approver_name ?? '—'),
    );

const stateBadge = (state) => el('span', { class: `badge state-${state}`, 'data-testid': 'state' }, t.state[state] ?? state);

// ── 簽核人 ──

async function renderInbox(section) {
    if (me.passkeys === 0) {
        section.append(
            el('div', { class: 'result warn', 'data-testid': 'passkey-missing' }, t.passkeyMissing),
            el('button', { class: 'primary', onclick: registerPasskey }, t.passkeyRegister),
        );
    }
    const list = await api.inboxList();
    if (list.length === 0) section.append(el('p', { class: 'muted', 'data-testid': 'inbox-empty' }, t.inboxEmpty));
    for (const c of list) {
        section.append(
            el(
                'button',
                { class: 'card', 'data-testid': 'inbox-item', 'data-case-no': c.case_no, onclick: () => renderDetail(c) },
                el('div', { class: 'row' }, el('strong', {}, `${t.caseNo} ${c.case_no}・${c.applicant_name}`), stateBadge(c.state)),
                el('div', {}, `${c.content.dataset}（${t.until} ${c.content.until}）`),
            ),
        );
    }
}

function renderDetail(c) {
    flash('');
    main.replaceChildren(
        el('button', { onclick: renderHome }, `← ${t.back}`),
        el('h2', {}, `${t.caseNo} ${c.case_no}`),
        el('div', { class: 'card' }, stateBadge(c.state), facts(c)),
        el(
            'div',
            { class: 'actions' },
            c.actions.map((a) =>
                el('button', { class: a === 'approve' ? 'primary' : '', 'data-action': a, onclick: () => confirmDecision(c, a) }, t.action[a]),
            ),
        ),
    );
}

async function confirmDecision(c, decision) {
    let challenge;
    try {
        challenge = await api.challengeIssue(c.case_id, decision);
    } catch (err) {
        flash(explain(err));
        return;
    }
    const b = challenge.binding;
    const sheet = el(
        'div',
        { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'confirm-title' },
        el(
            'div',
            {},
            el('h2', { id: 'confirm-title' }, t.confirmTitle[decision]),
            el('p', {}, t.consequence[decision](c)),
            el(
                'dl',
                { 'aria-label': t.binding },
                el('dt', {}, t.caseNo), el('dd', {}, String(b.case_no)),
                el('dt', {}, t.version), el('dd', {}, String(b.version)),
                el('dt', {}, t.contentHash), el('dd', { class: 'mono' }, b.content_sha256.slice(0, 16)),
            ),
            el(
                'div',
                { class: 'row sheet-buttons' },
                el('button', { onclick: () => sheet.remove() }, t.cancel),
                el('button', { class: 'primary', 'data-testid': 'confirm-passkey', onclick: () => decide(c, decision, challenge, sheet) }, t.confirmWithPasskey),
            ),
        ),
    );
    document.body.append(sheet);
    sheet.querySelector('[data-testid="confirm-passkey"]').focus();
}

async function decide(c, decision, challenge, sheet) {
    try {
        const assertion = await signChallenge(challenge.challenge);
        await api.caseDecidePasskey(challenge.challenge_id, decision, assertion);
        sheet.remove();
        await renderHome();
        flash(`${t.caseNo} ${c.case_no}：${t.decided[decision]}`, true);
    } catch (err) {
        sheet.remove();
        flash(explain(err));
    }
}

async function registerPasskey() {
    try {
        const begin = await api.passkeyRegisterBegin();
        const created = await createPasskey(me);
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

// ── 申請人 ──

function renderApply(section) {
    const nextQuarter = new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10);
    const form = el(
        'form',
        { class: 'card', 'data-testid': 'apply-form' },
        el('label', { for: 'f-dataset' }, t.dataset),
        el('input', { id: 'f-dataset', name: 'dataset', required: true }),
        el('label', { for: 'f-purpose' }, t.purpose),
        el('textarea', { id: 'f-purpose', name: 'purpose', rows: 3, required: true }),
        el('label', { for: 'f-until' }, t.until),
        el('input', { id: 'f-until', name: 'until', type: 'date', required: true, value: nextQuarter }),
        el('p', {}, el('button', { class: 'primary', type: 'submit' }, t.submit)),
    );
    form.onsubmit = async (event) => {
        event.preventDefault();
        const content = Object.fromEntries(new FormData(form));
        try {
            const created = await api.caseCreate(content);
            await api.caseSubmit(created.case_id);
            const mine = await api.caseListMine();
            await renderHome();
            flash(t.submitted(mine.find((c) => String(c.case_no) === String(created.case_no))), true);
        } catch (err) {
            flash(explain(err));
        }
    };
    section.append(form);
}

async function renderMine(section) {
    const list = await api.caseListMine();
    if (list.length === 0) section.append(el('p', { class: 'muted' }, t.mineEmpty));
    for (const c of list) {
        section.append(
            el(
                'div',
                { class: 'card', 'data-testid': 'mine-item', 'data-case-no': c.case_no },
                el('div', { class: 'row' }, el('strong', {}, `${t.caseNo} ${c.case_no}`), stateBadge(c.state)),
                el('div', {}, `${c.content.dataset}・${t.approver} ${c.approver_name ?? '—'}`),
                c.actions.filter((a) => t.action[a]).map((a) => el('button', { 'data-action': a, onclick: () => renderDetail(c) }, t.action[a])),
            ),
        );
    }
}

// ── 稽核 ──

function renderAuditSearch(section) {
    const form = el(
        'form',
        { class: 'card' },
        el('label', { for: 'f-case-no' }, t.auditCaseNo),
        el('input', { id: 'f-case-no', name: 'case_no', inputmode: 'numeric', required: true }),
        el('p', {}, el('button', { class: 'primary', type: 'submit' }, t.auditSearch)),
    );
    form.onsubmit = (event) => {
        event.preventDefault();
        void renderAudit(Number(new FormData(form).get('case_no')));
    };
    section.append(form);
}

async function renderAudit(caseNo) {
    flash('');
    const result = el('div', { class: 'result warn', 'data-testid': 'audit-result', 'data-status': 'pending' }, t.auditVerifying);
    const body = el('div');
    main.replaceChildren(el('button', { onclick: renderHome }, `← ${t.audit}`), el('h2', {}, `${t.caseNo} ${caseNo}`), result, body);
    try {
        const audit = await api.auditCase(caseNo);
        const v = await verifyCase(api, audit);
        const headline = { ok: t.auditOk, warn: t.auditOkUnanchored(v.unanchored), bad: t.auditBad }[v.status];
        result.className = `result ${v.status}`;
        result.dataset.status = v.status;
        result.replaceChildren(
            el('div', {}, headline),
            el('ul', { 'data-testid': 'audit-problems' }, v.problems.map((p) => el('li', {}, p))),
            el('details', {}, el('summary', {}, t.auditChecks), el('ul', {}, v.checks.map((c) => el('li', {}, c)))),
        );
        body.replaceChildren(
            el('button', { onclick: () => renderAudit(caseNo) }, t.auditVerifyAgain),
            el('div', { class: 'card' }, stateBadge(audit.case.state), facts(audit.case)),
            el('h2', {}, t.auditEvents),
            el(
                'ol',
                { class: 'events', 'data-testid': 'audit-events' },
                v.events.map((e) =>
                    el(
                        'li',
                        { 'data-type': e.parsed.type },
                        el('strong', {}, t.eventType[e.parsed.type] ?? e.parsed.type),
                        `・${e.actor_name ?? '—'}・${new Date(e.parsed.at).toLocaleString('zh-TW')}`,
                        e.parsed.data.proof_kind ? `・${t.proofKind[e.parsed.data.proof_kind]}` : '',
                        el('div', { class: 'mono muted' }, `#${e.seq} ${e.hash.slice(0, 16)}`),
                    ),
                ),
            ),
        );
    } catch (err) {
        result.className = 'result bad';
        result.dataset.status = 'error';
        result.textContent = explain(err);
    }
}

// ── 首頁 ──

async function renderHome() {
    const sections = [];
    const can = (c) => me.capabilities.includes(c);
    if (can('inbox')) sections.push([t.inbox, 'inbox', renderInbox]);
    if (can('case.submit')) sections.push([t.apply, 'apply', renderApply], [t.mine, 'mine', renderMine]);
    if (can('audit')) sections.push([t.audit, 'audit', renderAuditSearch]);
    const built = sections.map(([title, id, fill]) => {
        const section = el('section', { 'data-testid': `section-${id}`, 'aria-labelledby': `h-${id}` }, el('h2', { id: `h-${id}` }, title));
        return { section, fill };
    });
    await Promise.all(built.map(({ section, fill }) => fill(section)));
    main.replaceChildren(...built.map((b) => b.section));
}

function renderLogin() {
    main.replaceChildren(
        el('p', {}, t.loginHint),
        el('button', { class: 'primary', 'data-testid': 'login', onclick: () => (location.href = '/auth/login') }, t.login),
    );
}

async function boot() {
    const params = new URLSearchParams(location.search);
    if (params.get('notice') === 'PASSKEY_REGISTERED') flash(t.passkeyRegistered, true);
    if (params.get('error')) flash(t.error[params.get('error')] ?? t.errorRetry);
    if (params.size) history.replaceState(null, '', '/');
    try {
        me = await api.me();
    } catch (err) {
        if (err instanceof ApiFailure && err.status === 401) return renderLogin();
        main.replaceChildren(el('p', {}, explain(err)));
        return;
    }
    document.getElementById('who').replaceChildren(
        el('span', { 'data-testid': 'me' }, me.name),
        el('button', { onclick: async () => { await api.logout(); location.href = '/'; } }, t.logout),
    );
    await renderHome();
}

void boot();
