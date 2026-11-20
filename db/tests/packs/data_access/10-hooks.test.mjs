// 資料授權的 hook：整理內容、分級、比較兩版、這一關涉及的範圍（契約 §5 的範例）。直接呼叫 pack_data_access 的 function。
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { closePools, one, pool } from '../../kernel/lib/harness.mjs';

const admin = pool('ADMIN');
after(closePools);

const normalize = async (content) => (await one(admin, 'select pack_data_access.normalize_content($1) as r', [content])).r;
const classify = async (content) => (await one(admin, 'select pack_data_access.classify_tier($1) as r', [content])).r;
const compare = async (oldContent, newContent) =>
    (await one(admin, 'select pack_data_access.compare_content($1, $2) as r', [oldContent, newContent])).r;
const codes = (list) => list.map((x) => x.code);

test('DA-TIER-AUTO-GRANT L1 欄位自動從單上移除並提示；欄位可以用字串輸入；整理兩次結果相同', async () => {
    const r = await normalize({
        scope: [{ package: 'customer_master', fields: ['customer_id', 'customer_name', 'industry'], row_filters: [] }],
        purpose_category: 'reporting',
        purpose_description: '  每月客戶報表  ',
        export_allowed: false,
    });
    assert.deepEqual(r.content.scope[0].fields, [
        { code: 'customer_id', classification: 'L3' },
        { code: 'customer_name', classification: 'L3' },
    ]);
    assert.deepEqual(r.notices, [
        { code: 'DA-N-AUTO-GRANTED', message: '「客戶主檔」的「產業別」是 L1 欄位，不需要申請，已自動從這張單移除。' },
    ]);
    assert.equal(r.content.purpose_description, '每月客戶報表');
    const again = await normalize(r.content);
    assert.deepEqual(again.content, r.content);
    assert.deepEqual(again.notices, []);
});

test('DA-TIER-AUTO-GRANT 選到的欄位全部是 L1、L2：主題包被移除、資料範圍變空，送審前的錯誤擋下', async () => {
    const r = await normalize({ scope: [{ package: 'sales_order', fields: ['channel'] }], purpose_category: 'reporting' });
    assert.deepEqual(r.content.scope, []);
    assert.deepEqual(codes(r.notices), ['DA-N-AUTO-GRANTED', 'DA-N-PACKAGE-EMPTY']);
    assert.deepEqual(codes(r.errors), ['DA-E-SCOPE-EMPTY']);
});

test('DA-NO-MEDIUM 內容只留資料範圍、資料期間、使用情境、可否匯出；媒介等其他鍵不記錄', async () => {
    const r = await normalize({ scope: [], medium: 'BI', tool: 'agent', purpose_category: 'reporting' });
    assert.deepEqual(Object.keys(r.content).sort(), ['data_period', 'export_allowed', 'purpose_category', 'purpose_description', 'scope']);
});

test('DA-SCOPE-STRUCTURED 列條件改成唯一的寫法（eq → in／between），去重排序；同一主題包合併；目錄上沒有的主題包與欄位移除', async () => {
    const r = await normalize({
        scope: [
            { package: 'vendor_master', fields: ['vendor_id'] },
            {
                package: 'sales_order',
                fields: ['order_no', 'discount'],
                row_filters: [{ filter: 'order_amount', op: 'eq', values: [100000] }],
            },
            {
                package: 'sales_order',
                fields: ['amount'],
                row_filters: [{ filter: 'region', op: 'in', values: ['north', 'central', 'north'] }],
            },
        ],
        data_period: { from: '2025-01-01', to: '2025-12-31' },
        purpose_category: 'reporting',
    });
    assert.deepEqual(r.content.scope, [
        {
            package: 'sales_order',
            fields: [
                { code: 'amount', classification: 'L3' },
                { code: 'order_no', classification: 'L3' },
            ],
            row_filters: [
                { filter: 'order_amount', op: 'between', values: [100000, 100000] },
                { filter: 'region', op: 'in', values: ['central', 'north'] },
            ],
        },
    ]);
    assert.deepEqual(codes(r.notices), ['DA-N-FIELD-UNAVAILABLE', 'DA-N-PACKAGE-UNAVAILABLE']);
    assert.deepEqual(r.errors, []);
});

test('DA-SCOPE-STRUCTURED 列條件只能用目錄上的欄位與值：不認得的欄位、值域外的值、錯的條件寫法、重複的欄位都是錯誤', async () => {
    const r = await normalize({
        scope: [
            {
                package: 'sales_order',
                fields: ['order_no'],
                row_filters: [
                    { filter: 'order_amount', op: 'between', values: [500000, 100000] },
                    { filter: 'region', op: 'in', values: ['north', 'west'] },
                    { filter: 'warehouse', op: 'in', values: ['a'] },
                    { filter: 'region', op: 'in', values: ['south'] },
                ],
            },
            { package: 'customer_master', fields: ['customer_id'], row_filters: [{ filter: 'region', op: 'like', values: ['n%'] }] },
        ],
        data_period: { from: '2025-01-01', to: '2025-12-31' },
        purpose_category: 'reporting',
    });
    assert.deepEqual(
        r.errors.map((e) => [e.path, e.code]),
        [
            ['scope[0].row_filters[0].op', 'DA-E-FILTER-OP'],
            ['scope[1].row_filters[0].values', 'DA-E-FILTER-VALUE'],
            ['scope[1].row_filters[1].values', 'DA-E-FILTER-VALUE'],
            ['scope[1].row_filters[2].filter', 'DA-E-FILTER-DUPLICATE'],
            ['scope[1].row_filters[3].filter', 'DA-E-FILTER-UNKNOWN'],
        ],
    );
    assert.equal(r.errors[1].message, '「訂單金額」的條件不正確：下限不能大於上限。');
    assert.equal(r.errors[2].message, '「區域」的條件不正確：值 west 不在可選的清單裡。');
});

test('DA-TIER-MAX 級別取所有欄位的最高分級；跨主題包也取最高；無法判定時從嚴', async () => {
    const field = (code, classification) => ({ code, classification });
    assert.equal(await classify({ scope: [{ package: 'customer_master', fields: [field('customer_id', 'L3')] }] }), 'L3');
    assert.equal(
        await classify({ scope: [{ package: 'sales_order', fields: [field('amount', 'L3'), field('gross_margin', 'L4')] }] }),
        'L4',
    );
    assert.equal(
        await classify({
            scope: [
                { package: 'customer_master', fields: [field('customer_id', 'L3')] },
                { package: 'payroll', fields: [field('net_pay', 'L4')] },
            ],
        }),
        'L4',
    );
    assert.equal(await classify({ scope: [] }), 'L3');
    assert.equal(await classify({ scope: [{ package: 'sales_order', fields: ['gross_margin'] }] }), 'L4');
});

test('DA-EXPORT-TIER L4 不能申請匯出：要求匯出時改為只能查詢並提示；L3 可以匯出', async () => {
    const l4 = await normalize({
        scope: [{ package: 'sales_order', fields: ['order_no', 'gross_margin'] }],
        data_period: { from: '2025-01-01', to: '2025-12-31' },
        purpose_category: 'reporting',
        export_allowed: true,
    });
    assert.equal(l4.content.export_allowed, false);
    assert.deepEqual(l4.notices, [{ code: 'DA-N-EXPORT-FORCED', message: '這張單包含 L4 資料，L4 資料不可匯出，已改為只能查詢。' }]);
    const l3 = await normalize({
        scope: [{ package: 'customer_master', fields: ['customer_id'] }],
        purpose_category: 'reporting',
        export_allowed: true,
    });
    assert.equal(l3.content.export_allowed, true);
    assert.deepEqual(l3.notices, []);
    const setting = await one(admin, `select sgn_internal.setting('data_access.export_requestable', array['tier:data_access:L4']) as v`);
    assert.equal(setting.v, false);
});

test('DA-DATA-PERIOD 選到有期間欄位的主題包時必填資料期間；沒有期間欄位的主題包不需要；起日不能晚於迄日', async () => {
    const base = { purpose_category: 'reporting' };
    const missing = await normalize({ ...base, scope: [{ package: 'sales_order', fields: ['order_no'] }] });
    assert.deepEqual(codes(missing.errors), ['DA-E-PERIOD-REQUIRED']);
    const none = await normalize({ ...base, scope: [{ package: 'customer_master', fields: ['customer_id'] }] });
    assert.deepEqual(none.errors, []);
    const order = await normalize({
        ...base,
        scope: [{ package: 'sales_order', fields: ['order_no'] }],
        data_period: { from: '2025-12-31', to: '2025-01-01' },
    });
    assert.deepEqual(codes(order.errors), ['DA-E-PERIOD-ORDER']);
});

test('DA-PURPOSE 使用情境要選分類；選「其他（需說明）」必須填說明', async () => {
    const scope = [{ package: 'customer_master', fields: ['customer_id'] }];
    assert.deepEqual(codes((await normalize({ scope, purpose_category: 'nonsense' })).errors), ['DA-E-PURPOSE-CATEGORY']);
    const other = await normalize({ scope, purpose_category: 'other', purpose_description: '  ' });
    assert.deepEqual(other.errors, [
        { path: 'purpose_description', code: 'DA-E-PURPOSE-DESCRIPTION', message: '選擇「其他（需說明）」時，請填寫使用情境說明。' },
    ]);
    assert.deepEqual((await normalize({ scope, purpose_category: 'other', purpose_description: '臨時查核' })).errors, []);
});

test('DA-STAGE-OWNER 資料擁有者關的範圍是每個主題包；主題包沒有在職的擁有者就不能送審', async () => {
    const content = { scope: [{ package: 'sales_order' }, { package: 'customer_master' }, { package: 'sales_order' }] };
    const { rows } = await admin.query(`select pack_data_access.stage_scopes('data_owner', $1) as s order by 1`, [content]);
    assert.deepEqual(
        rows.map((r) => r.s),
        ['data_access:bundle:customer_master', 'data_access:bundle:sales_order'],
    );
    const fulfil = await admin.query(`select pack_data_access.stage_scopes('fulfil', $1) as s`, [{ scope: [{ package: 'payroll' }] }]);
    assert.deepEqual(
        fulfil.rows.map((r) => r.s),
        ['system:hr_saas'],
    );
    // 讓員工薪資暫時沒有擁有者（測試用的管理者連線），送審前的錯誤出現；之後恢復
    const ended = await admin.query(
        `update sgn.role_assignment set valid_to = clock_timestamp()
         where role_code = 'data_owner' and scope_ref = 'data_access:bundle:payroll' and valid_to is null returning *`,
    );
    try {
        const r = await normalize({
            scope: [{ package: 'payroll', fields: ['employee_id'] }],
            data_period: { from: '2026-01-01', to: '2026-06-30' },
            purpose_category: 'reporting',
        });
        assert.deepEqual(r.errors, [
            {
                path: 'scope[0].package',
                code: 'DA-E-OWNER-MISSING',
                message: '「員工薪資」目前沒有在職的資料擁有者，無法送審，請聯絡 MIS。',
            },
        ]);
    } finally {
        for (const a of ended.rows) {
            await admin.query(
                `insert into sgn.role_assignment (person_id, role_code, valid_from, scope_ref, source) values ($1, $2, clock_timestamp(), $3, $4)`,
                [a.person_id, a.role_code, a.scope_ref, a.source],
            );
        }
    }
});

// 契約 §5.4 的基準內容
const field = (code) => ({ code, classification: 'L3' });
const BASE = {
    scope: [
        {
            package: 'customer_master',
            fields: [field('contract_end_date'), field('customer_id'), field('customer_name')],
            row_filters: [{ filter: 'region', op: 'in', values: ['central', 'north'] }],
        },
        {
            package: 'sales_order',
            fields: [field('amount'), field('customer_id'), field('order_date'), field('order_no')],
            row_filters: [{ filter: 'region', op: 'in', values: ['central', 'north'] }],
        },
    ],
    data_period: { from: '2025-01-01', to: '2026-12-31' },
    purpose_category: 'reporting',
    purpose_description: '通路業務組每月檢視客戶與訂單',
    export_allowed: false,
};
const edit = (fn) => {
    const c = structuredClone(BASE);
    fn(c);
    return c;
};
const sales = (c) => c.scope[1];
const withAmountFilter = edit((c) => sales(c).row_filters.push({ filter: 'order_amount', op: 'between', values: [0, 100000] }));

test('DA-CHANGE-COMPARE 縮小：欄位子集、列條件更嚴、期間在原範圍內、移除主題包、新增列條件、可匯出改為只能查詢', async () => {
    assert.equal(await compare(BASE, BASE), 'same');
    const reduced = edit((c) => {
        sales(c).fields = sales(c).fields.filter((f) => f.code !== 'order_date');
        sales(c).row_filters = [{ filter: 'region', op: 'in', values: ['north'] }];
        c.data_period = { from: '2025-01-01', to: '2025-12-31' };
    });
    assert.equal(await compare(BASE, reduced), 'reduce');
    assert.equal(
        await compare(
            BASE,
            edit((c) => c.scope.shift()),
        ),
        'reduce',
    );
    assert.equal(await compare(BASE, withAmountFilter), 'reduce');
    assert.equal(
        await compare(
            edit((c) => (c.export_allowed = true)),
            BASE,
        ),
        'reduce',
    );
});

test('DA-CHANGE-COMPARE 擴大或無法判定：多了值、上限變無界、拿掉條件、期間超出、要求匯出、分級變動、有縮有擴、無法辨識的條件、拿掉資料期間', async () => {
    const cases = [
        edit((c) => (c.scope[0].row_filters = [{ filter: 'region', op: 'in', values: ['central', 'north', 'south'] }])),
        edit((c) => (c.data_period = { from: '2025-01-01', to: '2027-01-01' })),
        edit((c) => (c.export_allowed = true)),
        edit((c) => (sales(c).fields[0] = { code: 'amount', classification: 'L4' })),
        edit((c) => {
            sales(c).fields = sales(c).fields.filter((f) => f.code !== 'order_date');
            sales(c).fields.push({ code: 'gross_margin', classification: 'L4' });
        }),
        edit((c) => (sales(c).row_filters = [{ filter: 'region', op: 'like', values: ['n%'] }])),
        edit((c) => (c.data_period = null)),
    ];
    for (const changed of cases) assert.equal(await compare(BASE, changed), 'expand', JSON.stringify(changed));
    const unbounded = structuredClone(withAmountFilter);
    sales(unbounded).row_filters[1].values = [0, null];
    assert.equal(await compare(withAmountFilter, unbounded), 'expand');
    assert.equal(await compare(withAmountFilter, BASE), 'expand');
});

test('DA-CHANGE-PURPOSE 修改使用情境（分類或說明）算擴大', async () => {
    assert.equal(
        await compare(
            BASE,
            edit((c) => (c.purpose_description = '改為每週檢視')),
        ),
        'expand',
    );
    assert.equal(
        await compare(
            BASE,
            edit((c) => (c.purpose_category = 'development')),
        ),
        'expand',
    );
});
