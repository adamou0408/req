// DC 自己的資料目錄：主題包 → 資料表、欄位 → 欄、列條件 → 欄。
// 資料目錄由平台維護（裁決 D92 (1)）：代碼、名稱、分級、列舉值的標籤、「代碼 → 實體資源」的對照都和平台的種子
// （db/seed/packs/data_access/010_catalog.sql）相同，兩邊用同一個演算法算出的目錄版本才一致（catalogVersion.ts）。
// 欄的型別是 DC 自己的事（不在平台的目錄裡）。主題包的資料表是 data.<代碼>，欄位的欄就是欄位代碼，列條件的欄見 column。

export type ColumnType = 'text' | 'numeric' | 'date';
export type FilterValueType = 'enum' | 'number' | 'date';

interface ColumnDef {
    readonly code: string;
    readonly name: string;
    readonly type: ColumnType;
    // 平台目錄上的分級；不是平台欄位（只用來放列條件的值）的欄是 null。
    readonly classification: 'L1' | 'L2' | 'L3' | 'L4' | null;
    // 這一欄在某一區已去識別或遮罩後的分級（平台目錄的 environments；D93 (2)）。測試區的資料表依它遮罩（seed.ts）
    readonly environments?: readonly ColumnEnvironment[];
}

export interface ColumnEnvironment {
    readonly environment: string;
    readonly treatment: 'deidentified' | 'masked';
    readonly classification: 'L1' | 'L2' | 'L3' | 'L4';
}

interface FilterDef {
    readonly code: string;
    readonly name: string;
    readonly valueType: FilterValueType;
    // 列條件判斷的是哪一欄
    readonly column: string;
    readonly values: readonly string[];
    // 列舉值在平台目錄上的標籤（目錄版本的雜湊涵蓋它）
    readonly labels: Readonly<Record<string, string>>;
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
const REGION_LABELS = { north: '北區', central: '中區', south: '南區', east: '東區' };

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
            {
                code: 'contact_phone',
                name: '聯絡人電話',
                type: 'text',
                classification: 'L4',
                environments: [{ environment: 'test', treatment: 'masked', classification: 'L3' }],
            },
            { code: 'industry', name: '產業別', type: 'text', classification: 'L1' },
            { code: 'region', name: '區域', type: 'text', classification: null },
        ],
        filters: [{ code: 'region', name: '區域', valueType: 'enum', column: 'region', values: REGIONS, labels: REGION_LABELS }],
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
            { code: 'region', name: '區域', valueType: 'enum', column: 'region', values: REGIONS, labels: REGION_LABELS },
            { code: 'order_amount', name: '訂單金額', valueType: 'number', column: 'amount', values: [], labels: {} },
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
                name: '產品線',
                valueType: 'enum',
                column: 'product_line',
                values: ['consumer', 'industrial', 'medical'],
                labels: { consumer: '消費性', industrial: '工業用', medical: '醫療用' },
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
            {
                code: 'bank_account',
                name: '薪轉帳號',
                type: 'text',
                classification: 'L4',
                environments: [{ environment: 'test', treatment: 'masked', classification: 'L3' }],
            },
            { code: 'pay_type', name: '薪資類別', type: 'text', classification: null },
        ],
        filters: [
            {
                code: 'pay_type',
                name: '薪資類別',
                valueType: 'enum',
                column: 'pay_type',
                values: ['monthly', 'bonus'],
                labels: { monthly: '月薪', bonus: '獎金' },
            },
        ],
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
