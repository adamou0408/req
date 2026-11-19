// 最小的業務路徑：每條規則（sgn.rule）至少一個測試，測試名稱以規則代碼開頭。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { syncDirectory } from '../tools/directory-sync.mjs';
import { verifyChain } from '../tools/chain-lib.mjs';
import { REPO_DIR, roleUrl } from '../tools/lib/env.mjs';
import {
    closePools, config, createSubmittedCase, decidePasskey, issueChallenge, login, one, pool, registerPasskey,
    rejectsWith,
} from './lib/harness.mjs';

const app = pool('APP');
const admin = pool('ADMIN');
const users = {};

before(async () => {
    for (const uid of ['p01', 'p02', 'p03', 'p04', 'p05', 'p07', 'p22']) users[uid] = await login(app, uid);
    users.p02.key = await registerPasskey(app, users.p02);
    users.p03.key = await registerPasskey(app, users.p03);
    users.p07.key = await registerPasskey(app, users.p07);
});
after(closePools);

const ldapChange = (...args) => execFileSync(join(REPO_DIR, 'sim/ldap/change.sh'), args, { stdio: 'pipe' });
const caseState = async (caseId) => (await one(admin, 'select state from sgn.request_case where id = $1', [caseId])).state;

test('PRB-DIRECTORY 送審時從同步進來的主管關係解析簽核人：p04 → p03', async () => {
    const caseId = await createSubmittedCase(app, users.p04);
    const view = await one(app, 'select api.case_get($1, $2) as c', [users.p04.session, caseId]);
    assert.equal(view.c.approver, users.p03.personId);
});

test('PRB-DIRECTORY 在 LDAP 換主管後重新同步：舊關係關閉、新送審的單改由新主管簽', async () => {
    ldapChange('set-manager', 'p05', 'p07');
    try {
        const result = await syncDirectory(config);
        assert.equal(result.manager_changes, 1);
        const lines = await admin.query(
            `select * from (select id, manager_person_id, valid_to is null as current from sgn.reporting_line
             where person_id = $1 order by id desc limit 2) last_two order by id`,
            [users.p05.personId],
        );
        assert.deepEqual(lines.rows.map((r) => [r.manager_person_id, r.current]), [
            [users.p03.personId, false],
            [users.p07.personId, true],
        ]);
        const caseId = await createSubmittedCase(app, users.p05);
        await rejectsWith(issueChallenge(app, users.p03, caseId), 'NOT_APPROVER');
        const ch = await issueChallenge(app, users.p07, caseId);
        assert.equal(await decidePasskey(app, ch.challenge_id, 'approve', users.p07.key.assert(ch.challenge)), 'approved');
    } finally {
        ldapChange('set-manager', 'p05', 'p03');
        await syncDirectory(config);
    }
});

test('PRB-APPLICANT 別人不能修改或送出我的申請單 → NOT_APPLICANT', async () => {
    const created = await call(app, 'case_create', users.p04.session, { a: 1 });
    await rejectsWith(app.query('select api.case_revise($1, $2, $3)', [users.p05.session, created.case_id, { a: 2 }]), 'NOT_APPLICANT');
    await rejectsWith(app.query('select api.case_submit($1, $2)', [users.p05.session, created.case_id]), 'NOT_APPLICANT');
    await rejectsWith(app.query('select api.case_create($1, $2)', ['not-a-session', { a: 1 }]), 'SESSION_INVALID');
});

test('PRB-STATE 送審後不能改內容；退回後可改；核准後不能再決定', async () => {
    const caseId = await createSubmittedCase(app, users.p04);
    await rejectsWith(app.query('select api.case_revise($1, $2, $3)', [users.p04.session, caseId, { x: 1 }]), 'STATE_TRANSITION');
    const back = await issueChallenge(app, users.p03, caseId, 'return');
    assert.equal(await decidePasskey(app, back.challenge_id, 'return', users.p03.key.assert(back.challenge)), 'draft');
    await rejectsWith(issueChallenge(app, users.p03, caseId, 'approve'), 'STATE_TRANSITION');
    const version = await one(app, 'select api.case_revise($1, $2, $3) as v', [users.p04.session, caseId, { x: 2 }]);
    assert.equal(version.v, 2);
    await app.query('select api.case_submit($1, $2)', [users.p04.session, caseId]);
    const ch = await issueChallenge(app, users.p03, caseId);
    assert.equal(await decidePasskey(app, ch.challenge_id, 'approve', users.p03.key.assert(ch.challenge)), 'approved');
    await rejectsWith(issueChallenge(app, users.p03, caseId, 'approve'), 'STATE_TRANSITION');
    await rejectsWith(issueChallenge(app, users.p03, caseId, 'cancel'), 'STATE_TRANSITION');
});

test('PRB-APPROVER 只有直屬主管能拿到挑戰值：同事、隔級主管都不行；沒有主管的人不能送審', async () => {
    const caseId = await createSubmittedCase(app, users.p04);
    await rejectsWith(issueChallenge(app, users.p05, caseId), 'NOT_APPROVER');
    await rejectsWith(issueChallenge(app, users.p02, caseId), 'NOT_APPROVER');
    const top = await call(app, 'case_create', users.p01.session, { top: true });
    await rejectsWith(app.query('select api.case_submit($1, $2)', [users.p01.session, top.case_id]), 'NO_APPROVER');
});

test('PRB-SELF 申請人不能核准自己的單：拿不到挑戰值；拿主管的挑戰值用自己的金鑰簽也被擋', async () => {
    const caseId = await createSubmittedCase(app, users.p03);
    await rejectsWith(issueChallenge(app, users.p03, caseId), 'SELF_APPROVAL');
    const ch = await issueChallenge(app, users.p02, caseId);
    await rejectsWith(decidePasskey(app, ch.challenge_id, 'approve', users.p03.key.assert(ch.challenge)), 'SELF_APPROVAL');
    assert.equal(await caseState(caseId), 'submitted');
    assert.equal(await decidePasskey(app, ch.challenge_id, 'approve', users.p02.key.assert(ch.challenge)), 'approved');
});

test('PRB-PROOF 沒有證明就沒有決定：一般後端唯一能改狀態的入口都要求證明', async () => {
    const { rows } = await admin.query(
        `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'api' and p.prosrc like '%decision_commit%' order by 1`,
    );
    assert.deepEqual(rows.map((r) => r.proname), ['case_decide_idp', 'case_decide_passkey']);
    const writers = await admin.query(
        `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'api' and p.prosrc like '%case_transition%' order by 1`,
    );
    assert.deepEqual(writers.rows.map((r) => r.proname), ['case_revise', 'case_submit']);
});

test('PRB-CHAIN 一張單從建立到核准，每一步都在鏈上，且整條鏈驗得過', async () => {
    const caseId = await createSubmittedCase(app, users.p04);
    const ch = await issueChallenge(app, users.p03, caseId);
    await decidePasskey(app, ch.challenge_id, 'approve', users.p03.key.assert(ch.challenge));
    const events = await admin.query('select event_type from sgn.audit_event where case_id = $1 order by seq', [caseId]);
    assert.deepEqual(events.rows.map((r) => r.event_type), ['case.created', 'case.submitted', 'case.approve']);
    const result = await verifyChain({ dbUrl: roleUrl(config, 'JOB') });
    assert.equal(result.ok, true, JSON.stringify(result.problems.slice(0, 3)));
});

test('PRB-AUDIT-READ 稽核人員查得到整張單的軌跡與證明雜湊；非稽核人員被拒；查詢 function 是唯讀的', async () => {
    const caseId = await createSubmittedCase(app, users.p04);
    const ch = await issueChallenge(app, users.p03, caseId);
    await decidePasskey(app, ch.challenge_id, 'approve', users.p03.key.assert(ch.challenge));
    const { rows } = await app.query('select * from api.audit_events($1, $2)', [users.p22.session, caseId]);
    assert.deepEqual(rows.map((r) => r.event_type), ['case.created', 'case.submitted', 'case.approve']);
    assert.equal(rows[2].actor_name, '陳建宏');
    assert.match(rows[2].data.proof_sha256, /^[0-9a-f]{64}$/);
    await rejectsWith(app.query('select * from api.audit_events($1, $2)', [users.p04.session, caseId]), 'AUDITOR_REQUIRED');
    await rejectsWith(app.query('select * from api.audit_events($1, $2)', [users.p03.session, null]), 'AUDITOR_REQUIRED');
    const fn = await one(admin, `select provolatile from pg_proc where oid = 'api.audit_events(text, uuid)'::regprocedure`);
    assert.equal(fn.provolatile, 's');
});

test('PRB-DIRECTORY 殘餘風險（預期會成功）：拿到同步帳號的人可以把自己設成申請人的主管，再用自己的金鑰核准', async () => {
    const syncDb = pool('SYNC');
    const entry = (uid, manager, name) => ({ external_id: uid, display_name: name, email: `${uid}@sim.example`, active: true, manager_external_id: manager, roles: [] });
    try {
        await syncDb.query('select api_sync.directory_apply($1, $2)', ['sim-ldap', JSON.stringify([entry('p04', 'p05', '林怡君'), entry('p05', 'p03', '王志明')])]);
        const p05Key = await registerPasskey(app, users.p05);
        const caseId = await createSubmittedCase(app, users.p04);
        const ch = await issueChallenge(app, users.p05, caseId);
        assert.equal(await decidePasskey(app, ch.challenge_id, 'approve', p05Key.assert(ch.challenge)), 'approved');
        const trail = await admin.query(`select event_type from sgn.audit_event where event_type = 'directory.synced' order by seq desc limit 1`);
        assert.equal(trail.rows.length, 1, '至少同步本身留在鏈上');
    } finally {
        await syncDirectory(config);
    }
});
