// 交付 port 的合約測試（工程規範第 5 節：每個 port 的模擬 adapter 與真實 adapter 跑同一份）：
// api/src/dcMock.ts（模擬）與 api/src/dcHttp.ts（HTTP，對著 sim/dc：把規則套用成真正資料庫權限的 DC 模擬器）。
// 本文是外部系統交付介面的信封（sgn_internal.delivery_envelope），由資料庫簽章（sgn_internal.delivery_sign，以 owner 執行；
// 正式流程只在交付程式的領取入口裡簽）。外部系統的回應交給資料庫分類（sgn_internal.delivery_verdict：驗外部系統的證明），
// 斷言的是平台會怎麼判斷，不只是 HTTP 狀態。http 對著 sim/dc 的 unit 實例（sgn_test 專用，和端對端的 main 分開）。
import assert from 'node:assert/strict';
import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';
import { after, before, test } from 'node:test';
import { dcHttpDelivery, dcHttpReconciliation } from '../../../api/src/dcHttp.ts';
import { CONTEXT, mockDc } from '../packs/data_access/delivery-lib.mjs';
import { today } from '../packs/data_access/lib.mjs';
import { closePools, config, one, pool, rejectsWith } from './lib/harness.mjs';

const admin = pool('ADMIN');
const base = `http://${config.dc.SIM_DC_HOST}:${config.dc.SIM_DC_PORT}/v1`;
const adapters = {};
const audit = dcHttpReconciliation({ base, key: config.dc.SIM_DC_KEY_AUDITOR, timeoutMs: 10000 });

before(async () => {
    adapters.mock = await mockDc(admin);
    adapters.http = dcHttpDelivery({ base, key: config.dc.SIM_DC_KEY_PLATFORM, timeoutMs: 10000 });
});
// 合約測試留下的規則清掉（unit 實例只給資料庫測試用；之後的測試從乾淨的外部系統開始）
after(async () => {
    await fetch(`${base}/admin/reset`, {
        method: 'POST',
        headers: { authorization: `Bearer ${config.dc.SIM_DC_KEY_ADMIN}`, 'content-type': 'application/json' },
        body: '{}',
    });
    await closePools();
});

const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

function ruleSet(
    caseNo,
    version,
    { valid = { from: today(), to: addDays(today(), 30) }, fields = ['amount', 'order_date', 'order_no'], principal = randomUUID() } = {},
) {
    return {
        format: 'data_access_rule_set/1',
        case_no: caseNo,
        case_version_no: version,
        grantee: { type: 'team', principal_id: principal, name: '合約測試' },
        valid,
        export: false,
        rules: [
            {
                rule_id: `${caseNo}-1`,
                system: 'dc',
                package: 'sales_order',
                fields,
                row_filter: [{ filter: 'region', op: 'in', values: ['central', 'north'] }],
                data_period: { field: 'order_date', from: '2025-01-01', to: '2025-12-31' },
            },
        ],
    };
}

/**
 * 一筆交付：方法與路徑由資料庫決定（delivery_target）；套用與撤回的本文是資料庫產生的信封、由資料庫簽章，其他是 JSON 原樣。
 * ttl：信封幾秒後失效（負的＝已過期）。
 */
async function item(kind, caseNo, payload, { sign = kind === 'apply' || kind === 'withdraw', ttl = 300 } = {}) {
    const t = await one(admin, 'select * from sgn_internal.delivery_target($1, $2)', [kind, caseNo]);
    const text = sign
        ? (
              await one(
                  admin,
                  `select sgn_internal.delivery_envelope('dc', $1::text, $2::text, $3::jsonb, now() + make_interval(secs => $4::int)) as t`,
                  [t.method, t.path, payload, ttl],
              )
          ).t
        : JSON.stringify(payload);
    const signature = sign
        ? (await one(admin, 'select sgn_internal.delivery_sign($1, $2) - $3::text as s', [CONTEXT, text, 'context'])).s
        : null;
    return {
        op_id: 0,
        lease_token: randomUUID(),
        kind,
        request_id: payload.request_id ?? randomUUID(),
        case_no: caseNo,
        method: t.method,
        path: t.path,
        nonce: randomBytes(18).toString('hex'),
        body: text,
        signature,
    };
}
// RFC 8032 第 7.1 節的測試向量 1–3（私鑰種子、公鑰、訊息、簽章）
const RFC8032 = [
    [
        '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
        'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
        '',
        'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
    ],
    [
        '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb',
        '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c',
        '72',
        '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00',
    ],
    [
        'c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7',
        'fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025',
        'af82',
        '6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a',
    ],
];

test('K-DELIVERY-SIGNED Ed25519（純 PL/pgSQL）：公鑰與簽章和 RFC 8032 的測試向量逐位元組相同；任意訊息的簽章 Node 的 crypto 驗得過', async () => {
    for (const [seed, pub, msg, sig] of RFC8032) {
        const r = await one(
            admin,
            `select encode(sgn_internal.ed25519_public_key(decode($1, 'hex')), 'hex') as pub,
                    encode(sgn_internal.ed25519_sign(decode($1, 'hex'), decode($2, 'hex'), decode($3, 'hex')), 'hex') as sig`,
            [seed, pub, msg],
        );
        assert.deepEqual([r.pub, r.sig], [pub, sig]);
    }
    for (let i = 0; i < 5; i += 1) {
        const seed = randomBytes(32).toString('hex');
        const msg = randomBytes(1 + i * 40);
        const r = await one(
            admin,
            `select sgn_internal.ed25519_public_key(decode($1, 'hex')) as pub,
                    sgn_internal.ed25519_sign(decode($1, 'hex'), sgn_internal.ed25519_public_key(decode($1, 'hex')), $2) as sig,
                    sgn_internal.ed25519_spki_pem(sgn_internal.ed25519_public_key(decode($1, 'hex'))) as pem`,
            [seed, msg],
        );
        const key = createPublicKey(r.pem);
        assert.deepEqual(key.export({ format: 'der', type: 'spki' }).subarray(12), r.pub);
        assert.ok(verify(null, msg, key, r.sig));
    }
});

/** 平台怎麼判斷這筆的回應（驗外部系統的證明：方法、路徑、送出位元組的摘要、這筆的一次性亂數）。 */
const verdict = async (it, outcome) =>
    (
        await one(admin, `select sgn_internal.delivery_verdict('dc', $1::text, $2::jsonb, $3::jsonb) as v`, [
            it.kind,
            { method: it.method, path: it.path, request_sha256: createHash('sha256').update(it.body).digest('hex'), nonce: it.nonce },
            outcome,
        ])
    ).v;
const classify = async (it, outcome) => (await verdict(it, outcome)).class;
const caseNo = (name) => `CT-${name}-${randomUUID().slice(0, 8)}`;

for (const name of ['mock', 'http']) {
    test(`K-DELIVERY-SIGNED 合約（${name}）：套用與撤回要資料庫的簽章，簽的就是送出的位元組；沒簽章、本文被改、只改空白都被拒絕（平台判為 reject）`, async () => {
        const port = adapters[name];
        const no = caseNo('sig');
        const good = await item('apply', no, ruleSet(no, 1));
        const unsigned = { ...good, signature: null };
        const tampered = { ...good, body: good.body.replace('"north"', '"south"') };
        const spaced = { ...good, body: good.body.replace(':', ': ') };
        for (const bad of [unsigned, tampered, spaced]) {
            const outcome = await port.send(bad);
            assert.equal(outcome.http_status, 401);
            assert.equal(await classify(bad, outcome), 'reject');
        }
        const outcome = await port.send(good);
        assert.equal(outcome.http_status, 200);
        assert.equal(await classify(good, outcome), 'succeed');
        const forged = { ...(await item('withdraw', no, { request_id: randomUUID(), case_no: no })), signature: good.signature };
        assert.equal((await port.send(forged)).http_status, 401, '撤回也要簽章，不能拿別的簽章充數');
    });

    test(`K-VERIFY-AUTO 合約（${name}）：流程包產生的驗證案例，在外部系統上實際查詢的結果都等於預期（範圍內允許、範圍外拒絕）；撤回後範圍內也查不到`, async () => {
        const port = adapters[name];
        const no = caseNo('verify');
        const rs = ruleSet(no, 1);
        const applied = await item('apply', no, rs);
        assert.equal(await classify(applied, await port.send(applied)), 'succeed');
        const cases = (await one(admin, 'select pack_data_access.build_verification_cases(gen_random_uuid(), $1) as c', [rs])).c;
        assert.deepEqual(
            cases.map((c) => c.code),
            [
                'sales_order:in',
                'sales_order:row:region',
                'sales_order:field',
                'sales_order:period',
                'request:export',
                'request:after_validity',
            ],
        );
        const request = {
            request_id: randomUUID(),
            run_id: 1,
            rule_set: rs,
            cases: cases.map(({ code, expected, query }) => ({ code, expected, query })),
        };
        const verifyItem = await item('verify', no, request);
        const verified = await port.send(verifyItem);
        assert.equal(await classify(verifyItem, verified), 'succeed');
        const mismatches = (
            await one(admin, 'select sgn_internal.verification_mismatches($1, $2) as m', [
                JSON.stringify(cases),
                JSON.stringify(verified.response.results),
            ])
        ).m;
        assert.deepEqual(mismatches, []);
        const wd = await item('withdraw', no, { request_id: randomUUID(), case_no: no });
        assert.equal(await classify(wd, await port.send(wd)), 'succeed');
        const afterWithdraw = await port.send(await item('verify', no, { ...request, request_id: randomUUID() }));
        assert.equal(afterWithdraw.response.results.find((r) => r.code === 'sales_order:in').actual, 'deny');
    });

    test(`DA-CATALOG-MISMATCH 合約（${name}）：套用與驗證的已簽回應帶外部系統當時用的目錄版本，等於平台目前的版本（同一個演算法）；外部系統的對照改了就回報另一個版本，平台不認得（DA-CATALOG-UNKNOWN）`, async () => {
        const port = adapters[name];
        const no = caseNo('catalog');
        const cat = (await one(admin, 'select pack_data_access.catalog_current() as c')).c;
        const rs = { ...ruleSet(no, 1), catalog: cat };
        const applied = await item('apply', no, rs);
        const outcome = await port.send(applied);
        const v = await verdict(applied, outcome);
        assert.equal(v.class, 'succeed');
        assert.equal(v.result.catalog_sha256, cat.sha256);
        const verifyItem = await item('verify', no, { request_id: randomUUID(), run_id: 1, rule_set: rs, cases: [] });
        assert.equal((await verdict(verifyItem, await port.send(verifyItem))).result.catalog_sha256, cat.sha256);
        // 使用方的「代碼 → 實體資源」對照改了（sim/dc 的測試後門；模擬 adapter 直接改它回報的版本）
        const remap = { key: 'sales_order.amount', resource: 'amount_v2' };
        const admin2 = (body) =>
            fetch(`${base}/admin/remap`, {
                method: 'POST',
                headers: { authorization: `Bearer ${config.dc.SIM_DC_KEY_ADMIN}`, 'content-type': 'application/json' },
                body: JSON.stringify(body),
            });
        if (name === 'http') assert.equal((await admin2(remap)).status, 200);
        else port.catalog.sha256 = 'ab'.repeat(32);
        try {
            const again = await item('apply', no, rs);
            const reported = (await verdict(again, await port.send(again))).result.catalog_sha256;
            assert.notEqual(reported, cat.sha256);
            assert.equal((await one(admin, 'select pack_data_access.catalog_version_of($1) as n', [reported])).n, null);
        } finally {
            if (name === 'http') await admin2({ key: remap.key, resource: null });
            else port.catalog.sha256 = cat.sha256;
        }
    });

    test(`K-DELIVERY-ORDER 合約（${name}）：較舊的版本、撤回後的同一版被拒絕（防重放舊的已簽章規則）；撤回以冪等鍵去重；沒有這張單的撤回視為已達成`, async () => {
        const port = adapters[name];
        const no = caseNo('order');
        const principal = randomUUID();
        const v1 = await item('apply', no, ruleSet(no, 1, { principal }));
        const v2 = await item('apply', no, ruleSet(no, 2, { principal, fields: ['amount', 'order_no'] }));
        assert.equal((await port.send(v1)).http_status, 200);
        assert.equal((await port.send(v1)).http_status, 200, '同一版同內容重送是冪等的');
        assert.equal((await port.send(v2)).http_status, 200);
        const replay = await port.send(v1);
        assert.equal(replay.http_status, 409);
        assert.equal(await classify(v1, replay), 'reject');
        const withdraw = await item('withdraw', no, { request_id: randomUUID(), case_no: no });
        assert.equal((await port.send(withdraw)).http_status, 200);
        assert.equal((await port.send(withdraw)).http_status, 200, '同一個撤回重送不再動作');
        assert.equal((await port.send(v2)).http_status, 409, '撤回後同一版不能再套用');
        const v3 = await item('apply', no, ruleSet(no, 3, { principal }));
        const archived = await port.send(v3);
        assert.equal(archived.http_status, 409, '整張撤回＝封存：較新的已簽章版本也不收（裁決 D81 (2)）');
        assert.equal(archived.response.code, 'archived');
        assert.equal(await classify(v3, archived), 'reject');
        const none = caseNo('none');
        const missingItem = await item('withdraw', none, { request_id: randomUUID(), case_no: none });
        const missing = await port.send(missingItem);
        assert.equal(missing.http_status, 404);
        assert.equal(await classify(missingItem, missing), 'succeed');
    });
}

for (const name of ['mock', 'http']) {
    test(`K-VERIFY-AUTO 合約（${name}）：外部系統以被授權者為單位取聯集——同一被授權者另一張單（2024 年）放行的列，這張單（2025 年）的期間外查詢也查得到`, async () => {
        const port = adapters[name];
        const principal = randomUUID();
        const a = caseNo('union-a');
        const b = caseNo('union-b');
        const ra = ruleSet(a, 1, { principal });
        ra.rules[0].data_period = { field: 'order_date', from: '2024-01-01', to: '2024-12-31' };
        const rb = ruleSet(b, 1, { principal });
        assert.equal((await port.send(await item('apply', a, ra))).http_status, 200);
        assert.equal((await port.send(await item('apply', b, rb))).http_status, 200);
        const query = { package: 'sales_order', fields: ['amount', 'order_no'], row: { region: 'north' }, action: 'query', as_of: today() };
        const cases = [
            { code: 'b:period', expected: 'deny', query: { ...query, data_date: '2024-12-31' } },
            { code: 'b:outside-both', expected: 'deny', query: { ...query, data_date: '2023-12-31' } },
        ];
        const out = await port.send(await item('verify', b, { request_id: randomUUID(), run_id: 1, rule_set: rb, cases }));
        assert.deepEqual(
            out.response.results.map((r) => [r.code, r.actual]),
            [
                ['b:period', 'allow'],
                ['b:outside-both', 'deny'],
            ],
        );
        const others = [ra];
        const covered = await one(admin, 'select pack_data_access.rules_allow($1, $2) as a', [JSON.stringify(others), cases[0].query]);
        assert.equal(covered.a, true, '流程包的判斷和外部系統一致：這個反例要剔除');
    });
}

test('K-GRANT-EXPIRE 合約（http）：清除到期——授權迄日已過的規則還在目錄上時對帳看得到（expired_uncleared），清除之後消失', async () => {
    const no = caseNo('expire');
    const rs = ruleSet(no, 1, { valid: { from: addDays(today(), -30), to: addDays(today(), -1) } });
    assert.equal((await adapters.http.send(await item('apply', no, rs))).http_status, 200);
    const before = (await audit.fetchReport()).items.filter((i) => i.properties.case_no === no);
    assert.ok(before.length > 0);
    assert.ok(before.every((i) => i.properties.lifecycle === 'expired_uncleared'));
    const purgeItem = await item('purge', null, {});
    const purged = await adapters.http.send(purgeItem);
    assert.equal(await classify(purgeItem, purged), 'succeed');
    assert.deepEqual(
        (await audit.fetchReport()).items.filter((i) => i.properties.case_no === no),
        [],
    );
});

test('K-RECON-DIFFERENT 合約（http）：對帳回報的項目經流程包整理後，與 expected_entitlements 逐項相同（鍵、列條件、資料期間、有效期間）；後門多給的欄位多一項', async () => {
    const no = caseNo('recon');
    const principal = randomUUID();
    const rs = ruleSet(no, 1, { principal });
    assert.equal((await adapters.http.send(await item('apply', no, rs))).http_status, 200);
    const observed = (await audit.fetchReport()).items.filter((i) => i.subject.id === principal);
    const expected = (await one(admin, 'select pack_data_access.expected_entitlements($1) as e', [rs])).e;
    const key = (subject, resource, action, ruleId) => `${subject}|${resource}|${action}|${ruleId}`;
    const normalized = [];
    for (const i of observed) {
        const c = (await one(admin, 'select pack_data_access.normalize_constraints($1) as c', [i.constraints])).c;
        normalized.push({
            key: key(i.subject.id, i.resource.id, i.action.name, i.properties.rule_id),
            constraints: c,
            valid: i.properties.valid,
        });
    }
    assert.deepEqual(
        normalized.sort((a, b) => a.key.localeCompare(b.key)),
        expected
            .map((e) => ({ key: key(e.subject, e.resource, e.action, e.rule_id), constraints: e.constraints, valid: e.valid }))
            .sort((a, b) => a.key.localeCompare(b.key)),
    );
    const res = await fetch(`${base}/admin/grant_column`, {
        method: 'POST',
        headers: { authorization: `Bearer ${config.dc.SIM_DC_KEY_ADMIN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ principal_id: principal, package: 'sales_order', field: 'gross_margin', action: 'read' }),
    });
    assert.equal(res.status, 200);
    const extra = (await audit.fetchReport()).items.filter((i) => i.subject.id === principal);
    assert.equal(extra.length, observed.length + 1);
    assert.ok(extra.some((i) => i.resource.id === 'sales_order.gross_margin'));
});

// ── 裁決 D81 (2)：外部系統交付介面的完整等級（每一項都是「拿掉這道防法就會失敗」的形式）──

for (const name of ['mock', 'http']) {
    test(`K-DELIVERY-ATTESTED 合約（${name}）：沒有證明、證明被改、拿別筆的回應（一次性亂數不同）都當成沒送到（retry），不採信交付程式說的狀態`, async () => {
        const port = adapters[name];
        const no = caseNo('att');
        const good = await item('apply', no, ruleSet(no, 1));
        const outcome = await port.send(good);
        assert.equal((await verdict(good, outcome)).class, 'succeed');
        // 網路上的人／交付程式：拿掉證明、只改可讀欄位、整份換掉
        const stripped = { ...outcome, response: { status: 'applied' } };
        assert.equal(await classify(good, stripped), 'retry');
        const relabeled = { ...outcome, http_status: 409, response: { ...outcome.response, status: 'failed' } };
        assert.equal(await classify(good, relabeled), 'succeed', '可讀副本改了也不影響：只採信證明裡的結果');
        const att = outcome.response.attestation;
        const forged = {
            ...outcome,
            response: { ...outcome.response, attestation: { ...att, payload: att.payload.replace('"applied"', '"withdrawn"') } },
        };
        assert.equal(await classify(good, forged), 'retry');
        // 同一筆的另一次領取（亂數不同）不能拿這份回應來回報
        assert.equal(await classify({ ...good, nonce: randomBytes(18).toString('hex') }, outcome), 'retry');
        // 另一筆交付（送出的位元組不同）也不行
        const other = await item('apply', no, ruleSet(no, 2));
        assert.equal(await classify(other, outcome), 'retry');
        const wd = await item('withdraw', no, { request_id: randomUUID(), case_no: no });
        await port.send(wd);
    });

    test(`K-DELIVERY-ATTESTED 合約（${name}）：簽章帶期限——過期的信封外部系統不收，平台判為重送（下次領取重新簽）`, async () => {
        const port = adapters[name];
        const no = caseNo('ttl');
        const stale = await item('apply', no, ruleSet(no, 1), { ttl: -5 });
        const outcome = await port.send(stale);
        assert.equal(outcome.http_status, 401);
        assert.equal(outcome.response.code, 'signature_expired');
        const v = await verdict(stale, outcome);
        assert.equal(v.class, 'retry');
        assert.equal(v.expired, true);
    });
}

test('K-DELIVERY-ATTESTED 合約（http）：同一份已簽章的規則送到外部系統的另一個環境（遮罩）不收，那個環境的證明平台也不採信', async () => {
    const no = caseNo('env');
    const good = await item('apply', no, ruleSet(no, 1));
    const masked = dcHttpDelivery({ base: base.replace('/v1', '/masked/v1'), key: config.dc.SIM_DC_KEY_PLATFORM, timeoutMs: 10000 });
    const outcome = await masked.send(good);
    assert.equal(outcome.http_status, 401, '遮罩環境不信任任何平台金鑰（信任清單每個環境各自一份）');
    assert.equal(await classify(good, outcome), 'retry', '證明裡的環境不是這個通道的環境');
    const report = await dcHttpReconciliation({
        base: base.replace('/v1', '/masked/v1'),
        key: config.dc.SIM_DC_KEY_AUDITOR,
        timeoutMs: 10000,
    }).fetchReport();
    assert.ok(!report.items.some((i) => i.properties.case_no === no));
});

test('K-DELIVERY-SIGNED ed25519_sign 一律由種子自己導出公鑰：傳入的公鑰和種子不一致就拒絕（不一致的兩次簽章會洩漏私鑰純量；紅隊第四輪 資訊 3）', async () => {
    const seed = randomBytes(32).toString('hex');
    const other = randomBytes(32).toString('hex');
    await rejectsWith(
        one(
            admin,
            `select sgn_internal.ed25519_sign(decode($1, 'hex'), sgn_internal.ed25519_public_key(decode($2, 'hex')), decode('01', 'hex')) as s`,
            [seed, other],
        ),
        'ED25519_KEY_MISMATCH',
    );
    const ok = await one(
        admin,
        `select sgn_internal.ed25519_sign(decode($1, 'hex'), sgn_internal.ed25519_public_key(decode($1, 'hex')), decode('01', 'hex')) as s`,
        [seed],
    );
    assert.equal(ok.s.length, 64);
});
