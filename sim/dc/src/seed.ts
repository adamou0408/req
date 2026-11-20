// 合成的示範資料（不是真實資料）。以固定種子產生，每次重建內容相同。
// 有資料期間的主題包每天、每個列條件值都有資料，因為平台的驗證案例會查「期間起日」與「起日前一天」
// 這種任意日期（02 §5.11），每個案例都要有對應的資料列，才分得出「被擋下」和「本來就沒有資料」。
import { createHash } from 'node:crypto';
import { PACKAGES, findPackage, type PackageDef } from './catalog.ts';
import { ident, type Db } from './db.ts';

type Row = Record<string, string | number>;

const FIRST_DAY = '2024-01-01';
const LAST_DAY = '2027-12-31';

function prng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function* days(from: string, to: string): Generator<string> {
    const d = new Date(`${from}T00:00:00Z`);
    const end = new Date(`${to}T00:00:00Z`);
    while (d <= end) {
        yield d.toISOString().slice(0, 10);
        d.setUTCDate(d.getUTCDate() + 1);
    }
}

function pad(n: number, width: number): string {
    return String(n).padStart(width, '0');
}

const REGIONS = ['north', 'central', 'south', 'east'];
const INDUSTRIES = ['製造業', '零售業', '金融業', '醫療業', '科技業'];
const CHANNELS = ['direct', 'distributor', 'online'];
const DEPARTMENTS = ['業務部', '財務部', '研發部', '製造部', '人資部'];

function customers(rand: () => number): Row[] {
    const rows: Row[] = [];
    for (let i = 1; i <= 240; i += 1) {
        rows.push({
            customer_id: `C${pad(i, 4)}`,
            customer_name: `示範客戶${pad(i, 4)}股份有限公司`,
            contract_end_date: `${2025 + (i % 4)}-${pad(1 + (i % 12), 2)}-${pad(1 + (i % 28), 2)}`,
            tax_id: pad(Math.floor(rand() * 1e8), 8),
            contact_phone: `09${pad(Math.floor(rand() * 1e8), 8)}`,
            industry: INDUSTRIES[i % INDUSTRIES.length] ?? '',
            region: REGIONS[i % REGIONS.length] ?? '',
        });
    }
    return rows;
}

function salesOrders(rand: () => number): Row[] {
    const rows: Row[] = [];
    for (const day of days(FIRST_DAY, LAST_DAY)) {
        REGIONS.forEach((region, r) => {
            const amount = Math.round(1000 + rand() * 499000);
            // 同區域的客戶：客戶編號 i 的區域是 REGIONS[i % 4]
            const k = Math.floor(rand() * 60);
            const customer = r === 0 ? 4 * (k + 1) : 4 * k + r;
            rows.push({
                order_no: `SO-${day.replaceAll('-', '')}-${r + 1}`,
                customer_id: `C${pad(customer, 4)}`,
                amount,
                order_date: day,
                gross_margin: Math.round(amount * (0.05 + rand() * 0.3)),
                channel: CHANNELS[Math.floor(rand() * CHANNELS.length)] ?? '',
                region,
            });
        });
    }
    return rows;
}

function productCosts(rand: () => number): Row[] {
    const rows: Row[] = [];
    const lines = ['consumer', 'industrial', 'medical'];
    for (const day of days(FIRST_DAY, LAST_DAY)) {
        lines.forEach((line, l) => {
            const material = Math.round(100 + rand() * 900);
            const labor = Math.round(50 + rand() * 400);
            const overhead = Math.round(20 + rand() * 200);
            const n = 1 + Math.floor(rand() * 20);
            rows.push({
                product_id: `P-${line.slice(0, 3).toUpperCase()}-${pad(n, 2)}`,
                product_name: `示範產品 ${l + 1}-${pad(n, 2)}`,
                cost_date: day,
                material_cost: material,
                labor_cost: labor,
                overhead_cost: overhead,
                unit_cost: material + labor + overhead,
                product_line: line,
            });
        });
    }
    return rows;
}

function payrolls(rand: () => number): Row[] {
    const rows: Row[] = [];
    const employees = Array.from({ length: 60 }, (_, i) => ({
        id: `E${pad(i + 1, 4)}`,
        department: DEPARTMENTS[i % DEPARTMENTS.length] ?? '',
        base: Math.round(32000 + rand() * 90000),
        account: `700-${pad(Math.floor(rand() * 1e10), 10)}`,
    }));
    for (const day of days(FIRST_DAY, LAST_DAY)) {
        // 每月 5 日發月薪，2 月與 7 月的 10 日發獎金
        const [, month, date] = day.split('-');
        const monthly = date === '05';
        const bonus = date === '10' && (month === '02' || month === '07');
        if (!monthly && !bonus) continue;
        for (const e of employees) {
            const bonusAmount = bonus ? Math.round(e.base * (0.5 + rand())) : 0;
            const gross = monthly ? e.base : bonusAmount;
            rows.push({
                employee_id: e.id,
                department: e.department,
                pay_date: day,
                base_salary: monthly ? e.base : 0,
                bonus: bonusAmount,
                net_pay: Math.round(gross * 0.88),
                bank_account: e.account,
                pay_type: monthly ? 'monthly' : 'bonus',
            });
        }
    }
    return rows;
}

const GENERATORS: Record<string, (rand: () => number) => Row[]> = {
    customer_master: customers,
    sales_order: salesOrders,
    product_cost: productCosts,
    payroll: payrolls,
};

function token(value: string): string {
    return `M${createHash('sha256').update(value).digest('hex').slice(0, 9)}`;
}

// 遮罩：L3、L4 的文字換成同值同代號（關聯還對得起來），數字加上雜訊；
// 列條件欄位與日期保留，條件與期間的行為才和正式資料相同。
function masked(pkg: PackageDef, row: Row, rand: () => number): Row {
    const out: Row = { ...row };
    for (const col of pkg.columns) {
        const v = row[col.code];
        if (v === undefined || col.classification === null || col.classification === 'L1' || col.classification === 'L2') {
            continue;
        }
        if (col.type === 'text') out[col.code] = token(String(v));
        if (col.type === 'numeric') out[col.code] = Math.round(Number(v) * (0.5 + rand()));
    }
    return out;
}

export function generateRows(packageCode: string, mask: boolean): Row[] {
    const pkg = findPackage(packageCode);
    const gen = GENERATORS[packageCode];
    if (pkg === undefined || gen === undefined) throw new Error(`沒有 ${packageCode} 的資料產生器`);
    const rows = gen(prng(packageCode.length * 7919));
    if (!mask) return rows;
    const noise = prng(4242);
    return rows.map((r) => masked(pkg, r, noise));
}

export async function loadSeed(db: Db, mask: boolean): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const pkg of PACKAGES) {
        const rows = generateRows(pkg.code, mask);
        const cols = pkg.columns.map((c) => ident(c.code)).join(', ');
        const types = pkg.columns.map((c) => `${ident(c.code)} ${c.type}`).join(', ');
        for (let i = 0; i < rows.length; i += 2000) {
            await db.query(
                `insert into data.${ident(pkg.code)} (${cols}) select ${cols} from jsonb_to_recordset($1::jsonb) as t (${types})`,
                [JSON.stringify(rows.slice(i, i + 2000))],
            );
        }
        counts[pkg.code] = rows.length;
    }
    return counts;
}
