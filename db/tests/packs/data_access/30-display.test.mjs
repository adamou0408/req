// 簽核畫面的顯示摘要（裁決 D75；紅隊第三輪 高-1，redteam/exploits/13-wysiwys-relabel.mjs）、角色關卡的替代持有人
// （D79 (4)）與內容相同的進行中申請（D79 (6)）。攻擊者模型：拿到後端，可以改寫任何回應（含顯示摘要），不能改頁面程式。
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { decisionContent } from '../../../../web/lib/signing.js';
import {
    call,
    challengeFor,
    closePools,
    decidePasskey,
    login,
    one,
    pool,
    registerPasskey,
    rejectsWith,
} from '../../kernel/lib/harness.mjs';
import { DA, decide, l3Content, l4Content, principals, terms } from './lib.mjs';

const app = pool('APP');
const admin = pool('ADMIN');
const users = {};
let P;

before(async () => {
    for (const uid of ['p01', 'p03', 'p04', 'p09', 'p11', 'p15', 'p19', 'p24', 'p27']) {
        users[uid] = await login(app, uid);
        users[uid].key = await registerPasskey(app, users[uid]);
    }
    P = await principals(app, users.p04.session);
});
after(closePools);

const submitTo = (who, content, t) => call(app, 'case_submit_new', users[who].session, DA, content, t, 'test overlap');

/** 送一張單；被既有授權完全涵蓋（前面的測試留下的授權）就換一個被授權者。 */
async function submit(who, content) {
    for (const id of Object.values(P)) {
        try {
            return await submitTo(who, content, terms(id));
        } catch (err) {
            if (!String(err.message).startsWith('OVERLAP_COVERED:')) throw err;
        }
    }
    throw new Error('找不到可送出的被授權者');
}
const view = (who, caseId) => call(app, 'case_get', users[who].session, caseId);
const clone = (x) => JSON.parse(JSON.stringify(x));

/** 扮演瀏覽器：照「畫面上的」顯示摘要（可能被後端改寫過）算挑戰值並簽。 */
async function signShown(person, caseId, shown, decision = 'approve', input = {}) {
    const ch = await call(app, 'challenge_issue', person.session, caseId, decision, input);
    const content = await decisionContent(
        shown,
        decision,
        decision === 'approve_reduced' ? { ...ch.input, display: input.display ?? ch.display } : input,
    );
    const challenge = await challengeFor({ purpose: 'case.decision', ref: shown.case_no, content, decision, nonce: ch.nonce });
    return decidePasskey(app, ch.challenge_id, decision, person.key.assert(challenge));
}

test('K-DISPLAY-SIGNED 紅隊第三輪 高-1 回歸：簽的是顯示摘要——後端改寫摘要裡任何一個顯示字（名稱、級別、例外、名字、重疊、差異、下一關），簽章就對不上', async () => {
    const c = await submit('p04', l4Content({ purpose_description: `display ${Math.random()}` }));
    const d = (await view('p03', c.case_id)).display;
    // 摘要裡是字，不是代碼：主題包與欄位的名稱與分級、級別、名字
    assert.equal(d.tier.code, 'L4');
    assert.equal(d.content.scope[0].package_name, '員工薪資');
    assert.ok(d.content.scope[0].fields.some((f) => f.name === '實發金額' && f.classification === 'L4'));
    assert.equal(d.applicant.id, users.p04.personId);
    assert.ok(Object.keys(P).includes(d.principal.name));
    assert.ok(d.principal.owner.name);
    assert.equal(d.stage.current, '申請人主管');
    const mutations = {
        主題包名稱: (x) => (x.content.scope[0].package_name = '銷售訂單'),
        欄位名稱: (x) => (x.content.scope[0].fields[0].name = '訂單編號'),
        欄位分級: (x) => (x.content.scope[0].fields[0].classification = 'L2'),
        級別: (x) => (x.tier = { code: 'L2', name: 'L2' }),
        例外: (x) => x.exceptions.push({ id: '1', rule_code: 'K-HR-SYNC' }),
        申請人名字: (x) => (x.applicant.name = '王志明'),
        被授權者名字: (x) => (x.principal.name = `${x.principal.name}（改）`),
        負責人名字: (x) => (x.principal.owner.name = '某人'),
        使用情境: (x) => (x.content.purpose.description = '別的用途'),
        可否匯出: (x) => (x.content.export_allowed = true),
        重疊: (x) => (x.overlap = { level: x.overlap?.level === 'none' ? 'partial' : 'none', reason: null, items: [] }),
        與前一版的差異: (x) => (x.baseline = { ...clone(x), version: '0' }),
        下一關: (x) => (x.stage.next = '核准完成'),
        多出來的欄位: (x) => (x.note = '後端加的說明'),
    };
    for (const [label, mutate] of Object.entries(mutations)) {
        const forged = clone(d);
        mutate(forged);
        await assert.rejects(signShown(users.p03, c.case_id, forged), (err) => {
            assert.ok(String(err.message).startsWith('SIGNED_CONTENT_MISMATCH:'), `${label}：${err.message}`);
            return true;
        });
    }
    // 另一張單的摘要（後端拿 B 單的畫面給人看）也對不上
    const other = await submit('p04', l3Content({ purpose_description: `other ${Math.random()}` }));
    await rejectsWith(signShown(users.p03, c.case_id, (await view('p03', other.case_id)).display), 'SIGNED_CONTENT_MISMATCH');
    // 誠實的畫面：成立；決定證明存了簽下去的摘要原文，鏈上只有雜湊（不放名字）
    assert.equal(await signShown(users.p03, c.case_id, d), 'in_approval');
    const proof = await one(
        admin,
        `select d.display_snapshot from sgn.decision_proof d join sgn.auth_challenge c on c.id = d.challenge_id
         where c.binding ->> 'case_id' = $1 order by d.created_at desc limit 1`,
        [c.case_id],
    );
    assert.deepEqual(proof.display_snapshot, d);
    const event = await one(
        admin,
        `select convert_from(body, 'UTF8') as body from sgn.audit_event where case_id = $1 and event_type = 'case.approve'`,
        [c.case_id],
    );
    assert.match(event.body, /display_sha256/);
    assert.ok(!event.body.includes('員工薪資') && !event.body.includes(d.applicant.name), '鏈上不放顯示的文字');
});

test('K-DISPLAY-SIGNED 縮小後核准：縮小後那一版的顯示也簽進去，後端改寫它就對不上', async () => {
    const description = `reduce ${Math.random()}`;
    const c = await submit('p04', l3Content({ purpose_description: description }));
    const d = (await view('p03', c.case_id)).display;
    const reduced = {
        content: l3Content({
            purpose_description: description,
            scope: [
                { package: 'customer_master', fields: ['customer_id'], row_filters: [{ filter: 'region', op: 'in', values: ['north'] }] },
            ],
        }),
        terms: terms(d.principal.id, 3),
    };
    const issued = await call(app, 'challenge_issue', users.p03.session, c.case_id, 'approve_reduced', reduced);
    assert.equal(issued.display.content.scope.length, 1);
    assert.equal(issued.display.content.scope[0].package_name, '客戶主檔');
    const forgedReduced = clone(issued.display);
    forgedReduced.content.scope[0].fields[0].name = '別的欄位';
    await rejectsWith(
        signShown(users.p03, c.case_id, d, 'approve_reduced', { ...reduced, display: forgedReduced }),
        'SIGNED_CONTENT_MISMATCH',
    );
    assert.equal(await signShown(users.p03, c.case_id, d, 'approve_reduced', reduced), 'in_approval');
});

test('K-SOD-ROLE-ESCALATED 角色關卡的持有人因職責分離不合格：先找同一角色的其他持有人；都不合格才升級並開例外', async () => {
    const exceptions = async (caseId) =>
        (
            await admin.query(
                `select rule_code, detail from sgn.exception_record where case_id = $1 and rule_code = 'K-SOD-ROLE-ESCALATED'`,
                [caseId],
            )
        ).rows;
    const toCiso = async (caseId) => {
        await decide(app, users.p01, caseId); // 申請人 p19 的主管
        await decide(app, users.p15, caseId); // 薪資的資料擁有者
        return view('p19', caseId);
    };
    // 唯一的資安長就是申請人：沒有其他持有人 → 升級（主管線走到頂，交給最終決定者）並開例外
    const first = await submit('p19', l4Content({ purpose_description: `ciso ${Math.random()}` }));
    let v = await toCiso(first.case_id);
    assert.equal(v.current_stage.code, 'ciso');
    assert.deepEqual(v.waiting_on, ['郭永昌']);
    const [ex] = await exceptions(first.case_id);
    assert.equal(ex.detail.role, 'ciso');
    assert.equal(ex.detail.via, 'top_resolver');
    // 有第二位資安長：直接由他簽（不升級、不開例外）
    await admin.query(
        `insert into sgn.role_assignment (person_id, role_code, valid_from, source) values ($1, 'ciso', clock_timestamp(), 'manual')`,
        [users.p24.personId],
    );
    try {
        const second = await submit('p19', l4Content({ purpose_description: `ciso2 ${Math.random()}` }));
        v = await toCiso(second.case_id);
        assert.deepEqual(v.waiting_on, ['葉佳蓉']);
        assert.deepEqual(await exceptions(second.case_id), []);
        const basis = await one(
            admin,
            `select t.basis from sgn.case_task t join sgn.case_stage s on s.id = t.stage_id
             join sgn.policy_stage ps on ps.policy_id = s.policy_id and ps.seq = s.seq where t.case_id = $1 and ps.code = 'ciso'`,
            [second.case_id],
        );
        // 固定順序裡申請人 p19 排在前面就是「替代持有人」，排在後面就是直接找到
        const order = (await one(admin, `select sgn_internal.role_holders('ciso') as h`)).h;
        assert.equal(basis.basis.via, order[0] === users.p19.personId ? 'role_alternate' : 'direct');
    } finally {
        await admin.query(
            `update sgn.role_assignment set valid_to = clock_timestamp() where person_id = $1 and role_code = 'ciso' and valid_to is null`,
            [users.p24.personId],
        );
    }
});

test('K-DUPLICATE-NOTICE 內容完全相同的進行中申請：送出時提示並連到既有的那張，不擋送出', async () => {
    const content = l3Content({ purpose_description: `dup ${Math.random()}` });
    const a = await submit('p04', content);
    assert.deepEqual(a.duplicates, []);
    const t = { principal_id: a.terms.principal.principal_id, valid_from: a.terms.valid_from, valid_to: a.terms.valid_to };
    const b = await submitTo('p04', content, t);
    assert.equal(b.state, 'in_approval');
    assert.deepEqual(b.duplicates, [{ case_id: a.case_id, case_no: a.case_no }]);
    // 內容不同就不算
    const c = await submitTo('p04', { ...content, purpose_description: `${content.purpose_description} 改` }, t);
    assert.deepEqual(c.duplicates, []);
});
