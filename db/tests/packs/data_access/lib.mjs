// 資料授權流程包的測試共用：今天的日期、被授權者、決定、內容範本。
import { call, decidePasskey, issueChallenge } from '../../kernel/lib/harness.mjs';

export const DA = 'data_access';

/**
 * 營業日的時區：必須等於資料庫的參數 calendar.timezone（業務日的唯一入口 sgn_internal.today() 用它）。
 * 這個檔案也被紅隊腳本匯入，不能在匯入時連資料庫，所以寫成常數；`89-business-day` 檢查它和資料庫的參數一致、
 * today() 和 sgn_internal.today() 是同一天。資料庫端的測試準備一律用 sgn_internal.today()，不用 current_date。
 */
export const BUSINESS_TIMEZONE = 'Asia/Taipei';

/** 營業日期（YYYY-MM-DD），可加減天數。 */
export function today(offsetDays = 0) {
    const d = new Date(Date.now() + offsetDays * 86400000);
    return new Intl.DateTimeFormat('en-CA', { timeZone: BUSINESS_TIMEZONE }).format(d);
}

/** YYYY-MM-DD 加幾個月再加幾天（UTC 計算，日期字串不受時區影響）。 */
export function addMonths(date, months, days = 0) {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + months);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

export async function principals(app, session) {
    const list = await call(app, 'principal_list', session);
    return Object.fromEntries(list.map((p) => [p.name, p.principal_id]));
}

/** 預設兩個月：沒有指定環境的申請以測試區處理（DA-ENV-FIELD），測試區的期限上限較短（DA-ENV-VALIDITY，初始值 3 個月）。 */
export function terms(principalId, months = 2, from = today()) {
    return { principal_id: principalId, valid_from: from, valid_to: addMonths(from, months) };
}

export async function decide(app, user, caseId, decision = 'approve', input = {}) {
    const ch = await issueChallenge(app, user, caseId, decision, input);
    return decidePasskey(app, ch.challenge_id, decision, user.key.assert(ch.challenge));
}

/** L3：客戶主檔兩個欄位（北、中區）＋銷售訂單三個欄位（北區、2025 年）。測試區（DA-ENV-FIELD；正式區見 prod()）。 */
export function l3Content(overrides = {}) {
    return {
        environment: 'test',
        scope: [
            {
                package: 'customer_master',
                fields: ['customer_id', 'customer_name'],
                row_filters: [{ filter: 'region', op: 'in', values: ['north', 'central'] }],
            },
            {
                package: 'sales_order',
                fields: ['order_no', 'amount', 'order_date'],
                row_filters: [{ filter: 'region', op: 'in', values: ['north'] }],
            },
        ],
        data_period: { from: '2025-01-01', to: '2025-12-31' },
        purpose_category: 'reporting',
        purpose_description: '通路業務組每月檢視客戶與訂單',
        export_allowed: false,
        ...overrides,
    };
}

/** 正式區要寫的應用面（DA-TEST-REPORT）。 */
export const application = (version = 'report@1.0.0') => ({ program: '月報', version, audience: '業務主管', field_uses: [] });

/** 正式區的申請（DA-ENV-TEST-BASIS）：沒有可以引用的測試區單時填理由（送審後開例外 DA-TEST-EXCEPTION）。 */
export function prod(content, reason = '測試：沒有測試區的紀錄') {
    return { ...content, environment: 'prod', test_exception: { reason }, application: application() };
}

/** L4：員工薪資（實發金額是 L4）。測試區。 */
export function l4Content(overrides = {}) {
    return {
        environment: 'test',
        scope: [{ package: 'payroll', fields: ['employee_id', 'net_pay', 'pay_date'], row_filters: [] }],
        data_period: { from: '2026-01-01', to: '2026-12-31' },
        purpose_category: 'operations',
        purpose_description: '應付帳款對帳',
        export_allowed: false,
        ...overrides,
    };
}
