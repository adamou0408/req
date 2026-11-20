// 申請單詳情（申請人、簽核人、系統管理人共用）。最上面是做決定需要的事實，完整內容在下方；
// 按鈕只依資料庫回傳的 actions：核准、退回、認領、標記已套用固定在底部，縮小後核准、駁回、撤回、修改在內文。
import { api } from '../api.js';
import { confirmDecision, passkeyNotice } from '../decide.js';
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

function overlapFact(pack, cat, overlap) {
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
            (overlap.items ?? []).map((i) =>
                el('li', {}, t.overlapItem(i, i.packages.map((p) => pack.packagesLine(cat, { scope: [p] })).join('、'))),
            ),
        ),
    );
}

/** 做決定需要的事實：誰申請、給誰、哪些資料、多久、與前一版的差異、重疊。 */
function decisionFacts(ctx, c, pack, cat) {
    const p = c.terms.principal;
    return el(
        'div',
        { class: 'card facts', 'data-testid': 'decision-facts' },
        facts([
            [t.applicant, c.applicant_name],
            [t.grantee, p ? t.principalOption(p) : '—'],
            [t.data, pack.scopeView(cat, c.content)],
            [t.validity, el('span', { 'data-testid': 'validity' }, t.validRange(c.terms.valid_from, c.terms.valid_to))],
            [t.diff, versionDiff(c, pack, cat, ctx.me.name)],
            [t.overlap, overlapFact(pack, cat, c.overlap)],
            [t.progress, waitingText(c)],
        ]),
    );
}

function nextStageName(c) {
    const stages = c.stages;
    const index = stages.findIndex((s) => s.status === 'open');
    return stages[index + 1]?.name ?? t.nextAfterLast;
}

async function afterDecision(c, decision, result) {
    go('#', { text: `${t.caseNo} ${c.case_no}：${t.decided[decision]}`, ok: true });
    return result;
}

function decide(ctx, c, decision, input = {}) {
    const consequence = t.consequence[decision](c, nextStageName(c));
    confirmDecision(c, decision, {
        input,
        needsReason: REASON_ACTIONS.has(decision),
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
                        decide(ctx, c, 'approve_reduced', { content: editor.value(), terms });
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
    const onclick = handlers[action] ?? (() => decide(ctx, c, action));
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

function fullContent(c, pack, cat) {
    return section(
        'full',
        t.fullContent,
        el('div', { class: 'card' }, pack.purposeView(cat, c.content)),
        c.fulfilment ? section('rules', t.rulesTitle, el('div', { class: 'card' }, pack.fulfilmentView(cat, c.fulfilment.payload))) : null,
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

export async function renderCase(ctx, caseId) {
    const c = await api.call('case_get', { case_id: caseId });
    const pack = packOf(c.process_type);
    const cat = await pack.catalog();
    const needsProof = c.actions.some((a) => !['claim', 'revise', 'submit'].includes(a));
    return [
        el('a', { href: '#', class: 'back' }, `← ${t.home}`),
        el('h2', { 'data-testid': 'case-title' }, `${t.caseNo} ${c.case_no} `, tierBadge(c.tier), ' ', stateBadge(c.state)),
        c.exceptions.length
            ? el(
                  'div',
                  { class: 'result warn', 'data-testid': 'case-exceptions' },
                  c.exceptions.map((x) => el('p', {}, t.exception[x.rule_code] ?? t.exceptionUnknown)),
              )
            : null,
        needsProof ? passkeyNotice(ctx.me) : null,
        decisionFacts(ctx, c, pack, cat),
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
        fullContent(c, pack, cat),
        actionBar(BAR_ACTIONS.filter((a) => c.actions.includes(a)).map((a) => actionButton(ctx, c, pack, cat, a))),
    ];
}
