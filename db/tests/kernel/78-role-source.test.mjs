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
    issueChallenge,
    login,
    one,
    pool,
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
    for (const uid of ['p03', 'p04', 'p05', 'p16', 'p19', 'p21', 'p22', 'p23', 'p28', 'p29']) users[uid] = await login(app, uid);
    for (const uid of ['p03', 'p05', 'p19', 'p23', 'p28', 'p29']) users[uid].key = await registerPasskey(app, users[uid]);
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

const propose = (by, holder, role, change = 'grant') =>
    call(app, 'role_change_propose', users[by].session, holder.personId, role, null, change, '測試');
async function approve(by, requestId, key = users[by].key) {
    const ch = await call(app, 'role_change_challenge', users[by].session, requestId);
    const a = key.assert(ch.challenge);
    return call(app, 'role_change_approve_passkey', ch.challenge_id, a.credentialId, a.authenticatorData, a.clientDataJSON, a.signature);
}

test('K-ROLE-SOURCE 控制類角色只能在平台內指派：一人提出、另一位有權的人用通行金鑰核准（不得是提出人或被指派的人），寫進稽核鏈', async () => {
    assert.ok((await call(app, 'me', users.p16.session)).capabilities.includes('role_change'));
    assert.ok(!(await call(app, 'me', users.p04.session)).capabilities.includes('role_change'));
    assert.deepEqual(await call(app, 'role_change_options', users.p04.session), { roles: [], people: [] });
    await rejectsWith(propose('p04', users.p05, 'security_responder'), 'ROLE_CHANGE_NOT_PROPOSER');
    await rejectsWith(propose('p16', users.p05, 'no_such_role'), 'ROLE_UNKNOWN');
    const request = await propose('p16', users.p05, 'security_responder');
    assert.equal(request.status, 'pending');
    assert.deepEqual(request.actions, []);
    // 同一個人、同一個角色同時只能有一張待核准的變更；沒有這個指派就不能撤除
    await rejectsWith(propose('p16', users.p05, 'security_responder'), 'ROLE_CHANGE_PENDING');
    await rejectsWith(propose('p16', users.p05, 'ciso', 'revoke'), 'ROLE_CHANGE_NOOP');
    await rejectsWith(call(app, 'role_change_challenge', users.p16.session, request.request_id), 'ROLE_CHANGE_SELF');
    await rejectsWith(call(app, 'role_change_challenge', users.p05.session, request.request_id), 'ROLE_CHANGE_SELF');
    await rejectsWith(call(app, 'role_change_challenge', users.p04.session, request.request_id), 'ROLE_CHANGE_NOT_APPROVER');
    // 待核准的人在清單上看得到「核准」
    const listed = (await call(app, 'role_change_list', users.p19.session)).find((r) => r.request_id === request.request_id);
    assert.deepEqual(listed.actions, ['approve']);
    // 挑戰值發給 p23，拿 p19 的通行金鑰簽：被擋
    const ch = await call(app, 'role_change_challenge', users.p23.session, request.request_id);
    const forged = users.p19.key.assert(ch.challenge);
    await rejectsWith(
        call(
            app,
            'role_change_approve_passkey',
            ch.challenge_id,
            forged.credentialId,
            forged.authenticatorData,
            forged.clientDataJSON,
            forged.signature,
        ),
        'CHALLENGE_PURPOSE',
    );
    assert.equal(await hasRole(users.p05.personId, 'security_responder'), false);
    const approved = await approve('p19', request.request_id);
    assert.equal(approved.status, 'approved');
    assert.equal(approved.approved_by_name, '賴政達');
    assert.equal(await hasRole(users.p05.personId, 'security_responder'), true);
    await rejectsWith(call(app, 'role_change_challenge', users.p23.session, request.request_id), 'ROLE_CHANGE_STATE');
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
    // 被指派的人自己不能核准
    const self = await propose('p21', users.p28, 'auditor');
    await rejectsWith(call(app, 'role_change_challenge', users.p28.session, self.request_id), 'ROLE_CHANGE_SELF');
    const request = await propose('p21', users.p04, 'auditor');
    await rejectsWith(call(app, 'role_change_challenge', users.p19.session, request.request_id), 'ROLE_CHANGE_NOT_APPROVER');
    // 技術維運就算同時持有稽核治理人、稽核主管，也不能經手稽核角色（管理者連線直接給角色，模擬設定錯誤）
    await admin.query(
        `insert into sgn.role_assignment (person_id, role_code, valid_from, source)
         select $1, r, clock_timestamp(), 'manual' from unnest(array['audit_governor', 'audit_head']) as r`,
        [users.p29.personId],
    );
    try {
        await rejectsWith(call(app, 'role_change_challenge', users.p29.session, request.request_id), 'ROLE_CHANGE_EXCLUDED');
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
