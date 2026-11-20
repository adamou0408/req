// 新申請、修改（草稿、退回、撤回後）：填內容時即時存成草稿版本，顯示資料庫判定的級別、會經過的關卡、
// 提示、要修正的地方與重疊檢查；送出時把重疊理由交給資料庫。畫面不自己判斷任何規則。
import { api } from '../api.js';
import { t } from '../i18n.js';
import { packOf } from '../packs/index.js';
import { el, explain, flash, go, tierBadge } from '../ui.js';

const SAVE_DELAY_MS = 500;

function termsInputs(principals, terms, options) {
    return [
        options.uses_principal
            ? [
                  el('label', { for: 'f-principal' }, t.principal),
                  el(
                      'select',
                      { id: 'f-principal' },
                      el('option', { value: '' }, t.choose),
                      principals.map((p) =>
                          el(
                              'option',
                              { value: p.principal_id, selected: p.principal_id === terms.principal?.principal_id },
                              t.principalOption(p),
                          ),
                      ),
                  ),
              ]
            : null,
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

function pathView(type, tier) {
    const stages = type.tiers.find((x) => x.code === tier)?.stages ?? [];
    return el(
        'div',
        {},
        el('h4', {}, t.pathTitle),
        el(
            'ol',
            { class: 'path', 'data-testid': 'path' },
            stages.map((s) =>
                el('li', { 'data-stage': s.code }, s.name, s.mode === 'all' ? el('small', { class: 'muted' }, t.parallel) : null),
            ),
        ),
    );
}

function overlapView(pack, cat, overlap) {
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
                el('li', {}, t.overlapItem(i, i.packages.map((p) => pack.packagesLine(cat, { scope: [p] })).join('、'))),
            ),
        ),
    );
}

/** 即時檢查的結果：級別、路徑、提示、錯誤、重疊。全部來自資料庫回傳的申請單。 */
function checkView(type, pack, cat, detail) {
    return [
        el('p', {}, `${t.tierLabel}：`, tierBadge(detail.tier) ?? '—'),
        pathView(type, detail.tier),
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
        overlapView(pack, cat, detail.overlap),
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
    const reason = el('textarea', { id: 'f-overlap-reason', rows: 2 }, existing?.overlap?.reason ?? '');
    const reasonBlock = el(
        'div',
        { hidden: true, 'data-testid': 'overlap-reason' },
        el('label', { for: 'f-overlap-reason' }, t.overlapReason),
        reason,
    );
    const submit = el('button', { class: 'primary', type: 'submit', 'data-testid': 'submit', disabled: true }, t.submit);
    const form = el(
        'form',
        { 'data-testid': 'apply-form', novalidate: true },
        el('h2', {}, existing ? t.editTitle(existing.case_no) : t.newTitle),
        existing ? returnedNote(existing) : null,
        el('div', { class: 'card' }, termsInputs(principals, existing?.terms ?? {}, type.options)),
        editor.node,
        check,
        reasonBlock,
        el(
            'div',
            { class: 'actions' },
            el('button', { type: 'button', onclick: () => go(existing ? `#case/${existing.case_id}` : '#') }, t.cancel),
            submit,
        ),
    );
    const state = { caseId: existing?.case_id ?? null, saved: null, chain: Promise.resolve(), timer: null };
    const show = (detail) => {
        check.replaceChildren(el('h3', {}, t.checkTitle), ...checkView(type, pack, cat, detail).filter(Boolean));
        reasonBlock.hidden = detail.overlap?.level !== 'partial';
        submit.disabled = !detail.actions.includes('submit');
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
