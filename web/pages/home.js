// 首頁：依資料庫回傳的 capabilities 顯示區塊（待簽、待執行、新申請、我的申請、稽核）。
import { api } from '../api.js';
import { passkeyNotice } from '../decide.js';
import { t } from '../i18n.js';
import { packOf } from '../packs/index.js';
import { el, empty, go, section, stateBadge, tierBadge } from '../ui.js';

/** 清單卡片：單號、申請人、哪些資料、期間、等誰。點了進詳情。 */
async function caseCard(c, testid) {
    const pack = packOf(c.process_type);
    const cat = pack ? await pack.catalog() : null;
    const stage = c.current_stage;
    const waiting = c.actions.includes('claim') ? t.claimable : c.waiting_on.length ? t.waitingOn(c.waiting_on) : null;
    return el(
        'a',
        { class: 'card', href: `#case/${c.case_id}`, 'data-testid': testid, 'data-case-no': c.case_no },
        el(
            'span',
            { class: 'row' },
            el('strong', {}, `${t.caseNo} ${c.case_no}・${c.applicant_name}`),
            el('span', {}, tierBadge(c.tier), ' ', stateBadge(c.state)),
        ),
        el('span', { class: 'line' }, cat ? pack.packagesLine(cat, c.content) : c.process_type),
        el('span', { class: 'line muted' }, `${c.terms.principal?.name ?? '—'}・${t.validRange(c.terms.valid_from, c.terms.valid_to)}`),
        stage ? el('span', { class: 'line muted' }, `${stage.name}${waiting ? `・${waiting}` : ''}`) : null,
    );
}

async function fillInbox(ctx) {
    const list = await api.call('inbox_list');
    const approvals = list.filter((c) => c.current_stage?.phase !== 'fulfilment');
    const fulfils = list.filter((c) => c.current_stage?.phase === 'fulfilment');
    const out = [];
    const notice = passkeyNotice(ctx.me);
    if (notice) out.push(notice);
    out.push(
        section(
            'inbox',
            t.inbox,
            approvals.length ? await Promise.all(approvals.map((c) => caseCard(c, 'inbox-item'))) : empty(t.inboxEmpty),
        ),
    );
    if (fulfils.length) out.push(section('fulfil', t.fulfilInbox, await Promise.all(fulfils.map((c) => caseCard(c, 'fulfil-item')))));
    return out;
}

async function fillMine() {
    const list = await api.call('case_list_mine');
    return section(
        'mine',
        t.mine,
        el('button', { class: 'primary wide', 'data-testid': 'new-case', onclick: () => go('#new') }, t.applyStart),
        list.length ? await Promise.all(list.map((c) => caseCard(c, 'mine-item'))) : empty(t.mineEmpty),
    );
}

function auditSearch() {
    const form = el(
        'form',
        { class: 'card' },
        el('label', { for: 'f-case-no' }, t.auditCaseNo),
        el('input', { id: 'f-case-no', name: 'case_no', inputmode: 'numeric', required: true }),
        el('p', {}, el('button', { class: 'primary', type: 'submit' }, t.auditSearch)),
    );
    form.onsubmit = (event) => {
        event.preventDefault();
        go(`#audit/${Number(new FormData(form).get('case_no'))}`);
    };
    return section('audit', t.audit, form);
}

async function auditExceptions() {
    const list = await api.call('audit_exceptions');
    return section(
        'exceptions',
        t.exceptions,
        list.length === 0
            ? empty(t.exceptionsEmpty)
            : el(
                  'ul',
                  { 'data-testid': 'audit-exceptions' },
                  list.map((x) =>
                      el(
                          'li',
                          {},
                          el('a', { href: `#audit/${x.case_no}` }, `${t.caseNo} ${x.case_no}`),
                          `・${t.exception[x.rule_code] ?? t.exceptionUnknown}`,
                      ),
                  ),
              ),
    );
}

export async function renderHome(ctx) {
    const can = (c) => ctx.me.capabilities.includes(c);
    const parts = [];
    if (can('inbox')) parts.push(fillInbox(ctx));
    if (can('case.submit')) parts.push(fillMine());
    if (can('audit')) parts.push(Promise.resolve(auditSearch()), auditExceptions());
    return (await Promise.all(parts)).flat();
}
