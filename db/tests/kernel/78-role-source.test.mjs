// 角色指派的來源（K-ROLE-SOURCE、K-AUDITOR-INDEPENDENT；紅隊 redteam/findings.md 高-1 與推論未驗證-1）。
// 攻擊者模型：拿到人員同步帳號（sgn_sync），可以送任意內容的同步。
// 先把攻擊腳本 redteam/exploits/01-sync-role-injection.mjs 變成回歸測試，再測平台內的角色指派變更與業務角色的冷卻期。
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readDirectory, syncDirectory } from '../../tools/directory-sync.mjs';
import { verifyChain } from '../../tools/chain-lib.mjs';
import { roleUrl } from '../../tools/lib/env.mjs';
import {
    call,
    closePools,
    config,
    decidePasskey,
    decideRole,
    issueChallenge,
    login,
    one,
    pool,
    proposeRole,
    registerPasskey,
    rejectsWith,
    settleSyncChanges,
} from './lib/harness.mjs';

const app = pool('APP');
const admin = pool('ADMIN');
const syncDb = pool('SYNC');
const users = {};
let snapshot;

const sync = async (kind, entries) =>
    (
        await syncDb.query('select api_sync.directory_apply($1, $2, $3, $4) as r', [
            'sim-ldap',
            kind,
            entries.length,
            JSON.stringify(entries),
        ])
    ).rows[0].r;
const entryOf = (uid, changes = {}) => ({ ...snapshot.find((e) => e.external_id === uid), ...changes });
const holders = async (role, scope = null) => (await one(admin, 'select sgn_internal.role_holders($1, $2) as h', [role, scope])).h;
const hasRole = async (personId, role) => (await one(admin, 'select sgn_internal.has_role($1, $2) as v', [personId, role])).v;
const exceptionOf = (id) => one(admin, 'select rule_code, detail from sgn.exception_record where id = $1', [id]);

before(async () => {
    snapshot = await readDirectory(config);
    for (const uid of ['p03', 'p04', 'p05', 'p16', 'p19', 'p21', 'p22', 'p23', 'p25', 'p27', 'p28', 'p29'])
        users[uid] = await login(app, uid);
    // 提出也要通行金鑰（D68）：提出人 p16、p21、p27 也登記
    for (const uid of ['p03', 'p05', 'p16', 'p19', 'p21', 'p23', 'p25', 'p27', 'p28', 'p29'])
        users[uid].key = await registerPasskey(app, users[uid]);
});
after(async () => {
    await syncDirectory(config);
    for (const uid of ['p04', 'p05', 'p09']) await settleSyncChanges(admin, users[uid]?.personId ?? (await personOf(uid)));
    await closePools();
});

const personOf = async (uid) =>
    (await one(admin, `select person_id from sgn.person_identity where source = 'sim-ldap' and external_id = $1`, [uid])).person_id;

async function auditReadable(user) {
    const me = await call(app, 'me', user.session);
    try {
        await call(app, 'audit_chain', user.session, 0, 5);
        return { capabilities: me.capabilities, chain: true };
    } catch (err) {
        return { capabilities: me.capabilities, chain: String(err.message).split(':')[0] };
    }
}

test('K-ROLE-SOURCE 紅隊 高-1 回歸：同步帳號不能把稽核角色塞給一般員工——不宣告種類的呼叫不存在；宣告成增量也不套用，並開例外', async () => {
    const before = await auditReadable(users.p04);
    assert.deepEqual(before, { capabilities: ['case.submit'], chain: 'AUDITOR_REQUIRED' });
    // 攻擊腳本的同一批資料（連同主管 p03，避免主管被洗掉）
    const forged = [entryOf('p03', { roles: [] }), entryOf('p04', { roles: ['auditor'] })];
    await assert.rejects(syncDb.query('select api_sync.directory_apply($1, $2::jsonb)', ['sim-ldap', JSON.stringify(forged)]), (err) => {
        assert.equal(err.code, '42883', err.message);
        return true;
    });
    const result = await sync('incremental', forged);
    assert.equal(result.roles_not_applied, 1);
    assert.equal(result.exceptions.length, 1);
    assert.deepEqual(await auditReadable(users.p04), before, '注入後 p04 仍然不能看稽核');
    const assigned = await one(admin, `select count(*)::int as n from sgn.role_assignment where person_id = $1 and role_code = 'auditor'`, [
        users.p04.personId,
    ]);
    assert.equal(assigned.n, 0);
    const exception = await exceptionOf(result.exceptions[0]);
    assert.equal(exception.rule_code, 'K-ROLE-SOURCE');
    assert.equal(exception.detail.kind, 'role_not_syncable');
    assert.deepEqual(exception.detail.claims, [{ person: users.p04.personId, role: 'auditor' }]);
    // 稽核人員看得到這筆例外
    const seen = await call(app, 'audit_exceptions', users.p22.session);
    assert.ok(seen.some((x) => x.id === result.exceptions[0] && x.rule_code === 'K-ROLE-SOURCE'));
    // 同樣的說法再送一次：仍然不套用；已經開過例外的說法不重複開
    const again = await sync('incremental', forged);
    assert.deepEqual([again.roles_not_applied, again.exceptions], [0, []]);
    assert.deepEqual(await auditReadable(users.p04), before);
    // 宣告成完整快照：只有兩個人，與現況差異超過門檻，整批拒絕
    const full = await sync('full', forged);
    assert.equal(full.rejected, true);
    assert.equal((await exceptionOf(full.exceptions[0])).rule_code, 'K-HR-SYNC');
    await sync('incremental', [entryOf('p03'), entryOf('p04')]);
});

test('K-ROLE-SOURCE 推論未驗證-1 回歸：同步帳號注入 mis 不能讓一般員工認領資安合規檢查關', async () => {
    const result = await sync(
        'full',
        snapshot.map((e) => (e.external_id === 'p05' ? { ...e, roles: [...e.roles, 'mis'] } : e)),
    );
    assert.equal(result.rejected, false);
    assert.equal(result.roles_not_applied, 1);
    assert.ok(!(await holders('mis')).includes(users.p05.personId));
    // 主管核准後進入 mis 群組認領的關卡（db/testing 的 probe_chain）：p05 認領不到
    const c = await call(app, 'case_submit_new', users.p04.session, 'probe_chain', { dataset: 'mis-injection' }, {}, null);
    const ch = await issueChallenge(app, users.p03, c.case_id);
    await decidePasskey(app, ch.challenge_id, 'approve', users.p03.key.assert(ch.challenge));
    await rejectsWith(call(app, 'task_claim', users.p05.session, c.case_id), 'NOT_CLAIMABLE');
    await syncDirectory(config);
});

test('K-ROLE-SOURCE 業務類角色（資料擁有者）可由同步帶入，但有冷卻期並開例外：期間內新持有人不算、原持有人仍算', async () => {
    const p09 = await personOf('p09');
    const before = await holders('data_owner');
    assert.ok(before.includes(p09));
    const result = await sync('incremental', [
        entryOf('p05', { roles: ['data_owner'] }),
        entryOf('p09', { roles: entryOf('p09').roles.filter((r) => r !== 'data_owner') }),
    ]);
    assert.equal(result.role_changes, 2);
    const exception = await exceptionOf(result.exceptions[0]);
    assert.equal(exception.rule_code, 'K-ROLE-SOURCE');
    assert.equal(exception.detail.kind, 'business_role_from_sync');
    assert.equal(exception.detail.cooling_workdays, 1);
    // 冷卻期內：原持有人仍算、新持有人還不算
    assert.deepEqual(await holders('data_owner'), before);
    assert.equal(await hasRole(users.p05.personId, 'data_owner'), false);
    const events = await admin.query(
        `select convert_from(body, 'UTF8')::jsonb #>> '{data,change}' as change from sgn.audit_event
         where event_type = 'directory.role_changed' order by seq desc limit 2`,
    );
    assert.deepEqual(events.rows.map((r) => r.change).sort(), ['add', 'remove']);
    // 過了冷卻期（測試用的管理者連線把起點往前移，模擬時間經過）
    await settleSyncChanges(admin, users.p05.personId);
    await settleSyncChanges(admin, p09);
    const after = await holders('data_owner');
    assert.ok(after.includes(users.p05.personId));
    assert.ok(!after.includes(p09));
    await sync('incremental', [entryOf('p05'), entryOf('p09')]);
    await settleSyncChanges(admin, users.p05.personId);
    await settleSyncChanges(admin, p09);
    assert.deepEqual(await holders('data_owner'), before);
});

// 提出與核准都以通行金鑰（D68）：測試扮演提出人、核准人的瀏覽器（harness 的 proposeRole、decideRole）
const propose = (by, holder, role, change = 'grant', scope = null) =>
    proposeRole(app, users[by], { holderId: holder.personId, role, scope, change, reason: '測試' });
const approve = (by, requestId, key = users[by].key) => decideRole(app, users[by], requestId, 'approve', key);
const challengeFor = (by, requestId, decision = 'approve') => call(app, 'role_change_challenge', users[by].session, requestId, decision);

test('K-ROLE-SOURCE 控制類角色只能在平台內指派：一人提出、另一位有權的人用通行金鑰核准（不得是提出人或被指派的人），寫進稽核鏈', async () => {
    assert.ok((await call(app, 'me', users.p16.session)).capabilities.includes('role_change'));
    assert.ok(!(await call(app, 'me', users.p04.session)).capabilities.includes('role_change'));
    assert.deepEqual(await call(app, 'role_change_options', users.p04.session), { roles: [], people: [], scopes: [] });
    await rejectsWith(propose('p04', users.p05, 'security_responder'), 'ROLE_CHANGE_NOT_PROPOSER');
    await rejectsWith(propose('p16', users.p05, 'no_such_role'), 'ROLE_UNKNOWN');
    const request = await propose('p16', users.p05, 'security_responder');
    assert.equal(request.status, 'pending');
    assert.deepEqual(request.actions, []);
    // 同一個人、同一個角色同時只能有一張待核准的變更；沒有這個指派就不能撤除
    await rejectsWith(propose('p16', users.p05, 'security_responder'), 'ROLE_CHANGE_PENDING');
    await rejectsWith(propose('p16', users.p05, 'ciso', 'revoke'), 'ROLE_CHANGE_NOOP');
    await rejectsWith(challengeFor('p16', request.request_id), 'ROLE_CHANGE_SELF');
    await rejectsWith(challengeFor('p05', request.request_id), 'ROLE_CHANGE_SELF');
    await rejectsWith(challengeFor('p04', request.request_id), 'ROLE_CHANGE_NOT_APPROVER');
    // 待核准的人在清單上看得到「核准」
    const listed = (await call(app, 'role_change_list', users.p19.session)).find((r) => r.request_id === request.request_id);
    assert.deepEqual(listed.actions, ['approve']);
    // 挑戰值發給 p23，拿 p19 的通行金鑰簽：被擋
    await rejectsWith(approve('p23', request.request_id, users.p19.key), 'CHALLENGE_PURPOSE');
    assert.equal(await hasRole(users.p05.personId, 'security_responder'), false);
    const approved = await approve('p19', request.request_id);
    assert.equal(approved.status, 'approved');
    assert.equal(approved.display.approved_by.name, '賴政達');
    assert.equal(await hasRole(users.p05.personId, 'security_responder'), true);
    await rejectsWith(challengeFor('p23', request.request_id), 'ROLE_CHANGE_STATE');
    // 鏈上：提出與核准各一筆，核准附通行金鑰的證明
    const approvedEvent = await one(
        admin,
        `select actor_person_id, convert_from(body, 'UTF8')::jsonb -> 'data' as data from sgn.audit_event
         where event_type = 'role.change_approved' order by seq desc limit 1`,
    );
    assert.equal(approvedEvent.actor_person_id, users.p19.personId);
    assert.equal(approvedEvent.data.proof_kind, 'passkey');
    assert.equal(approvedEvent.data.request_id, request.request_id);
    // 撤除也走同一個流程
    const revoke = await propose('p16', users.p05, 'security_responder', 'revoke');
    await approve('p23', revoke.request_id);
    assert.equal(await hasRole(users.p05.personId, 'security_responder'), false);
    const chain = await verifyChain({ dbUrl: roleUrl(config, 'JOB') });
    assert.equal(chain.ok, true, JSON.stringify(chain.problems.slice(0, 3)));
});

test('K-AUDITOR-INDEPENDENT 稽核角色的指派：稽核主管提出、稽核治理人核准；被指派的人不能核准；技術維運不得提出或核准', async () => {
    await rejectsWith(propose('p16', users.p04, 'auditor'), 'ROLE_CHANGE_NOT_PROPOSER');
    // 被指派的人自己不能核准：唯一能核准稽核角色的稽核治理人，本身就不能同時持有稽核角色（衝突矩陣 K-ADMIN-SOD，D69），
    // 所以這個情境在提出時就被擋下（原本的測試是提出成功、核准時 ROLE_CHANGE_SELF）
    await rejectsWith(propose('p21', users.p28, 'auditor'), 'ROLE_CONFLICT');
    const request = await propose('p21', users.p04, 'auditor');
    await rejectsWith(challengeFor('p19', request.request_id), 'ROLE_CHANGE_NOT_APPROVER');
    // 技術維運就算同時持有稽核治理人、稽核主管，也不能經手稽核角色（管理者連線直接給角色，模擬設定錯誤）
    await admin.query(
        `insert into sgn.role_assignment (person_id, role_code, valid_from, source)
         select $1, r, clock_timestamp(), 'manual' from unnest(array['audit_governor', 'audit_head']) as r`,
        [users.p29.personId],
    );
    try {
        await rejectsWith(challengeFor('p29', request.request_id), 'ROLE_CHANGE_EXCLUDED');
        await rejectsWith(propose('p29', users.p05, 'auditor'), 'ROLE_CHANGE_EXCLUDED');
    } finally {
        await admin.query(
            `update sgn.role_assignment set valid_to = clock_timestamp()
             where person_id = $1 and role_code in ('audit_governor', 'audit_head') and valid_to is null`,
            [users.p29.personId],
        );
    }
    await approve('p28', request.request_id);
    assert.ok((await auditReadable(users.p04)).capabilities.includes('audit'));
    const revoke = await propose('p21', users.p04, 'auditor', 'revoke');
    await approve('p28', revoke.request_id);
    assert.deepEqual(await auditReadable(users.p04), { capabilities: ['case.submit'], chain: 'AUDITOR_REQUIRED' });
});

/** 管理者連線直接結束這次測試加上的平台內指派（收尾用）。 */
const endManual = (personId, role, scope = null) =>
    admin.query(
        `update sgn.role_assignment set valid_to = clock_timestamp()
         where person_id = $1 and role_code = $2 and scope_ref is not distinct from $3 and source = 'manual'
           and (valid_to is null or valid_to > clock_timestamp())`,
        [personId, role, scope],
    );

test('K-ADMIN-SOD 衝突矩陣在提出與核准時檢查：流程管理者不得同時是控制負責人；技術維運不得是稽核', async () => {
    await rejectsWith(propose('p25', users.p16, 'control_owner'), 'ROLE_CONFLICT');
    await rejectsWith(propose('p21', users.p29, 'auditor'), 'ROLE_CONFLICT');
    // 提出時沒有衝突、核准前才出現衝突：核准時重新檢查
    const request = await propose('p16', users.p05, 'tech_ops');
    await admin.query(
        `insert into sgn.role_assignment (person_id, role_code, valid_from, source) values ($1, 'key_custodian', clock_timestamp(), 'manual')`,
        [users.p05.personId],
    );
    try {
        await rejectsWith(approve('p19', request.request_id), 'ROLE_CONFLICT');
        assert.equal(await hasRole(users.p05.personId, 'tech_ops'), false);
    } finally {
        await endManual(users.p05.personId, 'key_custodian');
        await admin.query(`delete from sgn.role_change_request where id = $1`, [request.request_id]);
    }
});

test('K-ROLE-CHANGE-GOVERNANCE 紅隊第二輪 高-4 回歸：流程管理者與控制負責人兩人串通，接管不了稽核治理、範圍與自我繁殖都被擋', async () => {
    // a. 同一人同時持有流程管理者與控制負責人（衝突矩陣）
    await rejectsWith(propose('p16', users.p16, 'control_owner'), 'ROLE_CONFLICT');
    // b. 撤除唯一的稽核治理人、把稽核治理人授予業務側的人：經手人不得持有流程管理、控制負責人、技術維運；不能撤最後一位
    await rejectsWith(propose('p16', users.p28, 'audit_governor', 'revoke'), 'ROLE_CHANGE_EXCLUDED');
    await rejectsWith(propose('p16', users.p16, 'audit_governor'), 'ROLE_CHANGE_EXCLUDED');
    await rejectsWith(propose('p21', users.p28, 'audit_governor', 'revoke'), 'ROLE_LAST_HOLDER');
    // c. 範圍：沒登記的範圍不能指派；只限某範圍的流程管理者不能提出全域的指派
    await rejectsWith(propose('p16', users.p05, 'process_admin', 'grant', 'process:none'), 'ROLE_CHANGE_SCOPE_UNKNOWN');
    await admin.query(
        `update sgn.role_assignment set scope_ref = 'process:probe' where person_id = $1 and role_code = 'process_admin' and valid_to is null`,
        [users.p25.personId],
    );
    try {
        await rejectsWith(propose('p25', users.p05, 'ciso'), 'ROLE_CHANGE_SCOPE_NOT_COVERED');
    } finally {
        await admin.query(
            `update sgn.role_assignment set scope_ref = null where person_id = $1 and role_code = 'process_admin' and valid_to is null`,
            [users.p25.personId],
        );
    }
    // d. 業務類角色（資料擁有者）由同步帶入，不能在平台內帶任意範圍指派
    await rejectsWith(propose('p16', users.p05, 'data_owner', 'grant', 'data_access:bundle:payroll'), 'ROLE_CHANGE_SOURCE');
    // 自我繁殖：控制負責人不能核准控制負責人的指派（改由董事長核准）
    const request = await propose('p16', users.p05, 'control_owner');
    await rejectsWith(challengeFor('p19', request.request_id), 'ROLE_CHANGE_SAME_ROLE');
    await rejectsWith(challengeFor('p23', request.request_id), 'ROLE_CHANGE_SAME_ROLE');
    assert.equal((await approve('p27', request.request_id)).status, 'approved');
    assert.equal(await hasRole(users.p05.personId, 'control_owner'), true);
    await endManual(users.p05.personId, 'control_owner');
});

test('K-ROLE-CHANGE-GOVERNANCE 治理類角色核准後進冷卻期，通知全部治理角色持有人；期間內任一人可以擋下，擋下的指派從未生效', async () => {
    const outboxBefore = (
        await one(admin, `select count(*)::int as n from sgn.notification_outbox where event_code = 'role_change.cooling'`)
    ).n;
    const request = await propose('p16', users.p05, 'parent_officer');
    const cooling = await approve('p19', request.request_id);
    assert.equal(cooling.status, 'cooling');
    assert.ok(new Date(cooling.effective_at) > new Date(), '冷卻期內');
    assert.equal(await hasRole(users.p05.personId, 'parent_officer'), false);
    const notified = await admin.query(
        `select person_id from sgn.notification_outbox where event_code = 'role_change.cooling' order by id desc limit $1`,
        [
            (await one(admin, `select count(*)::int as n from sgn.notification_outbox where event_code = 'role_change.cooling'`)).n -
                outboxBefore,
        ],
    );
    for (const uid of ['p27', 'p28'])
        assert.ok(
            notified.rows.some((r) => r.person_id === users[uid].personId),
            uid,
        );
    // 核准人自己不能擋（D77：擋下的人不得是當事人、提出人、核准人）；不是治理角色的人不能擋；
    // 治理角色的持有人（董事長）看得到「擋下」並擋下
    await rejectsWith(challengeFor('p19', request.request_id, 'block'), 'ROLE_CHANGE_SELF');
    await rejectsWith(challengeFor('p23', request.request_id, 'block'), 'ROLE_CHANGE_NOT_GOVERNOR');
    const listed = (await call(app, 'role_change_list', users.p27.session)).find((q) => q.request_id === request.request_id);
    assert.deepEqual(listed.actions, ['block']);
    const blocked = await decideRole(app, users.p27, request.request_id, 'block');
    assert.deepEqual([blocked.status, blocked.blocked_by_name], ['blocked', '郭永昌']);
    // 冷卻期過了也不會生效（模擬時間經過：把生效時間往前移）
    await admin.query(
        `update sgn.role_assignment set effective_from = clock_timestamp() - interval '1 second'
         where person_id = $1 and role_code = 'parent_officer' and effective_from is not null`,
        [users.p05.personId],
    );
    assert.equal(await hasRole(users.p05.personId, 'parent_officer'), false);
    await rejectsWith(challengeFor('p28', request.request_id, 'block'), 'ROLE_CHANGE_STATE');
    // 沒被擋下的：冷卻期過了才生效
    const second = await propose('p16', users.p05, 'parent_officer');
    await approve('p19', second.request_id);
    assert.equal(await hasRole(users.p05.personId, 'parent_officer'), false);
    await admin.query(
        `update sgn.role_assignment set effective_from = clock_timestamp() - interval '1 second'
         where person_id = $1 and role_code = 'parent_officer' and valid_to is null`,
        [users.p05.personId],
    );
    assert.equal(await hasRole(users.p05.personId, 'parent_officer'), true);
    await endManual(users.p05.personId, 'parent_officer');
});
