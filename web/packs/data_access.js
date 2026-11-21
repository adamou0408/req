// 資料授權流程包的畫面元件：決定畫面的資料範圍、使用情境、與前一版的差異、要交給外部系統的規則。
// 決定畫面一律只從資料庫產生的顯示摘要（display，名稱與分級都在裡面；裁決 D75）畫出，不讀資料目錄——
// 後端改寫目錄或 case_get 的欄位，畫面上的判斷內容不會跟著變；改寫摘要本身，簽章就對不上。
// 資料目錄只用在新申請與縮小的編輯器（收集輸入），以及首頁卡片的一行摘要。級別、縮小或擴大、重疊一律以資料庫為準。
import { api } from '../api.js';
import { t } from '../i18n.js';
import { dateText, el, explain, facts, fill, flash, section } from '../ui.js';

const tx = t.dataAccess;
let cached = null;

/**
 * 首頁：等看的人（資料擁有者）確認的目錄異動（D92 (6)）。清單與能不能確認都由資料庫決定（data_access_catalog_pending），
 * 按「意義沒變，確認」就送出確認，再依回傳的清單重畫。沒有待確認的就不顯示。
 */
export async function homeSection() {
    const box = el('div', { 'data-testid': 'catalog-drift' });
    const draw = (list) => {
        fill(box, ...(list.length ? [el('p', { class: 'muted' }, tx.drift.hint), ...list.map(driftCard)] : []));
        box.closest('section')?.toggleAttribute('hidden', list.length === 0);
    };
    const driftCard = (x) =>
        el(
            'div',
            { class: 'card', 'data-testid': 'catalog-drift-item', 'data-case-no': String(x.case_no) },
            el('a', { href: `#case/${x.case_id}` }, tx.drift.item(x)),
            el(
                'ul',
                {},
                x.changes.map((c) => el('li', {}, tx.drift.change(c))),
            ),
            el('p', { class: 'muted' }, tx.drift.due(dateText(x.due_at))),
            el(
                'button',
                {
                    class: 'primary',
                    'data-testid': 'catalog-drift-confirm',
                    onclick: async () => {
                        try {
                            draw(await api.call('data_access_catalog_confirm', { exception_id: x.exception_id }));
                            flash(tx.drift.done(x.case_no), true);
                        } catch (err) {
                            flash(explain(err));
                        }
                    },
                },
                tx.drift.confirm,
            ),
        );
    const [list, followups] = await Promise.all([api.call('data_access_catalog_pending'), followupSection()]);
    if (!list.length) return followups ? [followups] : null;
    const out = section('catalog-drift', tx.drift.title, box);
    draw(list);
    return [out, followups].filter(Boolean);
}

/**
 * 首頁：等看的人（申請人）補的上線後使用報告（D94 (4)）。清單由資料庫決定（data_access_report_pending），按「產生使用報告」就送出，
 * 再依回傳的報告顯示結果。沒有待補的就不顯示。
 */
async function followupSection() {
    const list = await api.call('data_access_report_pending');
    if (!list.length) return null;
    const box = el('div', { 'data-testid': 'report-followups' });
    const card = (x) =>
        el(
            'div',
            { class: 'card', 'data-testid': 'report-followup', 'data-case-no': String(x.case_no) },
            el('a', { href: `#case/${x.case_id}` }, tx.followup.item(x)),
            el(
                'button',
                {
                    class: 'primary',
                    'data-testid': 'report-make',
                    onclick: async () => {
                        try {
                            const r = await api.call('data_access_usage_report', { case_id: x.case_id });
                            fill(box, reportView(r.display));
                            flash(tx.followup.done(x.case_no), true);
                        } catch (err) {
                            flash(explain(err));
                        }
                    },
                },
                tx.followup.make,
            ),
        );
    fill(box, el('p', { class: 'muted' }, tx.followup.hint), ...list.map(card));
    return section('report-followups', tx.followup.title, box);
}

/** 資料目錄（主題包、欄位與分級、列條件、使用情境分類）。同一個頁面期間只讀一次。 */
export async function catalog() {
    cached ??= await api.call('data_access_catalog');
    return cached;
}

/** 新申請畫面：被授權者換了就重讀可以引用的測試區單（D93 (4)；清單由資料庫決定）。 */
export async function termsChanged(editor, terms) {
    editor.setBases(terms.principal_id ? await api.call('data_access_test_bases', { principal_id: terms.principal_id }) : []);
}

/**
 * 新申請畫面：匯出需求調查的方法是附屬的調查紀錄（不進申請內容；DA-EXPORT-SURVEY），記錄前要先有草稿；
 * 修改既有的單時預選最新記錄的方法。
 */
export async function bindEditor(editor, { caseId, save, existing }) {
    if (!editor.survey) return;
    editor.survey.bind({ caseId, save });
    if (existing) editor.survey.preset(await api.call('data_access_export_method_latest', { case_id: existing.case_id }));
}

/** 退回時的常見原因（按一下就用它當原因）。 */
export const returnReasons = tx.returnReasons;

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

/** 使用方系統做不到的限制（display.content.capability_gaps；D92 (5)）：簽核人看得到、也簽到這一段。 */
const capabilityGaps = (gaps) =>
    gaps?.length
        ? el(
              'div',
              { class: 'warn-text', 'data-testid': 'capability-gaps' },
              el('strong', {}, tx.capabilityGapsTitle),
              el(
                  'ul',
                  {},
                  gaps.map((g) => el('li', { 'data-aspect': g.aspect }, g.text)),
              ),
          )
        : null;

/** 環境與測試依據（display.content.environment、test_basis、test_exception；D93）：舊單沒有這幾項。 */
const zoneLines = (shown) => [
    shown.environment
        ? el(
              'div',
              { 'data-testid': 'environment-line', 'data-environment': shown.environment.code },
              el('strong', {}, shown.environment.text),
          )
        : null,
    shown.test_basis ? el('div', { 'data-testid': 'test-basis-line' }, shown.test_basis.text) : null,
    shown.test_exception ? el('div', { class: 'warn-text', 'data-testid': 'test-exception-line' }, shown.test_exception.text) : null,
];

/**
 * 測試報告（display.content.test_report；D94）：警示在最上面，七個區塊各一段。每一個字都由資料庫產生（簽到的內容包含它）。
 * 送審時的測試報告與上線後的使用報告用同一個元件。
 */
export const reportView = (r) =>
    el(
        'div',
        { class: 'card report', 'data-testid': 'test-report' },
        el('h4', {}, tx.reportTitle),
        el('p', { class: 'muted mono' }, r.title),
        r.warnings.length
            ? el(
                  'div',
                  { class: 'result warn', 'data-testid': 'report-warnings' },
                  el('strong', {}, tx.reportWarnings),
                  el(
                      'ul',
                      {},
                      r.warnings.map((w) => el('li', { 'data-code': w.code }, w.text)),
                  ),
              )
            : null,
        r.sections.map((sec) =>
            el(
                'details',
                { 'data-section': sec.key, open: sec.key === 'used' || sec.key === 'diff' },
                el('summary', {}, tx.reportSections[sec.key] ?? sec.key),
                el(
                    'ul',
                    {},
                    sec.lines.map((line) => el('li', {}, line)),
                ),
            ),
        ),
    );

/** 「哪些資料」：環境、主題包、欄位、列條件、資料期間、綁定的資料目錄版本、做不到的限制（display.content）。 */
export const scopeView = (shown) =>
    el(
        'div',
        { 'data-testid': 'scope-view' },
        zoneLines(shown),
        el(
            'ul',
            { class: 'scope' },
            shown.scope.map((s) => packageLine(s)),
        ),
        el('div', {}, `${tx.dataPeriod}：${periodText(shown.data_period)}`),
        shown.catalog ? el('div', { class: 'muted', 'data-testid': 'catalog-version' }, shown.catalog.text) : null,
        capabilityGaps(shown.capability_gaps),
        shown.application ? el('div', { 'data-testid': 'application-line' }, shown.application.text) : null,
        shown.test_report ? reportView(shown.test_report) : null,
    );

/** 流程包的例外說明（核心頁面不認得流程包的規則代碼）。 */
export const exceptionText = (code) => tx.exception[code] ?? null;

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
    const out = [];
    if (before.environment && after.environment && before.environment.code !== after.environment.code)
        out.push(tx.diffEnvironment(before.environment.name, after.environment.name));
    if ((before.test_basis?.text ?? before.test_exception?.text) !== (after.test_basis?.text ?? after.test_exception?.text))
        out.push(
            tx.diffBasis(
                before.test_basis?.text ?? before.test_exception?.text ?? '—',
                after.test_basis?.text ?? after.test_exception?.text ?? '—',
            ),
        );
    out.push(...scopeDiff(before, after));
    if (periodText(before.data_period) !== periodText(after.data_period))
        out.push(tx.diffPeriod(periodText(before.data_period), periodText(after.data_period)));
    if (before.purpose.category !== after.purpose.category || before.purpose.description !== after.purpose.description)
        out.push(tx.diffPurpose);
    if (before.export_allowed !== after.export_allowed) out.push(after.export_allowed ? tx.diffExportOn : tx.diffExportOff);
    if (before.catalog && after.catalog && before.catalog.version_no !== after.catalog.version_no)
        out.push(tx.diffCatalog(before.catalog.version_no, after.catalog.version_no));
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
