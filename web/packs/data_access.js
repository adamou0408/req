// 資料授權流程包的畫面元件：資料範圍編輯器、內容摘要、與前一版的差異、要交給外部系統的規則。
// 只做呈現與收集輸入；級別、哪些欄位要申請、縮小或擴大、重疊，一律以資料庫回傳的為準。
import { api } from '../api.js';
import { t } from '../i18n.js';
import { el, facts } from '../ui.js';

const tx = t.dataAccess;
let cached = null;

/** 資料目錄（主題包、欄位與分級、列條件、使用情境分類）。同一個頁面期間只讀一次。 */
export async function catalog() {
    cached ??= await api.call('data_access_catalog');
    return cached;
}

const pkgOf = (cat, code) => cat.packages.find((p) => p.code === code);
const fieldName = (pkg, code) => pkg?.fields.find((f) => f.code === code)?.name ?? code;
const fieldCode = (f) => (typeof f === 'string' ? f : f.code);

function filterText(pkg, cond) {
    const filter = pkg?.filters.find((f) => f.code === cond.filter);
    const label = (v) => filter?.values.find((x) => x.value === v)?.label ?? String(v);
    const values = cond.op === 'between' ? tx.between(cond.values[0], cond.values[1]) : cond.values.map(label).join('、');
    return `${filter?.name ?? cond.filter}：${values}`;
}

const periodText = (p) => (p ? tx.between(p.from ?? '—', p.to ?? '—') : tx.noPeriod);

/** 一個主題包的一行摘要：欄位、列條件。 */
function scopeLine(cat, item) {
    const pkg = pkgOf(cat, item.package);
    const filters = (item.row_filters ?? []).map((c) => filterText(pkg, c));
    return el(
        'li',
        { 'data-package': item.package },
        el('strong', {}, pkg?.name ?? item.package),
        `：${item.fields.map((f) => fieldName(pkg, fieldCode(f))).join('、') || tx.noFields}`,
        filters.length ? el('div', { class: 'muted' }, filters.join('；')) : el('div', { class: 'muted' }, tx.allRows),
    );
}

/** 給清單卡片用的一行：哪些主題包。 */
export const packagesLine = (cat, content) => (content.scope ?? []).map((s) => pkgOf(cat, s.package)?.name ?? s.package).join('、');

/** 「哪些資料」：主題包、欄位、列條件、資料期間。 */
export const scopeView = (cat, content) =>
    el(
        'div',
        { 'data-testid': 'scope-view' },
        el(
            'ul',
            { class: 'scope' },
            (content.scope ?? []).map((s) => scopeLine(cat, s)),
        ),
        el('div', {}, `${tx.dataPeriod}：${periodText(content.data_period)}`),
    );

/** 完整內容的其餘部分：使用情境、可否匯出。 */
export function purposeView(cat, content) {
    const category = cat.purpose_categories.find((c) => c.code === content.purpose_category);
    return facts([
        [
            tx.purpose,
            `${category?.name ?? content.purpose_category ?? '—'}${content.purpose_description ? `：${content.purpose_description}` : ''}`,
        ],
        [tx.export, content.export_allowed ? tx.exportYes : tx.exportNo],
    ]);
}

function fieldsByPackage(content) {
    return new Map((content.scope ?? []).map((s) => [s.package, s]));
}

function scopeDiff(cat, before, after) {
    const out = [];
    const old = fieldsByPackage(before);
    const now = fieldsByPackage(after);
    for (const [code, item] of now) {
        const pkg = pkgOf(cat, code);
        const prev = old.get(code);
        if (!prev) {
            out.push(tx.diffAddedPackage(pkg?.name ?? code));
            continue;
        }
        const a = new Set(prev.fields.map(fieldCode));
        const b = new Set(item.fields.map(fieldCode));
        const added = [...b].filter((f) => !a.has(f)).map((f) => fieldName(pkg, f));
        const removed = [...a].filter((f) => !b.has(f)).map((f) => fieldName(pkg, f));
        if (added.length) out.push(tx.diffAddedFields(pkg?.name ?? code, added.join('、')));
        if (removed.length) out.push(tx.diffRemovedFields(pkg?.name ?? code, removed.join('、')));
        const fa = (prev.row_filters ?? []).map((c) => filterText(pkg, c)).join('；');
        const fb = (item.row_filters ?? []).map((c) => filterText(pkg, c)).join('；');
        if (fa !== fb) out.push(tx.diffFilters(pkg?.name ?? code, fa || tx.allRows, fb || tx.allRows));
    }
    for (const code of old.keys()) if (!now.has(code)) out.push(tx.diffRemovedPackage(pkgOf(cat, code)?.name ?? code));
    return out;
}

/** 兩份內容的差異，逐項以文字列出（只是呈現；縮小或擴大由資料庫判定）。 */
export function contentDiff(cat, before, after) {
    const out = scopeDiff(cat, before, after);
    if (periodText(before.data_period) !== periodText(after.data_period))
        out.push(tx.diffPeriod(periodText(before.data_period), periodText(after.data_period)));
    if (before.purpose_category !== after.purpose_category || before.purpose_description !== after.purpose_description)
        out.push(tx.diffPurpose);
    if (before.export_allowed !== after.export_allowed) out.push(after.export_allowed ? tx.diffExportOn : tx.diffExportOff);
    return out;
}

/** 要交給外部系統的規則（核准完成後由資料庫產生）。 */
export function fulfilmentView(cat, payload) {
    return el(
        'div',
        { 'data-testid': 'fulfilment-rules' },
        facts([
            [tx.grantee, `${payload.grantee.name}`],
            [tx.valid, tx.between(payload.valid.from, payload.valid.to)],
            [tx.export, payload.export ? tx.exportYes : tx.exportNo],
        ]),
        el(
            'ol',
            { class: 'rules' },
            payload.rules.map((r) =>
                el(
                    'li',
                    { 'data-rule-id': r.rule_id },
                    el('strong', {}, `${tx.ruleNo} ${r.rule_id}・${tx.system} ${r.system}`),
                    scopeLine(cat, { package: r.package, fields: r.fields, row_filters: r.row_filter }),
                    r.data_period ? el('div', { class: 'muted' }, `${tx.dataPeriod}：${periodText(r.data_period)}`) : null,
                ),
            ),
        ),
        el(
            'details',
            {},
            el('summary', {}, tx.rawRules),
            el('pre', { class: 'mono', 'data-testid': 'fulfilment-json' }, JSON.stringify(payload, null, 2)),
        ),
    );
}
