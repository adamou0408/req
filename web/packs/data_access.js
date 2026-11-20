// 資料授權流程包的畫面元件：決定畫面的資料範圍、使用情境、與前一版的差異、要交給外部系統的規則。
// 決定畫面一律只從資料庫產生的顯示摘要（display，名稱與分級都在裡面；裁決 D75）畫出，不讀資料目錄——
// 後端改寫目錄或 case_get 的欄位，畫面上的判斷內容不會跟著變；改寫摘要本身，簽章就對不上。
// 資料目錄只用在新申請與縮小的編輯器（收集輸入），以及首頁卡片的一行摘要。級別、縮小或擴大、重疊一律以資料庫為準。
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

/** 給清單卡片與新申請畫面用的一行：哪些主題包（不是決定畫面）。 */
export const packagesLine = (cat, content) =>
    (content.scope ?? []).map((s) => cat.packages.find((p) => p.code === s.package)?.name ?? s.package).join('、');

const periodText = (p) => (p ? tx.between(p.from ?? '—', p.to ?? '—') : tx.noPeriod);

const valuesText = (f) =>
    f.op === 'between' ? tx.between(f.values[0]?.label, f.values[1]?.label) : f.values.map((v) => v.label).join('、');

const filterText = (f) => `${f.filter_name}：${valuesText(f)}`;

const fieldsText = (pkg) => pkg.fields.map((f) => `${f.name}（${f.classification}）`).join('、') || tx.noFields;

/** 一個主題包的一行：名稱、欄位與分級、列條件（顯示摘要的一項）。 */
function packageLine(pkg) {
    const filters = pkg.row_filters.map(filterText);
    return el(
        'li',
        { 'data-package': pkg.package },
        el('strong', {}, pkg.package_name),
        `：${fieldsText(pkg)}`,
        el('div', { class: 'muted' }, filters.length ? filters.join('；') : tx.allRows),
    );
}

/** 重疊項目的主題包（顯示摘要的 overlap.items[].packages）。 */
export const overlapPackages = (packages) => packages.map((p) => `${p.package_name}：${p.fields.map((f) => f.name).join('、')}`).join('；');

/** 「哪些資料」：主題包、欄位、列條件、資料期間（display.content）。 */
export const scopeView = (shown) =>
    el(
        'div',
        { 'data-testid': 'scope-view' },
        el(
            'ul',
            { class: 'scope' },
            shown.scope.map((s) => packageLine(s)),
        ),
        el('div', {}, `${tx.dataPeriod}：${periodText(shown.data_period)}`),
    );

/** 使用情境與可否匯出（display.content）。 */
export const purposeView = (shown) =>
    facts([
        [tx.purpose, `${shown.purpose.category_name ?? '—'}${shown.purpose.description ? `：${shown.purpose.description}` : ''}`],
        [tx.export, shown.export_allowed ? tx.exportYes : tx.exportNo],
    ]);

function scopeDiff(before, after) {
    const out = [];
    const old = new Map(before.scope.map((s) => [s.package, s]));
    const now = new Map(after.scope.map((s) => [s.package, s]));
    for (const [code, item] of now) {
        const prev = old.get(code);
        if (!prev) {
            out.push(tx.diffAddedPackage(item.package_name));
            continue;
        }
        const a = new Set(prev.fields.map((f) => f.code));
        const b = new Set(item.fields.map((f) => f.code));
        const added = item.fields.filter((f) => !a.has(f.code)).map((f) => f.name);
        const removed = prev.fields.filter((f) => !b.has(f.code)).map((f) => f.name);
        if (added.length) out.push(tx.diffAddedFields(item.package_name, added.join('、')));
        if (removed.length) out.push(tx.diffRemovedFields(item.package_name, removed.join('、')));
        const fa = prev.row_filters.map(filterText).join('；');
        const fb = item.row_filters.map(filterText).join('；');
        if (fa !== fb) out.push(tx.diffFilters(item.package_name, fa || tx.allRows, fb || tx.allRows));
    }
    for (const [code, item] of old) if (!now.has(code)) out.push(tx.diffRemovedPackage(item.package_name));
    return out;
}

/** 兩份顯示內容的差異，逐項以文字列出（只是呈現；縮小或擴大由資料庫判定）。 */
export function contentDiff(before, after) {
    const out = scopeDiff(before, after);
    if (periodText(before.data_period) !== periodText(after.data_period))
        out.push(tx.diffPeriod(periodText(before.data_period), periodText(after.data_period)));
    if (before.purpose.category !== after.purpose.category || before.purpose.description !== after.purpose.description)
        out.push(tx.diffPurpose);
    if (before.export_allowed !== after.export_allowed) out.push(after.export_allowed ? tx.diffExportOn : tx.diffExportOff);
    return out;
}

/**
 * 要交給外部系統的規則（核准完成後由資料庫產生；執行內容的雜湊簽進去）。
 * 主題包與欄位的名稱取顯示摘要裡同一個代碼的名稱（shown＝display.content），不讀資料目錄。
 */
export function fulfilmentView(shown, payload) {
    const pkgOf = (code) => shown.scope.find((s) => s.package === code);
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
            payload.rules.map((r) => {
                const pkg = pkgOf(r.package);
                const fields = r.fields.map((f) => pkg?.fields.find((x) => x.code === f)?.name ?? f).join('、');
                return el(
                    'li',
                    { 'data-rule-id': r.rule_id },
                    el('strong', {}, `${tx.ruleNo} ${r.rule_id}・${tx.system} ${r.system}`),
                    el('div', {}, `${pkg?.package_name ?? r.package}：${fields}`),
                    el('div', { class: 'muted' }, pkg?.row_filters.length ? pkg.row_filters.map(filterText).join('；') : tx.allRows),
                    r.data_period ? el('div', { class: 'muted' }, `${tx.dataPeriod}：${periodText(r.data_period)}`) : null,
                );
            }),
        ),
        el(
            'details',
            {},
            el('summary', {}, tx.rawRules),
            el('pre', { class: 'mono', 'data-testid': 'fulfilment-json' }, JSON.stringify(payload, null, 2)),
        ),
    );
}
