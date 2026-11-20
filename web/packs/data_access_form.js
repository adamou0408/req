// 資料授權的資料範圍編輯器：主題包 → 欄位 → 列條件、資料期間、使用情境、可否匯出。
// limitTo 有值時是「縮小」模式：只列出目前版本已有的主題包、欄位、列條件值，使用情境不能改（改說明算擴大）。
// 送進資料庫前不做任何判斷：L1、L2 欄位照樣可以勾，由資料庫移除並提示。
import { t } from '../i18n.js';
import { el } from '../ui.js';

const tx = t.dataAccess;
const fieldCode = (f) => (typeof f === 'string' ? f : f.code);

/** 一個可勾選的項目：整列都是觸控目標（至少 44px）。 */
export function choice(id, label, checked, extra = {}) {
    return el('label', { class: 'choice', for: id }, el('input', { type: 'checkbox', id, checked, ...extra }), el('span', {}, label));
}

function fieldChoices(prefix, pkg, selected, limit) {
    const fields = limit ? pkg.fields.filter((f) => limit.fields.map(fieldCode).includes(f.code)) : pkg.fields;
    return fields.map((f) =>
        choice(
            `${prefix}-${pkg.code}-f-${f.code}`,
            [f.name, el('small', { class: 'muted' }, ` ${tx.classification(f.classification)}`)],
            selected.has(f.code),
            {
                'data-field': f.code,
                'data-package': pkg.code,
            },
        ),
    );
}

function enumFilter(prefix, pkg, filter, current, limit) {
    const allowed = limit ? (limit.row_filters ?? []).find((c) => c.filter === filter.code)?.values : null;
    if (limit && !allowed) return null;
    const values = allowed ? filter.values.filter((v) => allowed.includes(v.value)) : filter.values;
    const chosen = new Set(current?.values ?? []);
    return el(
        'fieldset',
        { class: 'filter', 'data-filter': filter.code, 'data-type': 'enum' },
        el('legend', {}, `${filter.name}${tx.filterHint}`),
        values.map((v) =>
            choice(`${prefix}-${pkg.code}-r-${filter.code}-${v.value}`, v.label, chosen.has(v.value), { 'data-value': v.value }),
        ),
    );
}

function numberFilter(prefix, pkg, filter, current, limit) {
    if (limit && !(limit.row_filters ?? []).some((c) => c.filter === filter.code)) return null;
    const id = `${prefix}-${pkg.code}-r-${filter.code}`;
    const [from, to] = current?.values ?? ['', ''];
    return el(
        'fieldset',
        { class: 'filter range', 'data-filter': filter.code, 'data-type': 'range' },
        el('legend', {}, `${filter.name}${tx.rangeHint}`),
        el('label', { for: `${id}-from` }, tx.from),
        el('input', { id: `${id}-from`, type: 'number', inputmode: 'decimal', value: from, 'data-bound': 'from' }),
        el('label', { for: `${id}-to` }, tx.to),
        el('input', { id: `${id}-to`, type: 'number', inputmode: 'decimal', value: to, 'data-bound': 'to' }),
    );
}

function packageBlock(prefix, pkg, item, limit) {
    const selected = new Set((item?.fields ?? []).map(fieldCode));
    const filters = pkg.filters.map((f) => {
        const current = (item?.row_filters ?? []).find((c) => c.filter === f.code);
        return f.value_type === 'enum' ? enumFilter(prefix, pkg, f, current, limit) : numberFilter(prefix, pkg, f, current, limit);
    });
    const block = el(
        'fieldset',
        { class: 'card package', 'data-package': pkg.code },
        el('legend', {}, pkg.name),
        el('div', { class: 'choices' }, fieldChoices(prefix, pkg, selected, limit)),
        filters,
    );
    if (limit) return block;
    // 新申請：每個主題包收合成一列（名稱與已選幾個欄位），選過的打開；手機上一個畫面看得到全部主題包
    const count = el('small', { class: 'muted', 'data-testid': 'package-count' });
    const recount = () => (count.textContent = tx.packageChosen(block.querySelectorAll('input[data-field]:checked').length));
    recount();
    return el(
        'details',
        { class: 'package-wrap', 'data-package': pkg.code, open: selected.size > 0, onchange: recount },
        el('summary', { 'data-testid': 'package-toggle' }, el('span', {}, pkg.name), count),
        block,
    );
}

function readFilter(fieldset) {
    const code = fieldset.dataset.filter;
    if (fieldset.dataset.type === 'enum') {
        const values = [...fieldset.querySelectorAll('input:checked')].map((i) => i.dataset.value);
        return values.length ? { filter: code, op: 'in', values } : null;
    }
    const bound = (b) => fieldset.querySelector(`[data-bound=${b}]`).value;
    if (bound('from') === '' && bound('to') === '') return null;
    return { filter: code, op: 'between', values: [bound('from'), bound('to')].map((v) => (v === '' ? null : Number(v))) };
}

function readScope(root) {
    return [...root.querySelectorAll('fieldset.package')]
        .map((block) => ({
            package: block.dataset.package,
            fields: [...block.querySelectorAll('input[data-field]:checked')].map((i) => i.dataset.field),
            row_filters: [...block.querySelectorAll('fieldset.filter')].map(readFilter).filter(Boolean),
        }))
        .filter((s) => s.fields.length > 0);
}

function periodInputs(prefix, period) {
    return el(
        'fieldset',
        { class: 'period' },
        el('legend', {}, tx.dataPeriodLegend),
        el('label', { for: `${prefix}-period-from` }, tx.from),
        el('input', { id: `${prefix}-period-from`, type: 'date', value: period?.from ?? '' }),
        el('label', { for: `${prefix}-period-to` }, tx.to),
        el('input', { id: `${prefix}-period-to`, type: 'date', value: period?.to ?? '' }),
    );
}

function purposeInputs(prefix, cat, content) {
    return [
        el('label', { for: `${prefix}-purpose` }, tx.purposeCategory),
        el(
            'select',
            { id: `${prefix}-purpose` },
            el('option', { value: '' }, tx.choose),
            cat.purpose_categories.map((c) => el('option', { value: c.code, selected: c.code === content.purpose_category }, c.name)),
        ),
        el('label', { for: `${prefix}-purpose-text` }, tx.purposeDescription),
        el('textarea', { id: `${prefix}-purpose-text`, rows: 3 }, content.purpose_description ?? ''),
    ];
}

/**
 * 建立編輯器。回傳 { node, value(), parts }；value() 讀出目前的內容（流程包的 content 結構）。
 * parts：{ scope（主題包與資料期間）, purpose（使用情境與可否匯出） }，新申請畫面把它們放在不同的段落；
 * node 是兩者合在一起的樣子（縮小後核准的面板用）。
 * 縮小模式下，使用情境沿用 base；可否匯出只有原本可匯出時才能改成不可。
 */
export function scopeEditor(prefix, cat, base, { limitTo = null } = {}) {
    const items = new Map((base.scope ?? []).map((s) => [s.package, s]));
    const limits = limitTo ? new Map(limitTo.scope.map((s) => [s.package, s])) : null;
    const packages = limits ? cat.packages.filter((p) => limits.has(p.code)) : cat.packages;
    const showExport = !limitTo || limitTo.export_allowed;
    const scope = el(
        'div',
        { class: 'scope-part' },
        el('h3', {}, tx.scopeTitle),
        packages.map((p) => packageBlock(prefix, p, items.get(p.code), limits?.get(p.code))),
        periodInputs(prefix, base.data_period),
    );
    const purpose = el(
        'div',
        { class: 'purpose-part' },
        limitTo ? null : purposeInputs(prefix, cat, base),
        showExport ? choice(`${prefix}-export`, tx.exportAsk, base.export_allowed === true) : null,
    );
    const node = el('div', { class: 'scope-editor', 'data-testid': `${prefix}-editor` }, scope, purpose);
    const find = (sel) => scope.querySelector(sel) ?? purpose.querySelector(sel);
    const value = () => {
        const from = find(`#${prefix}-period-from`).value;
        const to = find(`#${prefix}-period-to`).value;
        return {
            scope: readScope(scope),
            data_period: from || to ? { from: from || null, to: to || null } : null,
            purpose_category: limitTo ? base.purpose_category : find(`#${prefix}-purpose`).value || null,
            purpose_description: limitTo ? base.purpose_description : find(`#${prefix}-purpose-text`).value,
            export_allowed: showExport ? find(`#${prefix}-export`).checked : false,
        };
    };
    return { node, value, parts: { scope, purpose } };
}
