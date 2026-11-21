// 新申請、修改（草稿、退回、撤回後）：填內容時即時存成草稿版本，顯示資料庫判定的級別、會經過的關卡、
// 提示、要修正的地方與重疊檢查；送出時把重疊理由交給資料庫。畫面不自己判斷任何規則。
// 分成四段（給誰・多久／哪些資料／用途／檢查並送出），手機上一段一個畫面；最上面一行隨時顯示判定的級別與關卡。
// 關卡（含代填時的「被授權者負責人確認」）與「這次修改是縮小還是擴大、要不要重簽」都只取資料庫回傳的申請單。
import { api } from '../api.js';
import { t } from '../i18n.js';
import { packOf } from '../packs/index.js';
import { el, explain, fill, flash, go, tierBadge } from '../ui.js';
import { discardSheet } from './case.js';

const SAVE_DELAY_MS = 500;

const principalOption = (p, terms) =>
    el('option', { value: p.principal_id, selected: p.principal_id === terms.principal?.principal_id }, t.principalOption(p));

/** 被授權者選單：自己負責的排在前面（送出後不必多一關負責人確認），別人負責的另一組。分組依資料庫回傳的 mine。 */
function principalSelect(principals, terms) {
    const groups = [
        [t.principalMine, principals.filter((p) => p.mine)],
        [t.principalOthers, principals.filter((p) => !p.mine)],
    ].filter(([, list]) => list.length);
    return el(
        'select',
        { id: 'f-principal' },
        el('option', { value: '' }, t.choose),
        groups.map(([label, list]) =>
            el(
                'optgroup',
                { label },
                list.map((p) => principalOption(p, terms)),
            ),
        ),
    );
}

function termsInputs(principals, terms, options) {
    return [
        options.uses_principal ? [el('label', { for: 'f-principal' }, t.principal), principalSelect(principals, terms)] : null,
        options.has_validity
            ? el(
                  'div',
                  { class: 'pair' },
                  el(
                      'div',
                      {},
                      el('label', { for: 'f-valid-from' }, t.validFrom),
                      el('input', { id: 'f-valid-from', type: 'date', value: terms.valid_from ?? '' }),
                  ),
                  el(
                      'div',
                      {},
                      el('label', { for: 'f-valid-to' }, t.validTo),
                      el('input', { id: 'f-valid-to', type: 'date', value: terms.valid_to ?? '' }),
                  ),
              )
            : null,
    ];
}

function readTerms(form, options) {
    const value = (id) => form.querySelector(id)?.value || null;
    return {
        ...(options.uses_principal ? { principal_id: value('#f-principal') } : {}),
        ...(options.has_validity ? { valid_from: value('#f-valid-from'), valid_to: value('#f-valid-to') } : {}),
    };
}

/** 這張單會經過的關卡（資料庫依這張單算的 path）。 */
function pathView(detail) {
    return el(
        'div',
        {},
        el('h4', {}, t.pathTitle),
        el(
            'ol',
            { class: 'path', 'data-testid': 'path' },
            detail.path.map((s) =>
                el('li', { 'data-stage': s.code }, s.name, s.mode === 'all' ? el('small', { class: 'muted' }, t.parallel) : null),
            ),
        ),
    );
}

/** 退回後修改：這次修改和退回當時比是縮小還是擴大、送出後從哪裡繼續（資料庫的 resubmit）。 */
function resubmitView(resubmit) {
    if (!resubmit) return null;
    const text =
        resubmit.mode === 'restart'
            ? resubmit.change_kind === 'expand'
                ? t.resubmit.expand
                : t.resubmit.restartPolicy
            : t.resubmit[resubmit.change_kind];
    return el(
        'div',
        {
            class: `result ${resubmit.mode === 'restart' ? 'warn' : 'ok'}`,
            'data-testid': 'resubmit',
            'data-change': resubmit.change_kind,
            'data-mode': resubmit.mode,
        },
        el('h4', {}, t.resubmitTitle),
        el('p', {}, text),
    );
}

/** 最上面的一行：判定的級別與會經過的關卡（每一段都看得到）。 */
function summaryLine(detail) {
    if (!detail) return t.summaryIdle;
    return t.summaryLine(detail.tier, detail.path.map((s) => s.name).join(' → '));
}

/**
 * 重疊提示（K-OVERLAP-SHOWN）：資料庫給看的人的版本——重疊的主題包與欄位名稱；對方的單號與期間只在看的人本來就能看那張單時才有。
 */
function overlapView(pack, overlap) {
    if (!overlap) return null;
    const cls = { none: 'ok', partial: 'warn', covered: 'bad' }[overlap.level] ?? 'warn';
    return el(
        'div',
        { class: `result ${cls}`, 'data-testid': 'overlap', 'data-level': overlap.level },
        el('p', {}, t.overlapLevel[overlap.level] ?? t.overlapLevel.partial),
        el(
            'ul',
            {},
            (overlap.items ?? []).map((i) =>
                el(
                    'li',
                    { 'data-testid': 'overlap-item', 'data-case-no': i.case_no ?? '' },
                    t.overlapShownItem(i, pack.overlapPackages(i.packages)),
                ),
            ),
        ),
    );
}

/** 即時檢查的結果：級別、路徑、提示、錯誤、重疊。全部來自資料庫回傳的申請單。 */
function checkView(pack, detail) {
    return [
        el('p', {}, `${t.tierLabel}：`, tierBadge(detail.tier) ?? '—'),
        pathView(detail),
        resubmitView(detail.resubmit),
        detail.notices.length
            ? el(
                  'div',
                  { class: 'result warn', 'data-testid': 'notices' },
                  el('h4', {}, t.notices),
                  el(
                      'ul',
                      {},
                      detail.notices.map((n) => el('li', { 'data-code': n.code }, n.message)),
                  ),
              )
            : null,
        detail.errors.length
            ? el(
                  'div',
                  { class: 'result bad', 'data-testid': 'errors' },
                  el('h4', {}, t.fixFirst),
                  el(
                      'ul',
                      {},
                      detail.errors.map((e) => el('li', { 'data-path': e.path }, e.message)),
                  ),
              )
            : null,
        overlapView(pack, detail.overlap_shown),
    ];
}

function returnedNote(detail) {
    const tasks = detail.stages.flatMap((s) => s.tasks.map((task) => ({ ...task, stage: s.name })));
    const last = tasks.filter((x) => x.reason && (x.status === 'returned' || x.status === 'recalled')).at(-1);
    if (!last) return null;
    return el(
        'div',
        { class: 'result warn', 'data-testid': 'returned-note' },
        el('p', {}, t.returnedBy(last.assignee_name ?? detail.applicant_name, last.stage, last.reason)),
        el('p', {}, t.resubmitHint),
    );
}

async function loadForm(caseId) {
    const [types, principals, existing] = await Promise.all([
        api.call('process_type_list'),
        api.call('principal_list'),
        caseId ? api.call('case_get', { case_id: caseId }) : null,
    ]);
    const type = types.find((x) => x.code === (existing?.process_type ?? types[0]?.code));
    const pack = packOf(type.code);
    return { type, principals, existing, pack, cat: await pack.catalog() };
}

const SEGMENTS = ['who', 'data', 'purpose', 'review'];

/** 四段與上方的分段切換。回傳 { nav, sections, open(段) }；一次只顯示一段。 */
function segmented(contents) {
    const tabs = SEGMENTS.map((key, i) =>
        el('button', { type: 'button', 'data-segment-tab': key, onclick: () => open(key) }, `${i + 1}. ${t.segments[key]}`),
    );
    const sections = SEGMENTS.map((key, i) =>
        el(
            'section',
            { class: 'segment', 'data-segment': key, 'aria-label': t.segments[key] },
            contents[key],
            i + 1 < SEGMENTS.length
                ? el(
                      'button',
                      { type: 'button', class: 'wide', 'data-testid': 'next-segment', onclick: () => open(SEGMENTS[i + 1]) },
                      t.nextSegment(t.segments[SEGMENTS[i + 1]]),
                  )
                : null,
        ),
    );
    function open(key) {
        sections.forEach((s) => (s.hidden = s.dataset.segment !== key));
        tabs.forEach((b) => b.setAttribute('aria-current', b.dataset.segmentTab === key ? 'step' : 'false'));
        window.scrollTo(0, 0);
    }
    return { nav: el('nav', { class: 'segments', 'aria-label': t.segmentNav }, tabs), sections, open };
}

export async function renderApply(ctx, caseId = null) {
    const { type, principals, existing, pack, cat } = await loadForm(caseId);
    const base = existing?.content ?? {};
    const editor = pack.scopeEditor('f', cat, base);
    const check = el(
        'div',
        { class: 'card', 'data-testid': 'check', 'aria-live': 'polite' },
        el('h3', {}, t.checkTitle),
        el('p', { class: 'muted' }, t.checkIdle),
    );
    const summary = el('p', { class: 'summary-line', 'data-testid': 'check-summary', 'aria-live': 'polite' }, summaryLine(null));
    const reason = el('textarea', { id: 'f-overlap-reason', rows: 2 }, existing?.overlap?.reason ?? '');
    const reasonBlock = el(
        'div',
        { hidden: true, 'data-testid': 'overlap-reason' },
        el('label', { for: 'f-overlap-reason' }, t.overlapReason),
        reason,
    );
    const submit = el('button', { class: 'primary', type: 'submit', 'data-testid': 'submit', disabled: true }, t.submit);
    // 捨棄草稿（K-CASE-DISCARD）：只在資料庫回傳的 actions 有 discard 時顯示
    const discard = el(
        'button',
        {
            type: 'button',
            hidden: true,
            'data-action': 'discard',
            onclick: () => discardSheet({ case_id: state.caseId, case_no: state.caseNo }),
        },
        t.action.discard,
    );
    const parts = segmented({
        who: el('div', { class: 'card' }, termsInputs(principals, existing?.terms ?? {}, type.options)),
        data: editor.parts.scope,
        purpose: editor.parts.purpose,
        review: [
            check,
            reasonBlock,
            el(
                'div',
                { class: 'actions' },
                el('button', { type: 'button', onclick: () => go(existing ? `#case/${existing.case_id}` : '#') }, t.cancel),
                discard,
                submit,
            ),
        ],
    });
    const form = el(
        'form',
        { 'data-testid': 'apply-form', novalidate: true },
        el('h2', {}, existing ? t.editTitle(existing.case_no) : t.newTitle),
        existing ? returnedNote(existing) : null,
        summary,
        parts.nav,
        parts.sections,
    );
    parts.open('who');
    const state = {
        caseId: existing?.case_id ?? null,
        caseNo: existing?.case_no ?? null,
        saved: null,
        chain: Promise.resolve(),
        timer: null,
    };
    const show = (detail) => {
        fill(check, el('h3', {}, t.checkTitle), ...checkView(pack, detail));
        summary.textContent = summaryLine(detail);
        reasonBlock.hidden = detail.overlap?.level !== 'partial';
        submit.disabled = !detail.actions.includes('submit');
        discard.hidden = !detail.actions.includes('discard');
    };
    const save = () => {
        state.chain = state.chain
            .then(async () => {
                const draft = { content: editor.value(), terms: readTerms(form, type.options) };
                const key = JSON.stringify(draft);
                if (key === state.saved) return;
                check.dataset.busy = 'true';
                const detail = state.caseId
                    ? await api.call('case_revise', { case_id: state.caseId, ...draft })
                    : await api.call('case_create', { process_type: type.code, ...draft });
                state.caseId = detail.case_id;
                state.caseNo = detail.case_no;
                state.saved = key;
                delete check.dataset.busy;
                show(detail);
            })
            .catch((err) => flash(explain(err)));
        return state.chain;
    };
    const schedule = () => {
        clearTimeout(state.timer);
        check.dataset.busy = 'true';
        state.timer = setTimeout(save, SAVE_DELAY_MS);
    };
    // 流程包要依「給誰」重讀選項時（例如可以引用的測試區單），被授權者換了就通知它
    const termsChanged = () => pack.termsChanged?.(editor, readTerms(form, type.options)).catch((err) => flash(explain(err)));
    form.querySelector('#f-principal')?.addEventListener('change', termsChanged);
    termsChanged();
    form.oninput = schedule;
    form.onchange = schedule;
    if (existing) show(existing);
    form.onsubmit = async (event) => {
        event.preventDefault();
        flash('');
        clearTimeout(state.timer);
        await save();
        try {
            const done = await api.call('case_submit', { case_id: state.caseId, overlap_reason: reason.value || null });
            go(`#case/${done.case_id}`, { text: t.submitted(done), ok: true });
        } catch (err) {
            flash(explain(err));
        }
    };
    return [form];
}
