// 資料授權的完整簽核流程（經 api，與畫面走同一條路）：路徑、並行、認領、執行、上限、被授權者、縮小、退回、重疊。
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
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
import { addMonths, DA, decide, l3Content, l4Content, principals, terms, today } from './lib.mjs';

const app = pool('APP');
const admin = pool('ADMIN');
const users = {};
let P; // 被授權者名稱 → id

before(async () => {
    const uids = ['p02', 'p03', 'p04', 'p06', 'p07', 'p09', 'p10', 'p11', 'p12', 'p15', 'p16', 'p17', 'p18', 'p19', 'p30'];
    for (const uid of uids) {
        users[uid] = await login(app, uid);
        users[uid].key = await registerPasskey(app, users[uid]);
    }
    P = await principals(app, users.p04.session);
    // 這個檔案測的是人工執行的退路（執行設定由受管系統的管理人認領、以通行金鑰標記完成）：資料中心在這裡設定為人工。
    // 系統對系統的交付在 50-delivery.test.mjs（種子的預設，D63）。
    await setSetting(admin, 'delivery.mode', 'manual', 'system:dc');
});
after(closePools);

const submit = (who, content, t, reason = null) => call(app, 'case_submit_new', users[who].session, DA, content, t, reason);
const view = (who, caseId) => call(app, 'case_get', users[who].session, caseId);
const openStageTasks = (v) => v.stages.filter((s) => s.status === 'open').flatMap((s) => s.tasks);

let l3Grant; // 第一個測試產生的有效授權（通路業務組），重疊測試要用

test('DA-PATH-L3 L3：主管 → 資料擁有者（並行，全部核准才往下，K-PARALLEL-ALL）→ MIS 認領 → 系統管理人執行，生效並產生授權', async () => {
    // 林怡君替通路業務組（負責人劉俊傑）申請＝代填：第一關是被授權者負責人確認（D79 (2)），之後才是原本的 L3 路徑
    const c = await submit('p04', l3Content(), terms(P['通路業務組']));
    assert.equal(c.tier, 'L3');
    assert.equal(c.current_stage.code, 'principal_owner');
    assert.deepEqual(c.waiting_on, ['劉俊傑']);
    await decide(app, users.p07, c.case_id);
    assert.deepEqual((await view('p04', c.case_id)).waiting_on, ['陳建宏']);
    await decide(app, users.p03, c.case_id);
    let v = await view('p04', c.case_id);
    assert.equal(v.current_stage.code, 'data_owner');
    assert.deepEqual(
        openStageTasks(v)
            .map((t) => [t.assignee_name, t.scope_refs])
            .sort(),
        [
            ['周文傑', ['data_access:bundle:customer_master']],
            ['張美玲', ['data_access:bundle:sales_order']],
        ],
    );
    await decide(app, users.p09, c.case_id);
    v = await view('p04', c.case_id);
    assert.equal(v.current_stage.code, 'data_owner', '只有一位資料擁有者核准，還不能往下');
    assert.deepEqual(v.waiting_on, ['張美玲']);
    await decide(app, users.p11, c.case_id);
    v = await view('p04', c.case_id);
    assert.equal(v.current_stage.code, 'mis');
    assert.deepEqual([...v.waiting_on].sort(), ['李志偉', '林冠宇', '謝明哲'].sort());
    await call(app, 'task_claim', users.p17.session, c.case_id);
    assert.equal(await decide(app, users.p17, c.case_id), 'pending_fulfilment');
    v = await view('p04', c.case_id);
    assert.equal(v.current_stage.code, 'fulfil');
    assert.deepEqual(v.waiting_on, ['林冠宇'], 'p17 已經在資安合規檢查簽過，執行設定只剩 p18（DA-FULFIL-CUSTODIAN）');
    assert.deepEqual(
        v.stages.map((s) => s.code),
        ['principal_owner', 'manager', 'data_owner', 'mis', 'fulfil'],
    );
    await call(app, 'task_claim', users.p18.session, c.case_id);
    // 人工執行的單也要申請人確認才生效（K-CONFIRM-MANUAL，裁決 D84 (8)）
    assert.equal(await decide(app, users.p18, c.case_id, 'fulfil'), 'verifying');
    assert.equal((await call(app, 'case_confirm_verification', users.p04.session, c.case_id)).state, 'active');
    v = await view('p04', c.case_id);
    assert.equal(v.grant.status, 'active');
    assert.equal(v.grant.valid_from, v.terms.valid_from);
    l3Grant = v;
});

test('DA-FULFIL-RULE 核准完成時產生交給外部系統的規則（結構化 JSON）：核准的那一版、每個主題包一條、資料期間當成列條件', async () => {
    const payload = l3Grant.fulfilment.payload;
    assert.equal(payload.format, 'data_access_rule_set/1');
    assert.equal(payload.case_version_no, l3Grant.version);
    assert.deepEqual(payload.grantee, { type: 'team', principal_id: P['通路業務組'], name: '通路業務組' });
    assert.deepEqual(payload.valid, { from: l3Grant.terms.valid_from, to: l3Grant.terms.valid_to });
    assert.equal(payload.export, false);
    assert.deepEqual(payload.rules, [
        {
            rule_id: `${l3Grant.case_no}-1`,
            system: 'dc',
            package: 'customer_master',
            fields: ['customer_id', 'customer_name'],
            row_filter: [{ filter: 'region', op: 'in', values: ['central', 'north'] }],
            data_period: null,
        },
        {
            rule_id: `${l3Grant.case_no}-2`,
            system: 'dc',
            package: 'sales_order',
            fields: ['amount', 'order_date', 'order_no'],
            row_filter: [{ filter: 'region', op: 'in', values: ['north'] }],
            data_period: { field: 'order_date', from: '2025-01-01', to: '2025-12-31' },
        },
    ]);
});

test('DA-FULFIL-CUSTODIAN 執行設定由主題包所屬系統的管理人認領；不是那個系統的管理人不能認領', async () => {
    const c = await submit('p04', l4Content(), terms(P['ap-recon-bot'], 5));
    await decide(app, users.p12, c.case_id); // 代填：ap-recon-bot 的負責人吳家豪先確認（D79 (2)）
    await decide(app, users.p03, c.case_id);
    await decide(app, users.p15, c.case_id);
    await decide(app, users.p19, c.case_id);
    await call(app, 'task_claim', users.p16.session, c.case_id);
    await decide(app, users.p16, c.case_id);
    await rejectsWith(call(app, 'task_claim', users.p17.session, c.case_id), 'NOT_CLAIMABLE');
    const v = await view('p04', c.case_id);
    assert.deepEqual(v.waiting_on, ['江佩玲']);
    assert.deepEqual(openStageTasks(v)[0].scope_refs, ['system:hr_saas']);
    await call(app, 'task_claim', users.p30.session, c.case_id);
    assert.equal(await decide(app, users.p30, c.case_id, 'fulfil'), 'verifying');
    assert.equal((await call(app, 'case_confirm_verification', users.p04.session, c.case_id)).state, 'active');
});

test('DA-PATH-L4 L4：資料擁有者之後多一關資安長；L4 的單要求匯出時改為只能查詢（DA-EXPORT-TIER）', async () => {
    const c = await submit('p04', l4Content({ export_allowed: true }), terms(P['sales-report-bot'], 5));
    assert.equal(c.tier, 'L4');
    assert.equal(c.content.export_allowed, false);
    assert.deepEqual(codesOf(c.notices), ['DA-N-EXPORT-FORCED']);
    await decide(app, users.p03, c.case_id);
    await decide(app, users.p15, c.case_id);
    const v = await view('p04', c.case_id);
    assert.equal(v.current_stage.code, 'ciso');
    assert.deepEqual(v.waiting_on, ['賴政達']);
    await decide(app, users.p19, c.case_id);
    assert.equal((await view('p04', c.case_id)).current_stage.code, 'mis');
});

const codesOf = (list) => list.map((x) => x.code);

test('DA-PATH-L4 新申請畫面讀得到每個級別會經過的關卡（路徑是資料）；版本歷程帶每一版的內容，畫面才能顯示與前一版的差異', async () => {
    const types = await call(app, 'process_type_list', users.p04.session);
    const da = types.find((x) => x.code === DA);
    const path = Object.fromEntries(da.tiers.map((t) => [t.code, t.stages.map((s) => `${s.code}:${s.mode}`)]));
    assert.deepEqual(path, {
        L3: ['manager:one', 'data_owner:all', 'mis:one', 'fulfil:one'],
        L4: ['manager:one', 'data_owner:all', 'ciso:one', 'mis:one', 'fulfil:one'],
    });
    const draft = await call(app, 'case_create', users.p04.session, DA, l3Content(), terms(P['業務分析部'], 2));
    const revised = await call(app, 'case_revise', users.p04.session, draft.case_id, l4Content(), terms(P['業務分析部'], 2));
    assert.deepEqual(
        revised.versions.map((v) => [v.version, v.content.scope.map((s) => s.package), v.terms.principal.name]),
        [
            [1, ['customer_master', 'sales_order'], '業務分析部'],
            [2, ['payroll'], '業務分析部'],
        ],
    );
});

test('K-VALIDITY-MAX 授權起迄不得超過級別的上限（參數）：L3 12 個月、L4 6 個月（DA-DEFAULT-SETTINGS）', async () => {
    const max = async (tier) =>
        (await one(admin, `select sgn_internal.setting('validity.max_months', array['tier:data_access:' || $1::text]) as v`, [tier])).v;
    assert.equal(await max('L3'), 12);
    assert.equal(await max('L4'), 6);
    const from = today();
    const l4TooLong = { principal_id: P['sales-report-bot'], valid_from: from, valid_to: addMonths(from, 6) };
    await rejectsWith(submit('p04', l4Content(), l4TooLong), 'CONTENT_INVALID');
    const draft = await call(app, 'case_create', users.p04.session, DA, l4Content(), l4TooLong);
    assert.deepEqual(codesOf(draft.errors), ['VALIDITY_TOO_LONG']);
    const l4Ok = { ...l4TooLong, valid_to: addMonths(from, 6, -1) };
    assert.deepEqual((await call(app, 'case_revise', users.p04.session, draft.case_id, l4Content(), l4Ok)).errors, []);
    const l3 = { principal_id: P['業務分析部'], valid_from: from, valid_to: addMonths(from, 12) };
    assert.deepEqual(codesOf((await call(app, 'case_create', users.p04.session, DA, l3Content(), l3)).errors), ['VALIDITY_TOO_LONG']);
    l3.valid_to = addMonths(from, 12, -1);
    assert.deepEqual((await call(app, 'case_create', users.p04.session, DA, l3Content(), l3)).errors, []);
});

test('K-NO-BACKDATE 授權起日不能早於今天；起日不能晚於迄日', async () => {
    const back = { principal_id: P['業務分析部'], valid_from: today(-1), valid_to: addMonths(today(), 3) };
    const draft = await call(app, 'case_create', users.p04.session, DA, l3Content(), back);
    assert.deepEqual(
        draft.errors.map((e) => [e.path, e.code]),
        [['terms.valid_from', 'VALIDITY_BACKDATED']],
    );
    await rejectsWith(call(app, 'case_submit', users.p04.session, draft.case_id, null), 'CONTENT_INVALID');
    const reversed = { principal_id: P['業務分析部'], valid_from: addMonths(today(), 2), valid_to: addMonths(today(), 1) };
    assert.deepEqual(codesOf((await call(app, 'case_create', users.p04.session, DA, l3Content(), reversed)).errors), ['VALIDITY_ORDER']);
});

test('K-PRINCIPAL 被授權者是團隊、專案或 agent，一定有在職的負責人；專案與 agent 有結束日；沒選或不存在就不能送審', async () => {
    const list = await call(app, 'principal_list', users.p04.session);
    assert.deepEqual(
        list.map((p) => [p.kind, p.name, p.owner_name, p.ends_on !== null, p.mine]),
        // 林怡君自己負責的排在前面（送審時不必多一關負責人確認，D79 (2)）
        [
            ['agent', 'sales-report-bot', '林怡君', true, true],
            ['project', '北區客戶流失分析', '林怡君', true, true],
            ['agent', 'ap-recon-bot', '吳家豪', true, false],
            ['project', '季度業績看板', '蔡佩珊', true, false],
            ['team', '日本業務部', '鈴木大輔', false, false],
            ['team', '業務分析部', '陳建宏', false, false],
            ['team', '通路業務組', '劉俊傑', false, false],
        ],
    );
    const noPrincipal = await call(app, 'case_create', users.p04.session, DA, l3Content(), {
        valid_from: today(),
        valid_to: addMonths(today(), 1),
    });
    assert.deepEqual(codesOf(noPrincipal.errors), ['PRINCIPAL_REQUIRED']);
    const unknown = await call(app, 'case_create', users.p04.session, DA, l3Content(), terms('00000000-0000-0000-0000-000000000000'));
    assert.deepEqual(codesOf(unknown.errors), ['PRINCIPAL_UNKNOWN']);
});

test('K-CHANGE-REDUCE 資料擁有者縮小後核准：產生新版本、不用重簽、通知申請人；並行的另一位以新版本決定（K-VERSION-BOUND）', async () => {
    // 業務分析部的負責人是林怡君的主管陳建宏：他先簽負責人確認，主管關因此往上給方國華（D79 (2)、K-SOD-DISTINCT）
    const c = await submit('p04', l3Content(), terms(P['業務分析部'], 4));
    await decide(app, users.p03, c.case_id);
    assert.deepEqual((await view('p04', c.case_id)).waiting_on, ['方國華']);
    await decide(app, users.p02, c.case_id);
    const before = await issueChallenge(app, users.p09, c.case_id);
    // 張美玲把銷售訂單的列條件收緊、拿掉一個欄位，授權迄日縮短一個月
    const reduced = l3Content();
    reduced.scope[1].fields = ['order_no', 'amount'];
    const shorter = { ...terms(P['業務分析部'], 4), valid_to: addMonths(today(), 3) };
    const ch = await issueChallenge(app, users.p11, c.case_id, 'approve_reduced', { content: reduced, terms: shorter });
    assert.equal(ch.input.tier, 'L3');
    await decidePasskey(app, ch.challenge_id, 'approve_reduced', users.p11.key.assert(ch.challenge));
    const v = await view('p04', c.case_id);
    assert.equal(v.version, 2);
    assert.deepEqual(
        v.versions.map((x) => [x.version, x.change_kind, x.created_by_name]),
        [
            [1, 'initial', '林怡君'],
            [2, 'reduce', '張美玲'],
        ],
    );
    assert.equal(v.terms.valid_to, shorter.valid_to);
    assert.equal(v.stages.find((s) => s.code === 'manager').status, 'done', '縮小不用重簽：主管關仍然有效');
    const notified = await one(
        admin,
        `select count(*)::int as n from sgn.notification_outbox where case_id = $1 and event_code = 'case.reduced'`,
        [c.case_id],
    );
    assert.equal(notified.n, 1);
    // 周文傑在縮小之前拿的挑戰值綁的是第 1 版：不能用
    await rejectsWith(decidePasskey(app, before.challenge_id, 'approve', users.p09.key.assert(before.challenge)), 'CONTENT_CHANGED');
    await decide(app, users.p09, c.case_id);
    const tasks = (await view('p04', c.case_id)).stages.find((s) => s.code === 'data_owner').tasks;
    assert.deepEqual(tasks.map((t) => [t.assignee_name, t.decided_version]).sort(), [
        ['周文傑', 2],
        ['張美玲', 2],
    ]);
});

test('K-CHANGE-REDUCE 簽核人不能擴大：加欄位、改被授權者、延長授權迄日一律拒絕', async () => {
    const t = terms(P['業務分析部'], 4);
    const c = await submit('p04', l3Content({ purpose_description: '縮小測試' }), t);
    await decide(app, users.p03, c.case_id); // 業務分析部的負責人確認（D79 (2)）
    await decide(app, users.p02, c.case_id); // 主管關：陳建宏已簽過，往上給方國華

    const more = l3Content({ purpose_description: '縮小測試' });
    more.scope[1].fields.push('customer_id');
    await rejectsWith(issueChallenge(app, users.p11, c.case_id, 'approve_reduced', { content: more }), 'CHANGE_NOT_REDUCE');
    await rejectsWith(
        issueChallenge(app, users.p11, c.case_id, 'approve_reduced', { terms: { ...t, principal_id: P['通路業務組'] } }),
        'CHANGE_NOT_REDUCE',
    );
    await rejectsWith(
        issueChallenge(app, users.p11, c.case_id, 'approve_reduced', { terms: { ...t, valid_to: addMonths(today(), 5) } }),
        'CHANGE_NOT_REDUCE',
    );
    await rejectsWith(
        issueChallenge(app, users.p11, c.case_id, 'approve_reduced', { content: l3Content({ purpose_description: '改說明' }) }),
        'CHANGE_NOT_REDUCE',
    );
});

test('K-RETURN 退回後申請人只做縮小：從退回的那一關繼續；做了其他修改（擴大）：從第一關重簽', async () => {
    const t = terms(P['季度業績看板'], 3);
    const c = await submit('p04', l3Content({ purpose_description: '退回測試' }), t);
    await decide(app, users.p06, c.case_id); // 代填：季度業績看板的負責人蔡佩珊先確認（D79 (2)）
    await decide(app, users.p03, c.case_id);
    assert.equal(await decide(app, users.p11, c.case_id, 'return', { reason: '銷售訂單只能給北區' }), 'returned');
    // 只做縮小（拿掉客戶主檔）：從資料擁有者關繼續，主管關仍有效
    const reduced = l3Content({ purpose_description: '退回測試' });
    reduced.scope.shift();
    const revised = await call(app, 'case_revise', users.p04.session, c.case_id, reduced, t);
    assert.equal(revised.versions.at(-1).change_kind, 'reduce');
    // 送出前就看得到這次修改是縮小、會從退回的那一關繼續（不用重簽）
    assert.deepEqual(revised.resubmit, { change_kind: 'reduce', mode: 'resume' });
    assert.equal(c.resubmit, null);
    const resumed = await call(app, 'case_submit', users.p04.session, c.case_id, null);
    assert.equal(resumed.current_stage.code, 'data_owner');
    assert.deepEqual(resumed.waiting_on, ['張美玲'], '縮小後只剩銷售訂單：只有它的擁有者要簽');
    assert.equal(await decide(app, users.p11, c.case_id, 'return', { reason: '再請補充用途' }), 'returned');
    // 改了使用情境（擴大）：從第一關重簽
    await call(app, 'case_revise', users.p04.session, c.case_id, { ...reduced, purpose_description: '退回測試（補充）' }, t);
    const restarted = await call(app, 'case_submit', users.p04.session, c.case_id, null);
    // 第一關是負責人確認（D79 (2)）：擴大後負責人要重新確認，之後才是主管
    assert.equal(restarted.current_stage.code, 'principal_owner');
    assert.deepEqual(restarted.waiting_on, ['蔡佩珊']);
    await decide(app, users.p06, c.case_id);
    assert.deepEqual((await view('p04', c.case_id)).waiting_on, ['陳建宏']);
});

test('K-SOD-DISTINCT 主管同時是資料擁有者：資料擁有者關撞到同一人，往上一層主管找（張美玲 → 蘇慧敏）', async () => {
    const content = { ...l3Content({ purpose_description: '財務部的申請' }), scope: [l3Content().scope[1]] };
    const c = await submit('p12', content, terms(P['ap-recon-bot'], 3));
    assert.deepEqual(c.waiting_on, ['張美玲']);
    await decide(app, users.p11, c.case_id);
    const v = await view('p12', c.case_id);
    assert.equal(v.current_stage.code, 'data_owner');
    assert.deepEqual(v.waiting_on, ['蘇慧敏']);
    const basis = await one(admin, `select basis from sgn.case_task where case_id = $1 order by id desc limit 1`, [c.case_id]);
    assert.equal(basis.basis.path[0].denied, 'SOD_DISTINCT');
    await rejectsWith(issueChallenge(app, users.p11, c.case_id), 'NOT_APPROVER');
});

test('DA-OVERLAP-COVERED 被同一被授權者的單獨一筆有效授權完全涵蓋：草稿就看得到，送審被擋下（K-OVERLAP-BLOCK）', async () => {
    const subset = l3Content();
    subset.scope = [{ package: 'sales_order', fields: ['order_no'], row_filters: [{ filter: 'region', op: 'in', values: ['north'] }] }];
    subset.data_period = { from: '2025-03-01', to: '2025-06-30' };
    const inside = {
        principal_id: P['通路業務組'],
        valid_from: l3Grant.terms.valid_from,
        valid_to: addMonths(l3Grant.terms.valid_from, 2),
    };
    const draft = await call(app, 'case_create', users.p04.session, DA, subset, inside);
    assert.equal(draft.overlap.level, 'covered');
    assert.deepEqual(
        draft.overlap.items.map((i) => i.case_no),
        [l3Grant.case_no],
    );
    await rejectsWith(call(app, 'case_submit', users.p04.session, draft.case_id, '我還是想申請'), 'OVERLAP_COVERED');
    // 換一個被授權者就沒有重疊
    const other = await call(app, 'case_revise', users.p04.session, draft.case_id, subset, { ...inside, principal_id: P['業務分析部'] });
    assert.equal(other.overlap.level, 'none');
});

test('DA-OVERLAP-PARTIAL 部分重疊（多要了欄位、或期間超出）必須填理由才能送審，理由記在單上（K-OVERLAP-REASON）', async () => {
    const wider = l3Content();
    wider.scope[1].fields.push('customer_id');
    const t = { principal_id: P['通路業務組'], valid_from: l3Grant.terms.valid_from, valid_to: addMonths(l3Grant.terms.valid_from, 2) };
    const draft = await call(app, 'case_create', users.p04.session, DA, wider, t);
    assert.equal(draft.overlap.level, 'partial');
    await rejectsWith(call(app, 'case_submit', users.p04.session, draft.case_id, '  '), 'OVERLAP_REASON_REQUIRED');
    const submitted = await call(app, 'case_submit', users.p04.session, draft.case_id, '要多看客戶編號做對帳');
    assert.equal(submitted.state, 'in_approval');
    assert.deepEqual(
        { level: submitted.overlap.level, reason: submitted.overlap.reason },
        { level: 'partial', reason: '要多看客戶編號做對帳' },
    );
    assert.deepEqual(submitted.overlap.items[0].packages, [
        { package: 'customer_master', fields: ['customer_id', 'customer_name'] },
        { package: 'sales_order', fields: ['amount', 'order_date', 'order_no'] },
    ]);
    // 列條件沒有交集（南區）就不算重疊
    const south = l3Content();
    south.scope = [{ package: 'sales_order', fields: ['order_no'], row_filters: [{ filter: 'region', op: 'in', values: ['south'] }] }];
    assert.equal((await call(app, 'case_create', users.p04.session, DA, south, t)).overlap.level, 'none');
});
