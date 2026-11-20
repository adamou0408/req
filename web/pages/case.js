// 申請單詳情（申請人、簽核人、系統管理人共用）。最上面是做決定需要的事實，完整內容在下方；
// 按鈕只依資料庫回傳的 actions：核准、退回、認領、標記已套用固定在底部，縮小後核准、駁回、撤回、修改在內文。
// 決定畫面的判斷內容（級別、例外、誰申請、給誰、哪些資料、多久、差異、重疊、使用情境、下一關）一律只從資料庫產生的
// 顯示摘要 c.display 畫出（裁決 D75），簽的也是它；不拿資料目錄或 case_get 的其他欄位來畫。
import { api } from '../api.js';
import { confirmDecision, confirmReduced, passkeyNotice } from '../decide.js';
import { t } from '../i18n.js';
import { packOf } from '../packs/index.js';
import { actionBar, dateText, el, explain, facts, flash, go, section, sheet, stateBadge, tierBadge } from '../ui.js';
import { versionDiff } from './diff.js';

const BAR_ACTIONS = ['claim', 'fulfil', 'return', 'approve'];
const BODY_ACTIONS = ['approve_reduced', 'reject', 'recall', 'revise'];
const REASON_ACTIONS = new Set(['return', 'reject', 'recall']);

function waitingText(c) {
    const stage = c.current_stage;
    if (!stage) return null;
    if (stage.status === 'halted') return el('span', { class: 'bad-text' }, t.halted(stage.name));
    const claim = c.stages.at(-1)?.tasks.some((x) => x.status === 'unclaimed');
    return `${stage.name}・${(claim ? t.waitingClaim : t.waitingOn)(c.waiting_on)}`;
}

function overlapFact(pack, overlap) {
    if (!overlap) return null;
    const cls = { none: 'ok-text', partial: 'warn-text', covered: 'bad-text' }[overlap.level] ?? 'warn-text';
    return el(
        'div',
        { 'data-testid': 'overlap', 'data-level': overlap.level, class: cls },
        t.overlapLevel[overlap.level] ?? t.overlapLevel.partial,
        overlap.reason ? el('div', {}, t.overlapReasonGiven(overlap.reason)) : null,
        el(
            'ul',
            {},
            (overlap.items ?? []).map((i) => el('li', {}, t.overlapItem(i, pack.overlapPackages(i.packages)))),
        ),
    );
}

/** 做決定需要的事實：誰申請、給誰、哪些資料、多久、與前一版的差異、重疊（全部來自顯示摘要 d）。 */
function decisionFacts(d, pack) {
    return el(
        'div',
        { class: 'card facts', 'data-testid': 'decision-facts' },
        facts([
            [t.applicant, d.applicant.name],
            [t.grantee, d.principal ? t.principalShown(d.principal) : '—'],
            [t.data, pack.scopeView(d.content)],
            [t.validity, el('span', { 'data-testid': 'validity' }, t.validRange(d.validity.from, d.validity.to))],
            [t.diff, versionDiff(d, pack)],
            [t.overlap, overlapFact(pack, d.overlap)],
        ]),
    );
}

/** 後果說明用到的名字與下一關，取自顯示摘要。 */
const consequenceOf = (c, decision) =>
    t.consequence[decision]({ applicant_name: c.display.applicant.name }, c.display.stage.next ?? t.nextAfterLast);

async function afterDecision(c, decision, result) {
    go('#', { text: `${t.caseNo} ${c.case_no}：${t.decided[decision]}`, ok: true });
    return result;
}

function decide(ctx, c, pack, decision, input = {}) {
    const consequence = consequenceOf(c, decision);
    confirmDecision(c, decision, {
        input,
        needsReason: REASON_ACTIONS.has(decision),
        // 退回：常見原因按一下就簽（T4 的步數）；也可以自己寫
        quickReasons: decision === 'return' ? (pack.returnReasons ?? []) : [],
        consequence,
        done: (r) => afterDecision(c, decision, r),
    });
}

async function claim(c) {
    try {
        await api.call('task_claim', { case_id: c.case_id });
        go(`#case/${c.case_id}`, { text: t.claimed(c.case_no), ok: true });
    } catch (err) {
        flash(explain(err));
    }
}

function reduceSheet(ctx, c, pack, cat) {
    const editor = pack.scopeEditor('r', cat, c.content, { limitTo: c.content });
    const from = el('input', { id: 'r-valid-from', type: 'date', value: c.terms.valid_from ?? '' });
    const to = el('input', { id: 'r-valid-to', type: 'date', value: c.terms.valid_to ?? '', 'data-testid': 'reduce-valid-to' });
    const panel = sheet(
        t.reduceTitle,
        el('p', {}, t.reduceHint),
        el(
            'div',
            { class: 'pair' },
            el('div', {}, el('label', { for: 'r-valid-from' }, t.validFrom), from),
            el('div', {}, el('label', { for: 'r-valid-to' }, t.validTo), to),
        ),
        editor.node,
        el(
            'div',
            { class: 'row sheet-buttons' },
            el('button', { onclick: () => panel.remove() }, t.cancel),
            el(
                'button',
                {
                    class: 'primary',
                    'data-testid': 'reduce-submit',
                    onclick: () => {
                        const terms = {
                            principal_id: c.terms.principal?.principal_id ?? null,
                            valid_from: from.value || null,
                            valid_to: to.value || null,
                        };
                        panel.remove();
                        // 先請資料庫整理縮小後的內容，確認面板顯示整理後的那一份（簽的就是它）
                        void confirmReduced(
                            c,
                            { content: editor.value(), terms },
                            {
                                consequence: consequenceOf(c, 'approve_reduced'),
                                view: (shown) =>
                                    el(
                                        'div',
                                        { class: 'card', 'data-testid': 'reduced-shown' },
                                        el('h3', {}, t.reducedShown),
                                        pack.scopeView(shown.content),
                                        el('p', {}, `${t.validity}：${t.validRange(shown.validity.from, shown.validity.to)}`),
                                    ),
                                done: (r) => afterDecision(c, 'approve_reduced', r),
                            },
                        );
                    },
                },
                t.reduceSubmit,
            ),
        ),
    );
}

function actionButton(ctx, c, pack, cat, action) {
    const handlers = {
        claim: () => claim(c),
        revise: () => go(`#edit/${c.case_id}`),
        approve_reduced: () => reduceSheet(ctx, c, pack, cat),
    };
    const onclick = handlers[action] ?? (() => decide(ctx, c, pack, action));
    return el(
        'button',
        { class: action === 'approve' || action === 'fulfil' || action === 'claim' ? 'primary' : '', 'data-action': action, onclick },
        t.action[action],
    );
}

function stagesView(c) {
    return el(
        'ol',
        { class: 'stages', 'data-testid': 'stages' },
        c.stages.map((s) =>
            el(
                'li',
                { 'data-stage': s.code, 'data-status': s.status },
                el('strong', {}, `${s.name}・${t.stageStatus[s.status] ?? s.status}`),
                el(
                    'ul',
                    {},
                    s.tasks.map((x) =>
                        el(
                            'li',
                            { 'data-task-status': x.status },
                            `${x.assignee_name ?? t.claimable}・${t.taskStatus[x.status] ?? x.status}`,
                            x.decided_version ? `（第 ${x.decided_version} 版）` : '',
                            x.closed_at ? `・${dateText(x.closed_at)}` : '',
                            x.reason ? el('div', { class: 'muted' }, x.reason) : null,
                        ),
                    ),
                ),
            ),
        ),
    );
}

function versionsView(c) {
    return el(
        'details',
        {},
        el('summary', {}, `${t.versionsTitle}（${c.versions.length}）`),
        el(
            'ol',
            { 'data-testid': 'versions' },
            c.versions.map((v) =>
                el(
                    'li',
                    { 'data-change': v.change_kind },
                    `第 ${v.version} 版・${t.changeKind[v.change_kind] ?? v.change_kind}・${v.created_by_name ?? '—'}・${dateText(v.created_at)}`,
                ),
            ),
        ),
    );
}

function fullContent(c, pack) {
    const d = c.display;
    return section(
        'full',
        t.fullContent,
        el('div', { class: 'card' }, pack.purposeView(d.content)),
        c.fulfilment
            ? section('rules', t.rulesTitle, el('div', { class: 'card' }, pack.fulfilmentView(d.content, c.fulfilment.payload)))
            : null,
        c.grant
            ? el(
                  'p',
                  { 'data-testid': 'grant', 'data-status': c.grant.status },
                  `${t.grantTitle}：${t.state[c.grant.status] ?? c.grant.status}・${t.validRange(c.grant.valid_from, c.grant.valid_to)}`,
              )
            : null,
        section('stages', t.stagesTitle, stagesView(c)),
        versionsView(c),
    );
}

/** 內容完全相同的其他進行中申請（D79 (6)）：提示並連到既有的那張。 */
function duplicatesNotice(c) {
    if (!c.duplicates.length) return null;
    return el(
        'div',
        { class: 'result warn', 'data-testid': 'duplicates' },
        el('p', {}, t.duplicates),
        el(
            'ul',
            {},
            c.duplicates.map((x) => el('li', {}, el('a', { href: `#case/${x.case_id}` }, `${t.caseNo} ${x.case_no}`))),
        ),
    );
}

export async function renderCase(ctx, caseId) {
    const c = await api.call('case_get', { case_id: caseId });
    const d = c.display;
    const pack = packOf(d.process.code);
    const cat = await pack.catalog();
    const needsProof = c.actions.some((a) => !['claim', 'revise', 'submit'].includes(a));
    return [
        el('a', { href: '#', class: 'back' }, `← ${t.home}`),
        el('h2', { 'data-testid': 'case-title' }, `${t.caseNo} ${d.case_no} `, tierBadge(d.tier?.name), ' ', stateBadge(c.state)),
        d.exceptions.length
            ? el(
                  'div',
                  { class: 'result warn', 'data-testid': 'case-exceptions' },
                  d.exceptions.map((x) => el('p', {}, t.exception[x.rule_code] ?? t.exceptionUnknown)),
              )
            : null,
        duplicatesNotice(c),
        needsProof ? passkeyNotice(ctx.me) : null,
        decisionFacts(d, pack),
        waitingText(c) ? el('p', { class: 'muted', 'data-testid': 'progress' }, `${t.progress}：`, waitingText(c)) : null,
        c.actions.some((a) => BODY_ACTIONS.includes(a))
            ? el(
                  'div',
                  { class: 'card', 'data-testid': 'other-actions' },
                  el('h3', {}, t.otherDecisions),
                  el(
                      'div',
                      { class: 'row' },
                      BODY_ACTIONS.filter((a) => c.actions.includes(a)).map((a) => actionButton(ctx, c, pack, cat, a)),
                  ),
              )
            : null,
        fullContent(c, pack),
        actionBar(BAR_ACTIONS.filter((a) => c.actions.includes(a)).map((a) => actionButton(ctx, c, pack, cat, a))),
    ];
}
