// 代填申請的被授權者負責人確認（裁決 D79 (2)；紅隊第三輪 推論 I4，redteam/exploits/18-round2-inferences.mjs）。
// 威脅表見 docs/handoff/leftovers-1.md 第 1 節：每一列對應這裡的一個斷言（列號寫在註解）。
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { call, closePools, issueChallenge, login, one, pool, registerPasskey, rejectsWith } from '../../kernel/lib/harness.mjs';
import { DA, decide, l3Content, principals, terms } from './lib.mjs';

const app = pool('APP');
const admin = pool('ADMIN');
const users = {};
let P;

before(async () => {
    for (const uid of ['p02', 'p03', 'p04', 'p05', 'p06', 'p33']) {
        users[uid] = await login(app, uid);
        users[uid].key = await registerPasskey(app, users[uid]);
    }
    P = await principals(app, users.p04.session);
});
after(closePools);

const submit = (who, t, description, extraTerms = {}) =>
    call(
        app,
        'case_submit_new',
        users[who].session,
        DA,
        l3Content({ purpose_description: `${description} ${Math.random()}` }),
        { ...t, ...extraTerms },
        'test',
    );
const view = (who, caseId) => call(app, 'case_get', users[who].session, caseId);

test('K-PRINCIPAL-OWNER-CONFIRM 代填：申請人不是被授權者的負責人，第一關是負責人確認，負責人收到通知、用通行金鑰簽顯示摘要；負責人本人申請不加這一關', async () => {
    // 列 1：王志明替蔡佩珊負責的「季度業績看板」送單
    const c = await submit('p05', terms(P['季度業績看板'], 2), 'delegated');
    assert.equal(c.current_stage.code, 'principal_owner');
    assert.equal(c.current_stage.name, '被授權者負責人確認');
    assert.deepEqual(c.waiting_on, ['蔡佩珊']);
    assert.deepEqual(
        c.path.map((s) => s.code),
        ['principal_owner', 'manager', 'data_owner', 'mis', 'fulfil'],
    );
    const notified = await one(
        admin,
        `select count(*)::int as n from sgn.notification_outbox where case_id = $1 and event_code = 'case.task_assigned' and person_id = $2`,
        [c.case_id, users.p06.personId],
    );
    assert.equal(notified.n, 1);
    // 負責人看到的決定畫面：顯示摘要裡就是這一關、這個被授權者與負責人
    const shown = (await view('p06', c.case_id)).display;
    assert.equal(shown.stage.current, '被授權者負責人確認');
    assert.equal(shown.principal.owner.id, users.p06.personId);
    // 列 3：申請人與其他人都不能替負責人確認
    await rejectsWith(issueChallenge(app, users.p05, c.case_id), 'SELF_APPROVAL');
    await rejectsWith(issueChallenge(app, users.p03, c.case_id), 'NOT_APPROVER');
    assert.equal(await decide(app, users.p06, c.case_id), 'in_approval');
    const after = await view('p05', c.case_id);
    assert.equal(after.current_stage.code, 'manager');
    assert.deepEqual(after.waiting_on, ['陳建宏']);
    const event = await one(
        admin,
        `select convert_from(body, 'UTF8')::jsonb as body from sgn.audit_event where case_id = $1 and event_type = 'case.stage_opened' order by seq limit 1`,
        [c.case_id],
    );
    assert.equal(event.body.data.stage, 'principal_owner');
    assert.equal(event.body.data.tasks[0].basis.resolver, 'principal_owner');
    assert.equal(event.body.data.tasks[0].basis.owner, users.p06.personId);

    // 列 2：林怡君替自己負責的「北區客戶流失分析」送單：沒有這一關
    const own = await submit('p04', terms(P['北區客戶流失分析'], 2), 'own');
    assert.equal(own.current_stage.code, 'manager');
    assert.deepEqual(
        own.path.map((s) => s.code),
        ['manager', 'data_owner', 'mis', 'fulfil'],
    );
    // 列 8：terms 裡多帶的鍵（後端假稱「這是你的」）不影響路徑：關卡只由資料庫依被授權者的負責人決定
    const claimed = await submit('p05', terms(P['季度業績看板'], 2), 'claimed', { mine: true, owner_person_id: users.p05.personId });
    assert.equal(claimed.current_stage.code, 'principal_owner');
    assert.deepEqual(claimed.waiting_on, ['蔡佩珊']);
});

test('K-PRINCIPAL-OWNER-CONFIRM 負責人與後續關卡職責分離：負責人是申請人的主管時，主管關往上一層（K-SOD-DISTINCT）；換被授權者算擴大，從第一關由新的負責人確認', async () => {
    // 列 6：業務分析部的負責人陳建宏就是林怡君的主管
    const c = await submit('p04', terms(P['業務分析部'], 2), 'sod');
    assert.deepEqual(c.waiting_on, ['陳建宏']);
    await decide(app, users.p03, c.case_id);
    const v = await view('p04', c.case_id);
    assert.equal(v.current_stage.code, 'manager');
    assert.deepEqual(v.waiting_on, ['方國華']);
    const basis = await one(admin, `select basis from sgn.case_task where case_id = $1 order by id desc limit 1`, [c.case_id]);
    assert.equal(basis.basis.path[0].denied, 'SOD_DISTINCT');
    // 列 4：退回後把被授權者換成日本業務部（擴大）→ 從第一關重簽，負責人確認依新的被授權者（鈴木大輔）
    assert.equal(await decide(app, users.p02, c.case_id, 'return', { reason: '被授權者不對' }), 'returned');
    const t = terms(P['日本業務部'], 2);
    const revised = await call(app, 'case_revise', users.p04.session, c.case_id, v.content, t);
    assert.equal(revised.versions.at(-1).change_kind, 'expand');
    // 送出前就看得到：擴大、從第一關重簽（K-RETURN）
    assert.deepEqual(revised.resubmit, { change_kind: 'expand', mode: 'restart' });
    assert.deepEqual(
        revised.path.map((s) => s.code),
        ['principal_owner', 'manager', 'data_owner', 'mis', 'fulfil'],
    );
    const restarted = await call(app, 'case_submit', users.p04.session, c.case_id, null);
    assert.equal(restarted.current_stage.code, 'principal_owner');
    assert.deepEqual(restarted.waiting_on, ['鈴木大輔']);
    await decide(app, users.p33, c.case_id);
    // 重簽時之前的關卡作廢：陳建宏又是主管了
    assert.deepEqual((await view('p04', c.case_id)).waiting_on, ['陳建宏']);
});

test('K-PRINCIPAL-OWNER-CONFIRM 負責人不能簽核（持有被排除的角色）：沿他的主管線升級並開例外，讓人來看', async () => {
    // 列 7：蔡佩珊暫時持有稽核角色（approval.excluded_decider_roles）
    await admin.query(
        `insert into sgn.role_assignment (person_id, role_code, valid_from, source) values ($1, 'auditor', clock_timestamp(), 'manual')`,
        [users.p06.personId],
    );
    try {
        const c = await submit('p05', terms(P['季度業績看板'], 2), 'excluded');
        assert.equal(c.current_stage.code, 'principal_owner');
        assert.deepEqual(c.waiting_on, ['陳建宏']);
        const { rows } = await admin.query(
            `select detail from sgn.exception_record where case_id = $1 and rule_code = 'K-PRINCIPAL-OWNER-CONFIRM'`,
            [c.case_id],
        );
        assert.equal(rows.length, 1);
        assert.equal(rows[0].detail.via, 'manager_chain');
        assert.equal(rows[0].detail.path[0].denied, 'DECIDER_ROLE_EXCLUDED');
    } finally {
        await admin.query(
            `update sgn.role_assignment set valid_to = clock_timestamp() where person_id = $1 and role_code = 'auditor' and valid_to is null`,
            [users.p06.personId],
        );
    }
});

test('K-PRINCIPAL-OWNER-CONFIRM 路徑的適用條件是資料：只收已知的條件，流程類型沒有被授權者就不能用', async () => {
    const bad = async (stage) =>
        rejectsWith(
            admin.query(`select sgn_internal.register_approval_policy('probe', $1)`, [
                JSON.stringify({
                    top_resolver_role: null,
                    stages: [{ seq: 1, code: 'x', name: 'x', phase: 'approval', side: 'demand', mode: 'one', ...stage }],
                }),
            ]),
            'REGISTRATION_INVALID',
        );
    await bad({ resolver: { kind: 'principal_owner' }, applies_when: null });
    await bad({ resolver: { kind: 'applicant_manager' }, applies_when: { applicant_not_principal_owner: true } });
    await bad({ resolver: { kind: 'applicant_manager' }, applies_when: { applicant_is_anyone: true } });
});

test('K-PRINCIPAL-OWNER-CONFIRM 被授權者 id 只認標準寫法：前後空白、大括號、大寫都以錯誤目錄的 PRINCIPAL_UNKNOWN 拒絕，不回原始的 SQLSTATE（紅隊第四輪 資訊 2）', async () => {
    const id = P['季度業績看板'];
    for (const variant of [` ${id} `, `{${id}}`, id.toUpperCase(), 'not-a-uuid']) {
        const draft = await call(
            app,
            'case_create',
            users.p05.session,
            DA,
            l3Content({ purpose_description: `variant ${Math.random()}` }),
            terms(variant, 2),
        );
        assert.deepEqual(
            draft.errors.filter((e) => e.path === 'terms.principal_id').map((e) => e.code),
            ['PRINCIPAL_UNKNOWN'],
            JSON.stringify(variant),
        );
        await rejectsWith(submit('p05', terms(variant, 2), `variant ${variant}`), 'CONTENT_INVALID');
    }
});
