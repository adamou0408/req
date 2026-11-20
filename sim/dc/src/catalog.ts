// DC 自己的資料目錄：主題包 → 資料表、欄位 → 欄、列條件 → 欄。
// 代碼與平台的資料目錄種子（db/seed/packs/data_access/010_catalog.sql）相同，
// 因為平台的契約假設「主題包、欄位、列條件欄位的代碼就是 DC 資料目錄上的代碼」（02 §8.1）。
// 平台的目錄只有代碼與分級；資料表結構（欄的型別、列條件落在哪一欄）是 DC 自己的事，所以在這裡定義。

export type ColumnType = 'text' | 'numeric' | 'date';
export type FilterValueType = 'enum' | 'number' | 'date';

export interface ColumnDef {
    readonly code: string;
    readonly name: string;
    readonly type: ColumnType;
    // 平台目錄上的分級；不是平台欄位（只用來放列條件的值）的欄是 null。
    readonly classification: 'L1' | 'L2' | 'L3' | 'L4' | null;
}

export interface FilterDef {
    readonly code: string;
    readonly valueType: FilterValueType;
    // 列條件判斷的是哪一欄
    readonly column: string;
    readonly values: readonly string[];
}

export interface PackageDef {
    readonly code: string;
    readonly name: string;
    readonly system: string;
    readonly periodField: string | null;
    readonly columns: readonly ColumnDef[];
    readonly filters: readonly FilterDef[];
}

const REGIONS = ['north', 'central', 'south', 'east'] as const;

export const PACKAGES: readonly PackageDef[] = [
    {
        code: 'customer_master',
        name: '客戶主檔',
        system: 'dc',
        periodField: null,
        columns: [
            { code: 'customer_id', name: '客戶編號', type: 'text', classification: 'L3' },
            { code: 'customer_name', name: '客戶名稱', type: 'text', classification: 'L3' },
            { code: 'contract_end_date', name: '合約到期日', type: 'date', classification: 'L3' },
            { code: 'tax_id', name: '統一編號', type: 'text', classification: 'L4' },
            { code: 'contact_phone', name: '聯絡人電話', type: 'text', classification: 'L4' },
            { code: 'industry', name: '產業別', type: 'text', classification: 'L1' },
            { code: 'region', name: '區域', type: 'text', classification: null },
        ],
        filters: [{ code: 'region', valueType: 'enum', column: 'region', values: REGIONS }],
    },
    {
        code: 'sales_order',
        name: '銷售訂單',
        system: 'dc',
        periodField: 'order_date',
        columns: [
            { code: 'order_no', name: '訂單編號', type: 'text', classification: 'L3' },
            { code: 'customer_id', name: '客戶編號', type: 'text', classification: 'L3' },
            { code: 'amount', name: '訂單金額', type: 'numeric', classification: 'L3' },
            { code: 'order_date', name: '訂單日期', type: 'date', classification: 'L3' },
            { code: 'gross_margin', name: '毛利', type: 'numeric', classification: 'L4' },
            { code: 'channel', name: '通路別', type: 'text', classification: 'L2' },
            { code: 'region', name: '區域', type: 'text', classification: null },
        ],
        filters: [
            { code: 'region', valueType: 'enum', column: 'region', values: REGIONS },
            { code: 'order_amount', valueType: 'number', column: 'amount', values: [] },
        ],
    },
    {
        code: 'product_cost',
        name: '產品成本明細',
        system: 'dc',
        periodField: 'cost_date',
        columns: [
            { code: 'product_id', name: '產品編號', type: 'text', classification: 'L3' },
            { code: 'product_name', name: '產品名稱', type: 'text', classification: 'L2' },
            { code: 'cost_date', name: '成本日期', type: 'date', classification: 'L3' },
            { code: 'material_cost', name: '材料成本', type: 'numeric', classification: 'L4' },
            { code: 'labor_cost', name: '人工成本', type: 'numeric', classification: 'L4' },
            { code: 'overhead_cost', name: '製造費用', type: 'numeric', classification: 'L4' },
            { code: 'unit_cost', name: '單位成本', type: 'numeric', classification: 'L4' },
            { code: 'product_line', name: '產品線', type: 'text', classification: null },
        ],
        filters: [
            {
                code: 'product_line',
                valueType: 'enum',
                column: 'product_line',
                values: ['consumer', 'industrial', 'medical'],
            },
        ],
    },
    {
        code: 'payroll',
        name: '員工薪資',
        system: 'hr_saas',
        periodField: 'pay_date',
        columns: [
            { code: 'employee_id', name: '員工編號', type: 'text', classification: 'L3' },
            { code: 'department', name: '部門', type: 'text', classification: 'L2' },
            { code: 'pay_date', name: '發薪日', type: 'date', classification: 'L3' },
            { code: 'base_salary', name: '本薪', type: 'numeric', classification: 'L4' },
            { code: 'bonus', name: '獎金', type: 'numeric', classification: 'L4' },
            { code: 'net_pay', name: '實發金額', type: 'numeric', classification: 'L4' },
            { code: 'bank_account', name: '薪轉帳號', type: 'text', classification: 'L4' },
            { code: 'pay_type', name: '薪資類別', type: 'text', classification: null },
        ],
        filters: [{ code: 'pay_type', valueType: 'enum', column: 'pay_type', values: ['monthly', 'bonus'] }],
    },
];

// 每張表都有的技術鍵：測試查詢用它指定「要查哪幾列」，所以每個被授權者都拿得到它。
// 它不帶業務內容，不是平台目錄上的欄位，對帳也不回報它。
export const ROW_ID = 'row_id';

export function findPackage(code: string): PackageDef | undefined {
    return PACKAGES.find((p) => p.code === code);
}

export function findColumn(pkg: PackageDef, code: string): ColumnDef | undefined {
    return pkg.columns.find((c) => c.code === code);
}

export function findFilter(pkg: PackageDef, code: string): FilterDef | undefined {
    return pkg.filters.find((f) => f.code === code);
}
