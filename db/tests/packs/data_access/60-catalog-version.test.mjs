// 資料目錄的版本與綁定（裁決 D92 (1)、(6)；db/packs/data_access/130_catalog_version.sql；威脅表 docs/handoff/closed-loop-1.md）。
// 目錄由平台維護、任何異動產生新版本；每個內容版本綁定整理當下的版本並簽進去；使用方系統回報它用的版本，平台比對引用的部分。
// 這個檔案會改目錄：每個測試結束前載回種子的目錄（又產生一個雜湊和種子相同的新版本）。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { decisionContent, versionSha256 } from '../../../../web/lib/signing.js';
import { deliverChannel } from '../../../../api/src/delivery.ts';
import { DB_DIR } from '../../../tools/lib/env.mjs';
import {
    call,
    closePools,
    decidePasskey,
    issueChallenge,
    login,
    one,
    pool,
    registerPasskey,
    rejectsWith,
    setSetting,
} from '../../kernel/lib/harness.mjs';
import { CHANNEL, deliveryPool, drain, mockDc, ops, salesOrderContent, systemDelivery } from './delivery-lib.mjs';
import { DA, decide, principals, today } from './lib.mjs';

const app = pool('APP');
const admin = pool('ADMIN');
const reconciler = pool('RECONCILER');
const scheduler = pool('SCHEDULER');
const delivery = deliveryPool();
const users = {};
let P;
let dc;

const VECTORS = JSON.parse(readFileSync(join(DB_DIR, 'tests/packs/data_access/fixtures/catalog-vectors.json'), 'utf8')).vectors;
/** 種子的目錄（catalog_load 的匯入格式，含擁有者）。 */
const SEED = JSON.parse(/\$json\$([\s\S]*)\$json\$/.exec(readFileSync(join(DB_DIR, 'seed/packs/data_access/010_catalog.sql'), 'utf8'))[1]);
const clone = (x) => JSON.parse(JSON.stringify(x));
/** 種子的目錄改一個地方：f(packages) 直接改。 */
function edited(f) {
    const snap = clone(SEED);
    f(Object.fromEntries(snap.packages.map((p) => [p.code, p])));
    return snap;
}
const field = (pkg, code) => pkg.fields.find((x) => x.code === code);
const load = async (snapshot) => (await one(admin, 'select pack_data_access.catalog_load($1) as r', [snapshot])).r;
const current = async () => (await one(admin, 'select pack_data_access.catalog_current() as c')).c;
const restore = () => load(SEED);

before(async () => {
    for (const uid of ['p03', 'p04', 'p09', 'p11', 'p17']) {
        users[uid] = await login(app, uid);
        users[uid].key = await registerPasskey(app, users[uid]);
    }
    P = await principals(app, users.p04.session);
    await systemDelivery(admin);
    dc = await mockDc(admin);
    await drain(delivery, dc);
});
after(async () => {
    await restore();
    await delivery.end();
    await closePools();
});

const view = (caseId, who = 'p04') => call(app, 'case_get', users[who].session, caseId);
const exceptions = async (caseId) =>
    (await admin.query('select id::int, rule_code, detail, closed_at from sgn.exception_record where case_id = $1 order by id', [caseId]))
        .rows;
const events = async (caseId, type) =>
    (
        await admin.query(
            `select convert_from(body, 'UTF8')::jsonb -> 'data' as data from sgn.audit_event where case_id = $1 and event_type = $2 order by seq`,
            [caseId, type],
        )
    ).rows.map((r) => r.data);
async function submitted(year, content = salesOrderContent(year)) {
    const t = { principal_id: P['sales-report-bot'], valid_from: today(), valid_to: today(60) };
    return (await call(app, 'case_submit_new', users.p04.session, DA, content, t, null)).case_id;
}
/** 主管、資料擁有者、MIS 簽完（待套用，交付還沒送）。 */
async function approved(year, content) {
    const caseId = await submitted(year, content);
    await decide(app, users.p03, caseId);
    await decide(app, users.p11, caseId);
    await call(app, 'task_claim', users.p17.session, caseId);
    await decide(app, users.p17, caseId);
    return caseId;
}
async function active(year) {
    const caseId = await approved(year);
    await drain(delivery, dc);
    await call(app, 'case_confirm_verification', users.p04.session, caseId);
    assert.equal((await view(caseId)).state, 'active');
    return caseId;
}
const reportWith = (catalog) => ({
    format: 'dc_reconciliation_report/1',
    observed_at: new Date().toISOString(),
    process_type: 'data_access',
    catalog_sha256: catalog,
    items: [],
});
const submitReport = async (catalog) =>
    (await one(reconciler, 'select api_job.reconciliation_submit($1, $2) as r', [CHANNEL, dc.reconciliation(reportWith(catalog))])).r;

test('DA-CATALOG-VERSION 目錄的標準化快照與雜湊等於和 sim/dc 共用的測試向量；同一份再載入不產生新版本；改名稱或對照就產生新版本並進鏈；版本只增不改', async () => {
    assert.deepEqual((await one(admin, 'select pack_data_access.catalog_snapshot() as s')).s, VECTORS[0].snapshot);
    const before = await current();
    assert.equal(before.sha256, VECTORS[0].sha256);
    const again = await load(SEED);
    assert.equal(again.catalog.changed, false);
    assert.deepEqual(await current(), before, '同一份快照不產生新版本');
    // 只換實體資源（代碼不變）也是新版本：雜湊等於共用向量的第二組
    const [key, resource] = Object.entries(VECTORS[1].remap)[0];
    const [pkgCode, fieldCode] = key.split('.');
    const remapped = await load(
        edited((p) => {
            field(p[pkgCode], fieldCode).resource = resource;
        }),
    );
    assert.equal(remapped.catalog.changed, true);
    assert.equal(remapped.catalog.version.sha256, VECTORS[1].sha256);
    assert.equal(remapped.catalog.version.version_no, before.version_no + 1);
    const ev = (
        await admin.query(
            `select e.data from (select convert_from(body, 'UTF8')::jsonb -> 'data' as data from sgn.audit_event
                                  where event_type = 'data_access.catalog_versioned') as e
             where (e.data ->> 'version_no')::int = $1`,
            [before.version_no + 1],
        )
    ).rows[0].data;
    assert.equal(ev.catalog_sha256, VECTORS[1].sha256);
    assert.equal(ev.previous.sha256, before.sha256);
    await rejectsWith(admin.query(`update pack_data_access.catalog_version set source = 'x'`), 'DA-E-CATALOG-APPEND-ONLY');
    await rejectsWith(admin.query('delete from pack_data_access.catalog_version'), 'DA-E-CATALOG-APPEND-ONLY');
    await rejectsWith(admin.query('truncate pack_data_access.catalog_version cascade'), 'DA-E-CATALOG-APPEND-ONLY');
    // 改回原樣：又一個新版本（序號遞增），雜湊和最初的相同
    const back = await restore();
    assert.equal(back.catalog.version.sha256, before.sha256);
    assert.equal(back.catalog.version.version_no, before.version_no + 2);
});

test('DA-CATALOG-BOUND 送審的那一版綁定送審當下的目錄版本：在內容、版本雜湊與顯示摘要（資料目錄第 N 版）裡，瀏覽器（web/lib/signing.js）與資料庫算出相同的要簽內容（核准、縮小後核准）；比較內容忽略它；交付的規則帶它', async () => {
    const cat = await current();
    // 申請人（或被入侵的後端）自己帶的目錄版本不算數：一律由資料庫在整理時填上當下的版本
    const caseId = await submitted(2110, {
        ...salesOrderContent(2110, ['amount', 'order_date', 'order_no']),
        catalog: { version_no: 999, sha256: 'ab'.repeat(32) },
    });
    const v = await view(caseId);
    assert.deepEqual(v.content.catalog, cat);
    assert.equal(v.version_sha256, await versionSha256(v.content, v.terms));
    assert.deepEqual(v.display.content.catalog, {
        version_no: String(cat.version_no),
        sha256: cat.sha256,
        text: `資料目錄第 ${cat.version_no} 版（${cat.sha256.slice(0, 12)}）`,
    });
    // 主管核准：資料庫鏈上記下的要簽內容＝瀏覽器從顯示摘要算的
    const shown = await view(caseId, 'p03');
    await decide(app, users.p03, caseId);
    const [approve] = await events(caseId, 'case.approve');
    assert.deepEqual(approve.signed.content, await decisionContent(shown.display, 'approve', {}));
    // 資料擁有者縮小後核准：縮小的內容由資料庫整理（同樣綁定目錄），瀏覽器以同一份算版本雜湊與顯示雜湊
    const reduced = { ...v.content, scope: [{ ...v.content.scope[0], fields: ['amount', 'order_date'] }] };
    const ch = await call(app, 'challenge_issue', users.p11.session, caseId, 'approve_reduced', { content: reduced });
    assert.deepEqual(ch.input.content.catalog, cat);
    const shownOwner = await view(caseId, 'p11');
    await decide(app, users.p11, caseId, 'approve_reduced', { content: reduced });
    const [reducedEv] = await events(caseId, 'case.approve_reduced');
    assert.deepEqual(
        reducedEv.signed.content,
        await decisionContent(shownOwner.display, 'approve_reduced', { ...ch.input, display: ch.display }),
    );
    // 比較內容忽略目錄版本：只有版本號不同算 same
    const other = { ...v.content, catalog: { version_no: cat.version_no + 99, sha256: 'ab'.repeat(32) } };
    assert.equal((await one(admin, 'select pack_data_access.compare_bound($1, $2) as k', [v.content, other])).k, 'same');
    await call(app, 'task_claim', users.p17.session, caseId);
    await decide(app, users.p17, caseId);
    const [apply] = await ops(admin, caseId);
    assert.deepEqual(JSON.parse(apply.body).catalog, cat, '交付的規則帶綁定的目錄版本');
    await drain(delivery, dc);
    assert.equal((await view(caseId)).state, 'verifying', '使用方回報同一個版本：照常進入驗證、等申請人確認');
});

test('DA-CATALOG-BOUND 舊單（這一版之前、沒有綁定目錄的內容版本）：已存的雜湊不重算、顯示摘要不多目錄這一行、照樣可以簽；交付時帶事後基準的版本', async () => {
    // 模擬升版前建立的單：整理內容的 hook 暫時換回沒有綁定的那一個
    const restoreHook = () =>
        admin.query(`select sgn_sdk.register_hook('data_access', 'normalize_content', 'pack_data_access.normalize_capable')`);
    await admin.query(`select sgn_sdk.register_hook('data_access', 'normalize_content', 'pack_data_access.normalize_content')`);
    let caseId;
    try {
        caseId = await submitted(2111);
    } finally {
        await restoreHook();
    }
    const v = await view(caseId);
    assert.equal(v.content.catalog, undefined);
    assert.equal(v.display.content.catalog, undefined, '舊的顯示摘要不變');
    assert.equal(v.version_sha256, await versionSha256(v.content, v.terms), '版本雜湊的公式不變');
    const stored = await one(admin, `select encode(version_sha256, 'hex') as h from sgn.case_version where case_id = $1`, [caseId]);
    assert.equal(stored.h, v.version_sha256);
    // 升版的 migration 對未結束的單記下的基準（同一個寫法）
    await admin.query(
        `insert into pack_data_access.catalog_baseline (case_id, version, catalog_version_no, recorded_at)
         values ($1, 1, (pack_data_access.catalog_current() ->> 'version_no')::int, now())`,
        [caseId],
    );
    await decide(app, users.p03, caseId);
    await decide(app, users.p11, caseId);
    await call(app, 'task_claim', users.p17.session, caseId);
    await decide(app, users.p17, caseId);
    const [apply] = await ops(admin, caseId);
    assert.deepEqual(JSON.parse(apply.body).catalog, await current());
    await drain(delivery, dc);
    assert.equal((await view(caseId)).state, 'verifying');
});

test('DA-CATALOG-MISMATCH K-DELIVERY-RESULT-CHECK 使用方套用時用的目錄版本在這張單引用的部分和綁定的不同：不生效、撤回已送出的部分、開例外並通知升級對象', async () => {
    const caseId = await approved(2112);
    // 核准之後目錄改了（訂單金額改名），使用方也換成新版本；這張單綁定的是舊的
    const renamed = await load(
        edited((p) => {
            field(p.sales_order, 'amount').name = '訂單金額（含稅）';
        }),
    );
    const oldSha = dc.catalog.sha256;
    dc.catalog.sha256 = renamed.catalog.version.sha256;
    try {
        await drain(delivery, dc);
    } finally {
        dc.catalog.sha256 = oldSha;
    }
    const v = await view(caseId);
    assert.equal(v.state, 'fulfilment_failed');
    const codes = (await exceptions(caseId)).map((x) => x.rule_code);
    assert.ok(codes.includes('DA-CATALOG-MISMATCH'), codes.join(','));
    assert.ok(
        v.delivery.ops.some((o) => o.kind === 'withdraw'),
        '已送出的部分自動撤回',
    );
    const [rejected] = await events(caseId, 'delivery.reject');
    assert.ok(rejected.rules.includes('K-DELIVERY-RESULT-CHECK') && rejected.rules.includes('DA-CATALOG-MISMATCH'));
    // 名稱沒改的主題包不受影響：引用摘要相同
    const unaffected = await one(admin, 'select pack_data_access.catalog_ref_matches($1, array[$2::int], $3) as m', [
        { scope: [{ package: 'customer_master', fields: [{ code: 'customer_id' }], row_filters: [] }] },
        renamed.catalog.version.version_no - 1,
        renamed.catalog.version.version_no,
    ]);
    assert.equal(unaffected.m, true);
    await restore();
});

test('DA-CATALOG-MISMATCH K-RECON-REPORT-CHECK 對帳回報也帶目錄版本並逐張比對：生效中的單引用的部分和回報的版本不同就開例外（同一張單未結案時不重開）', async () => {
    const caseId = await active(2113);
    const renamed = await load(
        edited((p) => {
            p.sales_order.fields.find((f) => f.code === 'order_no').resource = 'order_number';
        }),
    );
    await submitReport(renamed.catalog.version.sha256);
    await submitReport(renamed.catalog.version.sha256);
    const mism = (await exceptions(caseId)).filter((x) => x.rule_code === 'DA-CATALOG-MISMATCH');
    assert.equal(mism.length, 1);
    assert.equal(mism[0].detail.channel, CHANNEL);
    assert.ok(mism[0].detail.rules.includes('K-RECON-REPORT-CHECK'));
    await restore();
});

test('DA-CATALOG-UNKNOWN 使用方回報平台不認得的版本：寬限時間內當成沒送到（重送、不生效），逾時不生效並開例外；對帳回報逾時每個通道一筆', async () => {
    const caseId = await approved(2114);
    const oldSha = dc.catalog.sha256;
    dc.catalog.sha256 = 'cd'.repeat(32);
    try {
        await deliverChannel(delivery, CHANNEL, dc);
        let [apply] = await ops(admin, caseId);
        assert.equal(apply.status, 'queued', '寬限內重送');
        assert.equal((await view(caseId)).state, 'pending_fulfilment');
        await setSetting(admin, 'data_access.catalog_unknown_grace_minutes', 0, `channel:${CHANNEL}`);
        await drain(delivery, dc);
        [apply] = await ops(admin, caseId);
        assert.equal(apply.status, 'rejected');
        assert.equal((await view(caseId)).state, 'fulfilment_failed');
        assert.ok((await exceptions(caseId)).some((x) => x.rule_code === 'DA-CATALOG-UNKNOWN'));
        await submitReport('ef'.repeat(32));
        await submitReport('ef'.repeat(32));
        const { rows } = await admin.query(
            `select count(*)::int as n from sgn.exception_record where rule_code = 'DA-CATALOG-UNKNOWN' and case_id is null
             and detail ->> 'reported_sha256' = $1 and closed_at is null`,
            ['ef'.repeat(32)],
        );
        assert.equal(rows[0].n, 1);
    } finally {
        dc.catalog.sha256 = oldSha;
        await setSetting(admin, 'data_access.catalog_unknown_grace_minutes', 60, `channel:${CHANNEL}`);
        await drain(delivery, dc);
    }
});

test('DA-CATALOG-DRIFT K-CONTENT-REBIND 目錄改版時簽核中的單：以新版本重新整理成新的一版、從第一關重簽（之前的簽核不算數）；引用的項目沒變的單不動；整理後有錯就退回申請人', async () => {
    const caseId = await submitted(2115);
    const untouched = await submitted(2116, {
        ...salesOrderContent(2116),
        scope: [{ package: 'customer_master', fields: ['customer_id'], row_filters: [] }],
        data_period: null,
    });
    await decide(app, users.p03, caseId);
    const early = await issueChallenge(app, users.p11, caseId);
    const before = await view(caseId, 'p03');
    assert.equal(before.current_stage.code, 'data_owner');
    const renamed = await load(
        edited((p) => {
            field(p.sales_order, 'order_no').name = '訂單號碼';
        }),
    );
    assert.equal(renamed.catalog.drift.rebound >= 1, true);
    const after = await view(caseId, 'p03');
    assert.equal(after.version, before.version + 1);
    assert.equal(after.current_stage.code, 'manager', '從第一關重簽');
    assert.deepEqual(after.content.catalog, renamed.catalog.version);
    assert.equal(after.versions.at(-1).change_kind, 'expand');
    // 主管看到的基準是他簽過的那一版（舊目錄），這一版是新目錄
    assert.equal(after.display.baseline.content.catalog.version_no, String(before.content.catalog.version_no));
    assert.equal(after.display.content.catalog.version_no, String(renamed.catalog.version.version_no));
    const [rebound] = await events(caseId, 'case.rebound');
    assert.deepEqual(rebound.rules, ['K-CONTENT-REBIND', 'DA-CATALOG-DRIFT']);
    // 改版前發的挑戰值對不上新的一版
    await assert.rejects(decidePasskey(app, early.challenge_id, 'approve', users.p11.key.assert(early.challenge)));
    assert.equal((await view(untouched)).version, 1, '引用的項目沒變的單不動');
    const notified = await admin.query(
        `select 1 from sgn.notification_outbox where case_id = $1 and event_code = 'case.rebound' and person_id = $2`,
        [caseId, users.p04.personId],
    );
    assert.equal(notified.rowCount, 1);
    // 主題包被停用：整理後這張單沒有可申請的欄位，退回申請人修正
    await load({ packages: SEED.packages.filter((p) => p.code !== 'sales_order') });
    const returned = await view(caseId);
    assert.equal(returned.state, 'returned');
    assert.ok(returned.errors.some((e) => e.code === 'DA-E-SCOPE-EMPTY'));
    await restore();
});

test('K-CONTENT-REBIND 停在群組認領關（還沒有人認領）的單也能重新綁定：等認領的工作作廢、從第一關重簽', async () => {
    const caseId = await submitted(2120);
    await decide(app, users.p03, caseId);
    await decide(app, users.p11, caseId);
    assert.equal((await view(caseId)).current_stage.code, 'mis');
    await load(
        edited((p) => {
            field(p.sales_order, 'order_no').name = '訂單號碼';
        }),
    );
    const v = await view(caseId);
    assert.equal(v.current_stage.code, 'manager');
    const mis = v.stages.filter((s) => s.code === 'mis');
    assert.ok(mis.every((s) => s.status === 'cancelled' && s.tasks.every((t) => t.status === 'cancelled')));
    await restore();
});

test('DA-CATALOG-DRIFT 目錄改版影響生效中的單：開例外並通知受影響主題包的資料擁有者；只改名稱時帶確認期限，對照有變時寫明「對照或分級有變」', async () => {
    const caseId = await active(2117);
    await load(
        edited((p) => {
            p.sales_order.name = '銷售訂單（新）';
        }),
    );
    let drift = (await exceptions(caseId)).filter((x) => x.rule_code === 'DA-CATALOG-DRIFT');
    assert.equal(drift.length, 1);
    assert.equal(drift[0].detail.kind, 'rename_only');
    assert.ok(drift[0].detail.due_at);
    assert.deepEqual(drift[0].detail.changes, [{ code: 'sales_order', before: '銷售訂單', after: '銷售訂單（新）' }]);
    const notes = await admin.query(
        `select person_id from sgn.notification_outbox where case_id = $1 and event_code = 'data_access.catalog_drift'`,
        [caseId],
    );
    assert.deepEqual(
        notes.rows.map((r) => r.person_id),
        [users.p11.personId],
    );
    assert.equal((await view(caseId)).state, 'active', '不撤銷');
    await load(
        edited((p) => {
            p.sales_order.name = '銷售訂單（新）';
            field(p.sales_order, 'amount').resource = 'amount_taxed';
        }),
    );
    drift = (await exceptions(caseId)).filter((x) => x.rule_code === 'DA-CATALOG-DRIFT');
    assert.equal(drift.at(-1).detail.kind, 'changed');
    assert.equal(drift.at(-1).detail.due_at, undefined);
    await restore();
});

test('DA-CATALOG-RENAME-CONFIRM K-EXCEPTION-FOLLOWUP 只改名稱：資料擁有者在期限內確認（進鏈、結案、之後以新版本比對）；別人不能確認；逾期升級、不撤銷', async () => {
    const caseId = await active(2118);
    const renamed = await load(
        edited((p) => {
            field(p.sales_order, 'order_date').name = '下單日期';
        }),
    );
    const pending = await call(app, 'data_access_catalog_pending', users.p11.session);
    const mine = pending.find((x) => x.case_id === caseId);
    assert.ok(mine);
    assert.deepEqual(mine.changes, [{ code: 'sales_order.order_date', before: '訂單日期', after: '下單日期' }]);
    assert.deepEqual(await call(app, 'data_access_catalog_pending', users.p04.session), [], '申請人不是資料擁有者');
    await rejectsWith(call(app, 'data_access_catalog_confirm', users.p04.session, mine.exception_id), 'DA-E-CATALOG-CONFIRM-DENIED');
    const left = await call(app, 'data_access_catalog_confirm', users.p11.session, mine.exception_id);
    assert.ok(!left.some((x) => x.exception_id === mine.exception_id));
    await rejectsWith(call(app, 'data_access_catalog_confirm', users.p11.session, mine.exception_id), 'DA-E-CATALOG-CONFIRM-UNKNOWN');
    const drift = (await exceptions(caseId)).find((x) => x.id === mine.exception_id);
    assert.ok(drift.closed_at);
    const [confirmed] = await events(caseId, 'data_access.catalog_rename_confirmed');
    assert.equal(confirmed.to_version_no, renamed.catalog.version.version_no);
    // 確認之後以新版本比對：使用方回報新版本不開不一致的例外
    await submitReport(renamed.catalog.version.sha256);
    // 使用方還沒換新版本（回報改名前的版本）也接受：只改名稱，兩個版本意義相同
    await submitReport(VECTORS[0].sha256);
    assert.ok(!(await exceptions(caseId)).some((x) => x.rule_code === 'DA-CATALOG-MISMATCH'));
    // 另一張單逾期沒確認：期限是參數（0 個工作天＝立刻逾期），排程升級並通知，仍然生效
    await restore();
    const late = await active(2119);
    await setSetting(admin, 'data_access.catalog_rename_confirm_workdays', 0, 'tier:data_access:L3');
    try {
        await load(
            edited((p) => {
                field(p.sales_order, 'order_date').name = '下單日期';
            }),
        );
    } finally {
        await setSetting(admin, 'data_access.catalog_rename_confirm_workdays', 5, 'tier:data_access:L3');
    }
    const lateDrift = (await exceptions(late)).find((x) => x.rule_code === 'DA-CATALOG-DRIFT' && !x.closed_at);
    const escalated = (await one(scheduler, 'select api_job.exception_followup_due() as r')).r;
    assert.ok(escalated.escalated >= 1);
    const [esc] = await events(late, 'exception.escalated');
    assert.equal(esc.exception, lateDrift.id);
    assert.equal((await one(scheduler, 'select api_job.exception_followup_due() as r')).r.escalated, 0, '每筆只升級一次');
    const overdue = await admin.query(
        `select person_id from sgn.notification_outbox where case_id = $1 and event_code = 'exception.overdue'`,
        [late],
    );
    assert.ok(overdue.rows.some((r) => r.person_id === users.p11.personId));
    assert.equal((await view(late)).state, 'active', '逾期不撤銷');
    assert.equal((await exceptions(late)).find((x) => x.id === lateDrift.id).closed_at, null);
    await restore();
});
