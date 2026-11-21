// 申請單詳情（申請人、簽核人、系統管理人共用）。最上面是做決定需要的事實，完整內容在下方；
// 按鈕只依資料庫回傳的 actions：核准、退回、認領、標記已套用、確認驗證結果固定在底部，
// 縮小後核准、駁回、撤回、修改、撤銷、縮小、驗證結果不對在內文。
// 標記已套用（人工退路）只在執行關有人工工作時出現；系統對系統的交付與驗證顯示在「交付與驗證」。
// 等申請人確認驗證結果（K-CONFIRM）時，每項自動驗證的結果與剩餘工作天放在最上面（T7）；剩幾天由資料庫算。
// 決定畫面的判斷內容（級別、例外、誰申請、給誰、哪些資料、多久、差異、重疊、使用情境、下一關）一律只從資料庫產生的
// 顯示摘要 c.display 畫出（裁決 D75），簽的也是它；不拿資料目錄或 case_get 的其他欄位來畫。
import { api } from '../api.js';
import { confirmDecision, confirmReduced, passkeyNotice } from '../decide.js';
import { t } from '../i18n.js';
import { packOf } from '../packs/index.js';
import { actionBar, dateText, el, explain, facts, flash, go, section, sheet, stateBadge, tierBadge } from '../ui.js';
import { versionDiff } from './diff.js';

const BAR_ACTIONS = ['claim', 'fulfil', 'return', 'approve', 'confirm_verification'];
const BODY_ACTIONS = ['approve_reduced', 'reject', 'recall', 'revise', 'reduce', 'dispute_verification', 'revoke', 'discard'];
/**
 * 不需要通行金鑰的動作：撤銷、縮小不用簽核，但要原因（裁決 D63，自動送到外部系統）；
 * 確認驗證結果不是簽核決定（K-CONFIRM），回報不對要原因。
 */
const NO_PROOF_ACTIONS = ['claim', 'revise', 'submit', 'revoke', 'reduce', 'confirm_verification', 'dispute_verification', 'discard'];
const REASON_ACTIONS = new Set(['return', 'reject', 'recall']);
const PRIMARY_ACTIONS = new Set(['approve', 'fulfil', 'claim', 'confirm_verification']);

function waitingText(c) {
    const stage = c.current_stage;
    if (!stage) return null;
    if (stage.status === 'halted') return el('span', { class: 'bad-text' }, t.halted(stage.name));
    // 系統對系統的執行關沒有人工工作：進度看交付與驗證
    if (stage.phase === 'fulfilment' && c.stages.at(-1)?.tasks.length === 0) return `${stage.name}・${t.autoDelivery[c.state] ?? ''}`;
    const claim = c.stages.at(-1)?.tasks.some((x) => x.status === 'unclaimed');
    return `${stage.name}・${(claim ? t.waitingClaim : t.waitingOn)(c.waiting_on)}`;
}

/** 目前這關的期限、是否逾期與升級（資料庫算好；K-SLA-VIEW）。 */
function slaView(c) {
    if (!c.sla) return null;
    return el(
        'div',
        {
            class: `result ${c.sla.overdue || c.sla.escalated ? 'warn' : 'ok'}`,
            'data-testid': 'sla',
            'data-overdue': String(c.sla.overdue),
            'data-escalated': String(c.sla.escalated),
        },
        el('p', {}, t.sla.box(c.sla)),
        c.sla.overdue ? el('p', {}, t.sla.overdue) : null,
        c.sla.escalated ? el('p', {}, t.sla.escalated(c.sla.escalated_to)) : null,
    );
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

/** 縮小的輸入（授權起迄、只列目前已有的資料範圍）：簽核人的縮小後核准與生效後的縮小共用。 */
function reduceInputs(c, pack, cat) {
    const editor = pack.scopeEditor('r', cat, c.content, { limitTo: c.content });
    const from = el('input', { id: 'r-valid-from', type: 'date', value: c.terms.valid_from ?? '' });
    const to = el('input', { id: 'r-valid-to', type: 'date', value: c.terms.valid_to ?? '', 'data-testid': 'reduce-valid-to' });
    return {
        nodes: [
            el(
                'div',
                { class: 'pair' },
                el('div', {}, el('label', { for: 'r-valid-from' }, t.validFrom), from),
                el('div', {}, el('label', { for: 'r-valid-to' }, t.validTo), to),
            ),
            editor.node,
        ],
        value: () => ({
            content: editor.value(),
            terms: { principal_id: c.terms.principal?.principal_id ?? null, valid_from: from.value || null, valid_to: to.value || null },
        }),
    };
}

function reduceSheet(ctx, c, pack, cat) {
    const inputs = reduceInputs(c, pack, cat);
    const panel = sheet(
        t.reduceTitle,
        el('p', {}, t.reduceHint),
        inputs.nodes,
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
                        const reduced = inputs.value();
                        panel.remove();
                        // 先請資料庫整理縮小後的內容，確認面板顯示整理後的那一份（簽的就是它）
                        void confirmReduced(c, reduced, {
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
                        });
                    },
                },
                t.reduceSubmit,
            ),
        ),
    );
}

/** 原因欄位的說明：原因會讓誰看到，依資料庫回傳的代碼（操作者是不是申請人、被授權者負責人由資料庫判斷；K-REASON-AUDIENCE）。 */
const reasonLabel = (c, action) => t.reasonFor[c.reason_audience?.[action]] ?? t.reasonLabel;

/** 捨棄從沒送審過的草稿（K-CASE-DISCARD）：說明後果再確認一次；不用通行金鑰。 */
export function discardSheet(c, after = () => go('#', { text: t.discard.done(c.case_no), ok: true })) {
    const submit = async () => {
        try {
            await api.call('case_discard', { case_id: c.case_id });
            panel.remove();
            after();
        } catch (err) {
            flash(explain(err));
        }
    };
    const panel = sheet(
        t.discard.title,
        el('p', {}, t.discard.hint),
        el(
            'div',
            { class: 'row sheet-buttons' },
            el('button', { onclick: () => panel.remove() }, t.cancel),
            el('button', { class: 'primary', 'data-testid': 'discard-submit', onclick: submit }, t.discard.confirm),
        ),
    );
}

/** 撤銷生效中的授權：不用簽核、要原因；外部系統上的權限由平台自動撤回。 */
function revokeSheet(c) {
    const reason = el('textarea', { id: 'revoke-reason', rows: 3, 'data-testid': 'revoke-reason' });
    const submit = async () => {
        try {
            await api.call('case_revoke', { case_id: c.case_id, reason: reason.value });
            panel.remove();
            go(`#case/${c.case_id}`, { text: t.revokedNotice(c.case_no), ok: true });
        } catch (err) {
            flash(explain(err));
        }
    };
    const panel = sheet(
        t.revokeTitle,
        el('p', {}, t.revokeHint),
        el('label', { for: 'revoke-reason' }, reasonLabel(c, 'revoke')),
        reason,
        el(
            'div',
            { class: 'row sheet-buttons' },
            el('button', { onclick: () => panel.remove() }, t.cancel),
            el('button', { class: 'primary', 'data-testid': 'revoke-submit', onclick: submit }, t.action.revoke),
        ),
    );
}

/** 生效中的授權只做縮小（不用簽核、要原因）：能不能縮小、是不是真的縮小，都由資料庫判斷。 */
function reduceActiveSheet(c, pack, cat) {
    const inputs = reduceInputs(c, pack, cat);
    const reason = el('textarea', { id: 'reduce-reason', rows: 2, 'data-testid': 'reduce-reason' });
    const submit = async () => {
        try {
            await api.call('case_reduce', { case_id: c.case_id, ...inputs.value(), reason: reason.value });
            panel.remove();
            go(`#case/${c.case_id}`, { text: t.reduceActive.done(c.case_no), ok: true });
        } catch (err) {
            flash(explain(err));
        }
    };
    const panel = sheet(
        t.reduceActive.title,
        el('p', {}, t.reduceActive.hint),
        inputs.nodes,
        el('label', { for: 'reduce-reason' }, reasonLabel(c, 'reduce')),
        reason,
        el(
            'div',
            { class: 'row sheet-buttons' },
            el('button', { onclick: () => panel.remove() }, t.cancel),
            el('button', { class: 'primary', 'data-testid': 'reduce-active-submit', onclick: submit }, t.action.reduce),
        ),
    );
}

/** 確認驗證結果（K-CONFIRM）：說明後果再確認一次；不是簽核決定，不用通行金鑰。 */
function confirmSheet(c) {
    const submit = async () => {
        try {
            await api.call('case_confirm_verification', { case_id: c.case_id });
            panel.remove();
            go(`#case/${c.case_id}`, { text: t.confirmation.confirmed(c.case_no), ok: true });
        } catch (err) {
            flash(explain(err));
        }
    };
    const panel = sheet(
        t.confirmation.confirmTitle,
        el('p', {}, t.confirmation.confirmHint),
        el(
            'div',
            { class: 'row sheet-buttons' },
            el('button', { onclick: () => panel.remove() }, t.cancel),
            el('button', { class: 'primary', 'data-testid': 'confirm-verification-submit', onclick: submit }, t.confirmation.confirmSubmit),
        ),
    );
}

/** 驗證結果不對（K-CONFIRM-DISPUTE）：要寫哪裡不對；不生效、撤回、開例外並通知。 */
function disputeSheet(c) {
    const reason = el('textarea', { id: 'dispute-reason', rows: 3, 'data-testid': 'dispute-reason' });
    const submit = async () => {
        try {
            await api.call('case_dispute_verification', { case_id: c.case_id, reason: reason.value });
            panel.remove();
            go(`#case/${c.case_id}`, { text: t.confirmation.disputed(c.case_no), ok: true });
        } catch (err) {
            flash(explain(err));
        }
    };
    const panel = sheet(
        t.confirmation.disputeTitle,
        el('p', {}, t.confirmation.disputeHint),
        el('label', { for: 'dispute-reason' }, t.confirmation.disputeReason),
        reason,
        el(
            'div',
            { class: 'row sheet-buttons' },
            el('button', { onclick: () => panel.remove() }, t.cancel),
            el('button', { class: 'primary', 'data-testid': 'dispute-submit', onclick: submit }, t.action.dispute_verification),
        ),
    );
}

const caseMark = (x) => (x.match === null ? '…' : x.match ? '✓' : '✗');

const verificationItem = (x) =>
    el(
        'li',
        { 'data-code': x.code, 'data-match': String(x.match) },
        el('span', { class: x.match === false ? 'bad-text' : 'ok-text' }, caseMark(x)),
        ` ${x.description}`,
        el('div', { class: 'muted' }, t.verificationCase(x.expected, x.actual)),
    );

/**
 * 等申請人確認驗證結果（T7：第一個畫面就看到每項測試的結果與剩餘天數）。只畫資料庫回傳的確認與這一版通過的驗證；
 * 確認結束之後只留一行結果。
 */
function confirmationPanel(c) {
    const conf = c.confirmation;
    if (!conf) return null;
    if (conf.status !== 'pending')
        return el(
            'p',
            { class: 'muted', 'data-testid': 'confirmation', 'data-status': conf.status },
            t.confirmation.closed[conf.status](conf),
        );
    const cases = c.delivery.verifications.filter((r) => r.version === conf.version && r.status === 'passed').flatMap((r) => r.cases);
    return el(
        'div',
        { class: 'card', 'data-testid': 'confirmation', 'data-status': conf.status },
        el('h3', {}, t.confirmation.title),
        el('p', { class: 'warn-text', 'data-testid': 'confirmation-due' }, t.confirmation.left(conf.workdays_left, conf.due_text)),
        // 人工執行的單沒有自動驗證（K-CONFIRM-MANUAL）：確認是唯一的驗證
        cases.length ? el('ul', { class: 'delivery-list', 'data-testid': 'confirmation-cases' }, cases.map(verificationItem)) : null,
        el(
            'p',
            { class: 'muted', 'data-testid': cases.length ? 'confirmation-hint' : 'confirmation-manual' },
            cases.length ? t.confirmation.hint : t.confirmation.manualHint,
        ),
    );
}

function verificationView(r) {
    return el(
        'div',
        { 'data-testid': 'verification', 'data-status': r.status },
        el('h3', {}, t.verificationHead(r.version, t.verificationStatus[r.status] ?? r.status)),
        el('ul', { class: 'delivery-list' }, r.cases.map(verificationItem)),
        // 使用方系統宣告做不到的限制：沒有驗證（K-VERIFY-SKIPPED），照實列出
        r.skipped.length
            ? el(
                  'ul',
                  { class: 'delivery-list', 'data-testid': 'verification-skipped' },
                  r.skipped.map((x) =>
                      el(
                          'li',
                          { 'data-code': x.code },
                          el('span', { class: 'warn-text' }, '—'),
                          ` ${x.description}`,
                          el('div', { class: 'muted' }, `${t.verificationSkipped}：${x.reason}`),
                      ),
                  ),
              )
            : null,
    );
}

/** 使用情形（D92 (4)：使用方系統回報的批次摘要，資料庫算好最後使用時間與近幾天的次數）。生效過的單才顯示。 */
function usageView(c) {
    if (!c.grant) return null;
    const u = c.usage;
    return section(
        'usage',
        t.usage.title,
        el(
            'div',
            { class: 'card', 'data-testid': 'usage' },
            u
                ? [el('p', {}, t.usage.last(u.last_used_text)), el('p', { class: 'muted' }, t.usage.recent(u))]
                : el('p', { class: 'muted' }, t.usage.none),
        ),
    );
}

/** 核准之後的交付與驗證（裁決 D63）：每一筆送到外部系統的動作、每一輪自動驗證的案例與結果。 */
function deliveryView(c) {
    const { ops, verifications } = c.delivery;
    if (ops.length === 0) return null;
    return section(
        'delivery',
        t.deliveryTitle,
        el(
            'div',
            { class: 'card', 'data-testid': 'delivery' },
            el(
                'ol',
                { class: 'delivery-list' },
                ops.map((o) =>
                    el(
                        'li',
                        { 'data-kind': o.kind, 'data-status': o.status },
                        el('strong', {}, `${t.deliveryKind[o.kind] ?? o.kind}・${t.deliveryStatus[o.status] ?? o.status}`),
                        el('div', { class: 'muted' }, t.deliveryLine(o.attempts, dateText(o.finished_at ?? o.created_at))),
                        o.next_attempt_at ? el('div', { class: 'muted' }, t.deliveryRetryAt(dateText(o.next_attempt_at))) : null,
                        o.last_error && o.status !== 'done' ? el('div', { class: 'muted' }, o.last_error) : null,
                    ),
                ),
            ),
            verifications.map(verificationView),
        ),
    );
}

function actionButton(ctx, c, pack, cat, action) {
    const handlers = {
        claim: () => claim(c),
        revise: () => go(`#edit/${c.case_id}`),
        approve_reduced: () => reduceSheet(ctx, c, pack, cat),
        revoke: () => revokeSheet(c),
        reduce: () => reduceActiveSheet(c, pack, cat),
        confirm_verification: () => confirmSheet(c),
        dispute_verification: () => disputeSheet(c),
        discard: () => discardSheet(c),
    };
    const onclick = handlers[action] ?? (() => decide(ctx, c, pack, action));
    return el('button', { class: PRIMARY_ACTIONS.has(action) ? 'primary' : '', 'data-action': action, onclick }, t.action[action]);
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
    const needsProof = c.actions.some((a) => !NO_PROOF_ACTIONS.includes(a));
    return [
        el('a', { href: '#', class: 'back' }, `← ${t.home}`),
        el('h2', { 'data-testid': 'case-title' }, `${t.caseNo} ${d.case_no} `, tierBadge(d.tier?.name), ' ', stateBadge(c.state)),
        d.exceptions.length
            ? el(
                  'div',
                  { class: 'result warn', 'data-testid': 'case-exceptions' },
                  d.exceptions.map((x) => el('p', {}, pack.exceptionText?.(x.rule_code) ?? t.exception[x.rule_code] ?? t.exceptionUnknown)),
              )
            : null,
        // 逾期還沒被處理（資料庫算好，頁面不自行推斷；K-PROGRAM-STALLED）
        c.overdue
            ? el(
                  'div',
                  { class: 'result bad', role: 'alert', 'data-testid': 'overdue', 'data-kind': c.overdue.kind },
                  t.overdue.box(c.overdue),
              )
            : null,
        // 被授權者不能用：不能再往下核准（資料庫回傳的訊息與期限；K-OWNER-CONTINUITY）
        c.hold
            ? el(
                  'div',
                  { class: 'result bad', role: 'alert', 'data-testid': 'hold', 'data-code': c.hold.code },
                  el('p', {}, c.hold.message),
                  c.hold.due_text ? el('p', {}, t.holdDue(c.hold.due_text)) : null,
              )
            : null,
        duplicatesNotice(c),
        needsProof ? passkeyNotice(ctx.me) : null,
        confirmationPanel(c),
        decisionFacts(d, pack),
        waitingText(c) ? el('p', { class: 'muted', 'data-testid': 'progress' }, `${t.progress}：`, waitingText(c)) : null,
        slaView(c),
        deliveryView(c),
        usageView(c),
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
