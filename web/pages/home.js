// 首頁：依資料庫回傳的 capabilities 顯示區塊（待簽、待執行、新申請、我的申請、稽核）。
import { api } from '../api.js';
import { passkeyNotice } from '../decide.js';
import { t } from '../i18n.js';
import { packOf, packs } from '../packs/index.js';
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
        // 逾期還沒被處理（資料庫算好；排程或交付程式可能停擺，K-PROGRAM-STALLED）
        c.overdue
            ? el('span', { class: 'line bad-text', 'data-testid': 'overdue', 'data-kind': c.overdue.kind }, t.overdue.line(c.overdue))
            : null,
        // 等確認的站內待辦：剩幾個工作天、快到期（資料庫算好；不只靠郵件，K-CONFIRM-REMIND）
        c.confirm_due
            ? el(
                  'span',
                  {
                      class: c.confirm_due.reminding ? 'line warn-text' : 'line muted',
                      'data-testid': 'confirm-due',
                      'data-reminding': String(c.confirm_due.reminding),
                  },
                  t.confirmation.due(c.confirm_due),
              )
            : null,
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

/** 我的申請；等我確認驗證結果的單（依資料庫回傳的 actions）另外列在最上面（T7 從首頁算步數）。 */
async function fillMine() {
    const list = await api.call('case_list_mine');
    const confirms = list.filter((c) => c.actions.includes('confirm_verification'));
    return [
        confirms.length ? section('confirm', t.confirmInbox, await Promise.all(confirms.map((c) => caseCard(c, 'confirm-item')))) : null,
        section(
            'mine',
            t.mine,
            el('button', { class: 'primary wide', 'data-testid': 'new-case', onclick: () => go('#new') }, t.applyStart),
            list.length ? await Promise.all(list.map((c) => caseCard(c, 'mine-item'))) : empty(t.mineEmpty),
        ),
    ];
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

/** 背景程式的存活（K-PROGRAM-STALLED）：打開時資料庫檢查一次（開例外、結案），停擺的程式與沒人處理的逾期工作列成警示。 */
export async function programHealth() {
    const h = await api.call('program_health');
    const programs = h.programs.filter((p) => p.stalled);
    const overdue = h.overdue.filter((o) => o.stalled);
    const bad = programs.length + overdue.length > 0;
    return el(
        'div',
        { class: `result ${bad ? 'bad' : 'ok'}`, 'data-testid': 'program-health', 'data-status': bad ? 'bad' : 'ok' },
        el('p', {}, bad ? t.programHealth.bad : t.programHealth.ok),
        programs.length || overdue.length
            ? el('ul', {}, [
                  ...programs.map((p) => el('li', { 'data-program': p.code }, t.programHealth.program(p))),
                  ...overdue.map((o) => el('li', { 'data-work': o.kind }, t.programHealth.work(o))),
              ])
            : null,
    );
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
                          { 'data-rule': x.rule_code },
                          // 人員同步、角色來源、外部系統層級（對帳、清除）的例外不屬於任何一張單
                          x.case_no === null
                              ? (t.exceptionScope[x.rule_code] ?? t.exceptionNoCase)
                              : el('a', { href: `#audit/${x.case_no}` }, `${t.caseNo} ${x.case_no}`),
                          `・${t.exception[x.rule_code] ?? t.exceptionUnknown}`,
                          x.closed_at
                              ? el('span', { class: 'muted', 'data-testid': 'exception-closed' }, t.exceptionClosed(x.closed_at))
                              : null,
                      ),
                  ),
              ),
    );
}

export async function renderHome(ctx) {
    const can = (c) => ctx.me.capabilities.includes(c);
    const parts = [];
    // 停用中的通行金鑰：沒有待簽清單的人也要在首頁看到（待簽清單裡已經有同一個提示）
    // 別人背書、冷卻期內的新金鑰（K-PASSKEY-NOT-ME）：本人要在首頁就看到「不是我登記的」
    if (!can('inbox') && (ctx.me.passkey_suspended > 0 || ctx.me.passkey_disownable > 0))
        parts.push(Promise.resolve(passkeyNotice(ctx.me)));
    if (can('inbox')) parts.push(fillInbox(ctx));
    if (can('case.submit')) parts.push(fillMine());
    if (can('audit')) parts.push(programHealth(), Promise.resolve(auditSearch()), auditExceptions());
    // 通行金鑰：待核准的登記（我可以背書的，或我自己用舊金鑰核准的，依資料庫回傳的 actions）、等我背書恢復的停用；
    // 遺失裝置、停用或撤銷人人都要找得到
    const endorse = can('passkey.endorse') || ctx.me.passkey_pending.some((e) => e.actions.includes('endorse'));
    parts.push(
        api
            .call('passkey_suspension_list')
            .then((suspensions) =>
                section(
                    'passkey-endorse',
                    t.passkeys.title,
                    endorse ? el('a', { class: 'card', href: '#passkeys', 'data-testid': 'open-passkeys' }, t.passkeys.open) : null,
                    suspensions.some((r) => r.actions.includes('endorse_restore'))
                        ? el('a', { class: 'card', href: '#passkeys', 'data-testid': 'open-passkey-restore' }, t.passkeys.restoreOpen)
                        : null,
                    el('a', { href: '#passkeys', 'data-testid': 'open-passkey-manage' }, t.passkeys.manage),
                ),
            ),
    );
    // 流程包自己的待辦（例如資料擁有者要確認的目錄異動）：清單由資料庫決定，沒有就不顯示
    for (const pack of Object.values(packs)) if (pack.homeSection) parts.push(pack.homeSection());
    if (can('role_change'))
        parts.push(
            Promise.resolve(
                section(
                    'roles',
                    t.roleChange.title,
                    el('a', { class: 'card', href: '#roles', 'data-testid': 'open-roles' }, t.roleChange.open),
                ),
            ),
        );
    return (await Promise.all(parts)).flat();
}
