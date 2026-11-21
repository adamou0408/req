// 資料授權的資料範圍編輯器：環境（測試區、正式區）與測試依據、主題包 → 欄位 → 列條件、資料期間、使用情境、可否匯出。
// limitTo 有值時是「縮小」模式：只列出目前版本已有的主題包、欄位、列條件值，使用情境不能改（改說明算擴大）。
// 送進資料庫前不做任何判斷：L1、L2 欄位照樣可以勾，由資料庫移除並提示；級別、要不要測試依據、引用的單合不合格都以資料庫為準。
import { api } from '../api.js';
import { t } from '../i18n.js';
import { el, explain, fill, flash } from '../ui.js';

const tx = t.dataAccess;
const fieldCode = (f) => (typeof f === 'string' ? f : f.code);

/** 一個可勾選的項目：整列都是觸控目標（至少 44px）。 */
export function choice(id, label, checked, extra = {}) {
    return el('label', { class: 'choice', for: id }, el('input', { type: 'checkbox', id, checked, ...extra }), el('span', {}, label));
}

/** 欄位在各區的分級（目錄的標示；決定級別的是資料庫）。 */
const zoneNote = (f) =>
    (f.environments ?? []).length
        ? el('small', { class: 'muted', 'data-testid': 'zone-classification' }, ` ${f.environments.map(tx.zoneClassification).join('、')}`)
        : null;

function fieldChoices(prefix, pkg, selected, limit) {
    const fields = limit ? pkg.fields.filter((f) => limit.fields.map(fieldCode).includes(f.code)) : pkg.fields;
    return fields.map((f) =>
        choice(
            `${prefix}-${pkg.code}-f-${f.code}`,
            [f.name, el('small', { class: 'muted' }, ` ${tx.classification(f.classification)}`), zoneNote(f)],
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

/** 一個代碼表的下拉選單；選了之後在下面顯示資料庫給的引導（guidance）。 */
function surveySelect(id, label, options, current, onPick) {
    const hint = el('p', { class: 'muted', 'data-testid': `${id}-guidance`, 'aria-live': 'polite' });
    const select = el(
        'select',
        { id },
        el('option', { value: '' }, t.choose),
        options.map((o) => el('option', { value: o.code, selected: o.code === current }, o.name)),
    );
    const sync = () => {
        const g = options.find((o) => o.code === select.value)?.guidance;
        fill(hint, g ? el('span', { class: g.kind === 'redirect' ? 'warn-text' : '' }, g.text) : null);
        hint.dataset.kind = g?.kind ?? '';
    };
    select.addEventListener('change', () => {
        sync();
        onPick?.(select.value);
    });
    sync();
    return { node: [el('label', { for: id }, label), select, hint], select, sync };
}

/**
 * 匯出需求調查（DA-EXPORT-SURVEY；勾「需要匯出」才顯示）：目的、頻率（進申請內容，簽核人會看到）與方法（不進申請內容，
 * 選了就記成附屬的調查紀錄 data_access_export_method_record）。方法是介面串接、資料庫回傳 close_export 時取消「需要匯出」。
 * 要不要必填、要不要擋下都以資料庫為準。
 */
function surveyInputs(prefix, cat, base, exportBox) {
    const opts = cat.export_survey;
    const current = base.export_survey ?? {};
    const bound = { caseId: () => null, save: async () => {} };
    const purpose = surveySelect(`${prefix}-exp-purpose`, tx.survey.purpose, opts.purposes, current.purpose);
    const frequency = surveySelect(`${prefix}-exp-frequency`, tx.survey.frequency, opts.frequencies, current.frequency);
    const note = el('input', { id: `${prefix}-exp-method-note`, type: 'text' });
    const result = el('p', { class: 'muted', 'data-testid': 'export-method-result', 'aria-live': 'polite' });
    const record = async (method) => {
        if (!method) return;
        try {
            await bound.save();
            const r = await api.call('data_access_export_method_record', { case_id: bound.caseId(), method, note: note.value || null });
            fill(result, r.close_export ? el('span', { class: 'warn-text' }, tx.survey.closed) : tx.survey.recorded(r.method.name));
            result.dataset.method = r.method.code;
            if (r.close_export) {
                exportBox.checked = false;
                exportBox.dispatchEvent(new Event('change', { bubbles: true }));
            }
        } catch (err) {
            flash(explain(err));
        }
    };
    const method = surveySelect(`${prefix}-exp-method`, tx.survey.method, opts.methods, null, record);
    note.addEventListener('change', () => record(method.select.value));
    const description = el('textarea', { id: `${prefix}-exp-description`, rows: 2 }, current.description ?? '');
    const node = el(
        'fieldset',
        { class: 'export-survey', 'data-testid': 'export-survey' },
        el('legend', {}, tx.survey.legend),
        el('p', { class: 'muted' }, tx.survey.hint),
        purpose.node,
        frequency.node,
        el('label', { for: `${prefix}-exp-description` }, tx.survey.description),
        description,
        method.node,
        el('label', { for: `${prefix}-exp-method-note` }, tx.survey.methodNote),
        note,
        el('p', { class: 'muted' }, tx.survey.methodHint),
        result,
    );
    const sync = () => (node.hidden = !exportBox.checked);
    exportBox.addEventListener('change', sync);
    sync();
    return {
        node,
        value: () => ({ purpose: purpose.select.value || null, frequency: frequency.select.value || null, description: description.value }),
        /** 新申請畫面告訴編輯器：這張單是哪一張、怎麼先存（記錄方法前要先有草稿） */
        bind: (b) => Object.assign(bound, b),
        /** 修改既有的單：預選最新記錄的方法 */
        preset: (latest) => {
            if (!latest) return;
            method.select.value = latest.method;
            note.value = latest.note ?? '';
            method.sync();
            result.dataset.method = latest.method;
            fill(result, tx.survey.recorded(opts.methods.find((m) => m.code === latest.method)?.name ?? latest.method));
        },
    };
}

/** 環境的選項（資料庫的代碼表）：沒有選過就用資料庫標為預設的那一區。 */
function environmentInputs(prefix, cat, current) {
    const chosen = current ?? cat.environments.find((e) => e.is_default)?.code;
    return el(
        'fieldset',
        { class: 'environment', 'data-testid': 'environment' },
        el('legend', {}, tx.environmentLegend),
        cat.environments.map((e) =>
            el(
                'label',
                { class: 'choice', for: `${prefix}-env-${e.code}` },
                el('input', {
                    type: 'radio',
                    name: `${prefix}-env`,
                    id: `${prefix}-env-${e.code}`,
                    value: e.code,
                    checked: e.code === chosen,
                }),
                el(
                    'span',
                    {},
                    el('strong', {}, e.name),
                    el(
                        'small',
                        { class: 'muted' },
                        ` ${e.description}・${tx.environmentMax(e.max_months)}${e.requires_test_basis ? `・${tx.environmentNeedsBasis}` : ''}`,
                    ),
                ),
            ),
        ),
    );
}

/** 測試依據：可以引用的測試區單（資料庫給的清單）或「沒有測試紀錄」加理由。只在選的區要測試依據時顯示（代碼表的 requires_test_basis）。 */
function basisInputs(prefix, base) {
    const list = el('div', { 'data-testid': 'test-basis-list' });
    const reason = el('textarea', { id: `${prefix}-basis-reason`, rows: 2 }, base.test_exception?.reason ?? '');
    const reasonBlock = el(
        'div',
        { 'data-testid': 'test-basis-reason' },
        el('label', { for: `${prefix}-basis-reason` }, tx.basisReason),
        reason,
    );
    const box = el('fieldset', { class: 'test-basis', 'data-testid': 'test-basis' }, el('legend', {}, tx.basisLegend), list, reasonBlock);
    const radio = (value, label, checked) =>
        el(
            'label',
            { class: 'choice', for: `${prefix}-basis-${value}` },
            el('input', { type: 'radio', name: `${prefix}-basis`, id: `${prefix}-basis-${value}`, value, checked }),
            el('span', {}, label),
        );
    const picked = () => box.querySelector(`input[name=${prefix}-basis]:checked`)?.value ?? null;
    const sync = () => (reasonBlock.hidden = picked() !== 'none');
    box.addEventListener('change', sync);
    const setBases = (bases) => {
        const current = picked() ?? base.test_basis?.case_id ?? (base.test_exception ? 'none' : null);
        fill(
            list,
            bases.length ? null : el('p', { class: 'muted' }, tx.basisEmpty),
            ...bases.map((b) => radio(b.case_id, tx.basisOption(b), b.case_id === current)),
            radio('none', tx.basisNone, current === 'none' || (!bases.length && current === null)),
        );
        sync();
    };
    const value = () => {
        const p = picked();
        if (p === 'none') return { test_exception: { reason: reason.value } };
        return p ? { test_basis: { case_id: p } } : {};
    };
    setBases([]);
    return { node: box, setBases, value };
}

/**
 * 應用面（D94 (1) 的第六區塊，申請人填）：程式或報表、版本識別、結果給誰看、每個勾選的欄位的用途。
 * 欄位清單跟著「哪些資料」勾選的欄位重畫（refresh）；要不要必填由資料庫判定（正式區送審時）。
 */
function applicationInputs(prefix, cat, base) {
    const app = base.application ?? {};
    const input = (key, label) => [
        el('label', { for: `${prefix}-app-${key}` }, label),
        el('input', { id: `${prefix}-app-${key}`, type: 'text', value: app[key] ?? '' }),
    ];
    const uses = el('div', { 'data-testid': 'field-uses' });
    const kept = new Map((app.field_uses ?? []).map((u) => [`${u.package}.${u.field}`, u.use]));
    const refresh = (scope) => {
        for (const i of uses.querySelectorAll('input')) kept.set(i.dataset.key, i.value);
        fill(
            uses,
            ...scope.flatMap((s) =>
                s.fields.map((f) => {
                    const key = `${s.package}.${f}`;
                    const pkg = cat.packages.find((p) => p.code === s.package);
                    const name = `${pkg?.name ?? s.package}・${pkg?.fields.find((x) => x.code === f)?.name ?? f}`;
                    const id = `${prefix}-use-${s.package}-${f}`;
                    return el(
                        'div',
                        {},
                        el('label', { for: id }, tx.fieldUse(name)),
                        el('input', { id, type: 'text', value: kept.get(key) ?? '', 'data-key': key }),
                    );
                }),
            ),
        );
    };
    const node = el(
        'fieldset',
        { class: 'application', 'data-testid': 'application' },
        el('legend', {}, tx.applicationLegend),
        el('p', { class: 'muted' }, tx.applicationHint),
        input('program', tx.appProgram),
        input('version', tx.appVersion),
        input('audience', tx.appAudience),
        uses,
    );
    const value = () => ({
        program: node.querySelector(`#${prefix}-app-program`).value,
        version: node.querySelector(`#${prefix}-app-version`).value,
        audience: node.querySelector(`#${prefix}-app-audience`).value,
        field_uses: [...uses.querySelectorAll('input')].map((i) => {
            const [pkg, field] = i.dataset.key.split('.');
            return { package: pkg, field, use: i.value };
        }),
    });
    return { node, value, refresh };
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
    // 已經有內容、但沒有環境的是舊單：資料庫把它當成代碼表標 applies_to_legacy 的那一區
    const baseEnv = base.environment ?? (base.scope ? cat.environments.find((e) => e.applies_to_legacy)?.code : undefined);
    // 縮小時環境與測試依據不能改（換區、換依據都算擴大），沿用 base
    const env = limitTo ? null : environmentInputs(prefix, cat, baseEnv);
    const basis = limitTo ? null : basisInputs(prefix, base);
    const envOf = () => env?.querySelector(`input[name=${prefix}-env]:checked`)?.value ?? baseEnv;
    const syncBasis = () => {
        if (basis) basis.node.hidden = !cat.environments.find((e) => e.code === envOf())?.requires_test_basis;
    };
    env?.addEventListener('change', syncBasis);
    syncBasis();
    const scope = el(
        'div',
        { class: 'scope-part' },
        el('h3', {}, tx.scopeTitle),
        env,
        basis?.node,
        packages.map((p) => packageBlock(prefix, p, items.get(p.code), limits?.get(p.code))),
        periodInputs(prefix, base.data_period),
    );
    // 縮小時應用面沿用 base（改用途算擴大）
    const app = limitTo ? null : applicationInputs(prefix, cat, base);
    app?.refresh(readScope(scope));
    scope.addEventListener('change', () => app?.refresh(readScope(scope)));
    const exportChoice = showExport ? choice(`${prefix}-export`, tx.exportAsk, base.export_allowed === true) : null;
    // 縮小時調查沿用 base（不重新問）；新申請與修改時勾「需要匯出」就要填
    const survey = limitTo || !exportChoice ? null : surveyInputs(prefix, cat, base, exportChoice.querySelector('input'));
    const purpose = el(
        'div',
        { class: 'purpose-part' },
        limitTo ? null : purposeInputs(prefix, cat, base),
        exportChoice,
        survey?.node,
        app?.node,
    );
    const node = el('div', { class: 'scope-editor', 'data-testid': `${prefix}-editor` }, scope, purpose);
    const find = (sel) => scope.querySelector(sel) ?? purpose.querySelector(sel);
    const value = () => {
        const from = find(`#${prefix}-period-from`).value;
        const to = find(`#${prefix}-period-to`).value;
        const zone = limitTo
            ? { test_basis: base.test_basis ?? null, test_exception: base.test_exception ?? null }
            : basis.node.hidden
              ? {}
              : basis.value();
        return {
            ...(envOf() ? { environment: envOf() } : {}),
            ...zone,
            application: limitTo ? (base.application ?? null) : app.value(),
            scope: readScope(scope),
            data_period: from || to ? { from: from || null, to: to || null } : null,
            purpose_category: limitTo ? base.purpose_category : find(`#${prefix}-purpose`).value || null,
            purpose_description: limitTo ? base.purpose_description : find(`#${prefix}-purpose-text`).value,
            export_allowed: showExport ? find(`#${prefix}-export`).checked : false,
            ...surveyValue(),
        };
    };
    // 調查只在要匯出時送；縮小時沿用原本的（原本沒有就不送這個鍵：舊單不追加）
    const surveyValue = () => {
        if (!showExport || !find(`#${prefix}-export`).checked) return {};
        if (survey) return { export_survey: survey.value() };
        return base.export_survey ? { export_survey: base.export_survey } : {};
    };
    /** 可以引用的測試區單（被授權者換了就重讀；資料庫的 data_access_test_bases） */
    const setBases = (bases) => basis?.setBases(bases);
    return { node, value, setBases, survey, parts: { scope, purpose } };
}
