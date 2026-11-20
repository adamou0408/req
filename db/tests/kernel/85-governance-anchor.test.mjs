// 最高治理角色是錨點（裁決 D77；紅隊第三輪 高-3、中-1，redteam/exploits/07-role-change-collusion.mjs 的 a、e、e3、f）。
// 攻擊者模型：兩位各自只用自己帳密與金鑰的員工（流程管理者＋控制負責人），或防守方要撤掉同謀時，同謀自己擋下。
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { adminUrl } from '../../tools/lib/env.mjs';
import {
    call,
    closePools,
    config,
    decideRole,
    login,
    one,
    pool,
    proposeRole,
    registerPasskey,
    rejectsPermission,
    rejectsWith,
} from './lib/harness.mjs';

const app = pool('APP');
const admin = pool('ADMIN');
const scheduler = pool('SCHEDULER');
const users = {};

before(async () => {
    for (const uid of ['p05', 'p06', 'p09', 'p16', 'p19', 'p21', 'p23', 'p27', 'p28']) {
        users[uid] = await login(app, uid);
        users[uid].key = await registerPasskey(app, users[uid]);
    }
});
after(closePools);

const propose = (by, holder, role, change = 'grant') =>
    proposeRole(app, users[by], { holderId: users[holder].personId, role, change, reason: 'test 85' });
const holders = async (role) => (await one(admin, 'select sgn_internal.role_holders($1) as h', [role])).h;

test('K-GOVERNANCE-ANCHOR 架構：角色之間「誰核准誰」是有向無環圖；錨點角色沒有核准人、是必要角色，只能由儀式指派', async () => {
    const { rows } = await admin.query(`select code, change_approver_role, assignment_source_policy, anchor, required from sgn.role`);
    const approverOf = new Map(rows.filter((r) => r.change_approver_role).map((r) => [r.code, r.change_approver_role]));
    for (const start of approverOf.keys()) {
        const seen = new Set([start]);
        for (let at = approverOf.get(start); at; at = approverOf.get(at)) {
            assert.ok(!seen.has(at), `「誰核准誰」有迴圈：${[...seen, at].join(' → ')}`);
            seen.add(at);
        }
    }
    const anchors = rows.filter((r) => r.anchor);
    assert.ok(anchors.length >= 1, '至少有一個錨點角色');
    for (const r of anchors)
        assert.deepEqual([r.assignment_source_policy, r.required, r.change_approver_role], ['ceremony', true, null], r.code);
    // 儀式的 function 不授權給任何執行期帳號
    for (const role of ['APP', 'SYNC', 'SCHEDULER', 'RECONCILER', 'ANCHOR', 'MAILER'].map((key) => config.db[`SGN_ROLE_${key}`])) {
        const priv = await one(
            admin,
            `select has_function_privilege($1, 'sgn_internal.governance_anchor_install(text, uuid, text)', 'execute') as ok`,
            [role],
        );
        assert.equal(priv.ok, false, role);
    }
    await rejectsPermission(
        app.query('select sgn_internal.governance_anchor_install($1, $2, $3)', ['board_chair', users.p05.personId, 'x']),
    );
});

test('K-GOVERNANCE-ANCHOR 紅隊第三輪 高-3 回歸：流程管理者＋控制負責人不能產生新的最高治理角色持有人，也不能撤除它', async () => {
    await rejectsWith(propose('p16', 'p05', 'board_chair'), 'ROLE_CHANGE_CEREMONY');
    await rejectsWith(propose('p16', 'p27', 'board_chair', 'revoke'), 'ROLE_CHANGE_CEREMONY');
    assert.deepEqual(await holders('board_chair'), [users.p27.personId]);
});

test('K-GOVERNANCE-ANCHOR 儀式：只有資料庫擁有者能安裝或更替最高治理角色，寫進鏈；衝突矩陣與在職也檢查', async () => {
    const owner = new pg.Client({ connectionString: adminUrl(config) });
    await owner.connect();
    try {
        await owner.query(`set role "${config.db.SGN_ROLE_OWNER}"`);
        // 流程管理者不能是最高治理角色（衝突矩陣）
        await rejectsWith(
            owner.query('select sgn_internal.governance_anchor_install($1, $2, $3)', ['board_chair', users.p16.personId, '更替']),
            'GOVERNANCE_ANCHOR_INVALID',
        );
        // 不是錨點的角色不能用儀式
        await rejectsWith(
            owner.query('select sgn_internal.governance_anchor_install($1, $2, $3)', ['control_owner', users.p05.personId, 'x']),
            'GOVERNANCE_ANCHOR_INVALID',
        );
        // 更替：p05 接任，原持有人結束；之後再換回 p27
        const seq = (
            await owner.query('select sgn_internal.governance_anchor_install($1, $2, $3) as s', [
                'board_chair',
                users.p05.personId,
                '測試更替',
            ])
        ).rows[0].s;
        assert.deepEqual(await holders('board_chair'), [users.p05.personId]);
        const event = await one(
            admin,
            `select event_type, convert_from(body, 'UTF8')::jsonb -> 'data' as data from sgn.audit_event where seq = $1`,
            [seq],
        );
        assert.equal(event.event_type, 'role.anchor_installed');
        assert.deepEqual(event.data.replaced, [users.p27.personId]);
        await owner.query('select sgn_internal.governance_anchor_install($1, $2, $3)', ['board_chair', users.p27.personId, '測試換回']);
        assert.deepEqual(await holders('board_chair'), [users.p27.personId]);
    } finally {
        await owner.end();
    }
});

test('K-GOVERNANCE-ANCHOR 紅隊第三輪 高-3 e3 回歸：冷卻期內擋下變更的人不得是當事人、提出人、核准人', async () => {
    const request = await propose('p16', 'p06', 'parent_officer');
    const cooling = await decideRole(app, users.p19, request.request_id);
    assert.equal(cooling.status, 'cooling');
    // 防守方要撤掉同謀（他持有治理類角色）：先模擬冷卻期已過、指派生效，再提出撤除
    const revoke = await (async () => {
        await admin.query(`update sgn.role_change_request set effective_at = clock_timestamp() - interval '1 second' where id = $1`, [
            request.request_id,
        ]);
        await admin.query(
            `update sgn.role_assignment set effective_from = clock_timestamp() - interval '1 second' where person_id = $1 and role_code = 'parent_officer' and valid_to is null`,
            [users.p06.personId],
        );
        const r = await propose('p09', 'p06', 'parent_officer', 'revoke');
        return decideRole(app, users.p23, r.request_id);
    })();
    assert.equal(revoke.status, 'cooling');
    for (const who of ['p06', 'p09', 'p23'])
        await rejectsWith(call(app, 'role_change_challenge', users[who].session, revoke.request_id, 'block'), 'ROLE_CHANGE_SELF');
    // 其他治理類持有人可以擋
    const blocked = await decideRole(app, users.p28, revoke.request_id, 'block');
    assert.equal(blocked.status, 'blocked');
    await admin.query(
        `update sgn.role_assignment set valid_to = clock_timestamp() where person_id = $1 and role_code = 'parent_officer' and valid_to is null`,
        [users.p06.personId],
    );
});

test('K-GOVERNANCE-ANCHOR 紅隊第三輪 中-1 回歸：衝突矩陣——稽核治理人與流程管理、控制負責人、技術維運互斥', async () => {
    const { rows } = await admin.query(`select role_a, role_b from sgn.role_conflict where 'audit_governor' in (role_a, role_b)`);
    const others = rows.map((r) => (r.role_a === 'audit_governor' ? r.role_b : r.role_a));
    for (const role of ['process_admin', 'control_owner', 'tech_ops']) assert.ok(others.includes(role), role);
    // 流程管理者 p16 不能被授予稽核治理人
    await rejectsWith(propose('p21', 'p16', 'audit_governor'), 'ROLE_CONFLICT');
});

test('K-GOVERNANCE-KEY 治理類角色的持有人沒有可用的通行金鑰：排程開例外（每人一次），有金鑰的人不開', async () => {
    const before = (
        await admin.query(`select detail ->> 'person' as person from sgn.exception_record where rule_code = 'K-GOVERNANCE-KEY'`)
    ).rows.map((r) => r.person);
    await scheduler.query('select api_job.governance_check()');
    await scheduler.query('select api_job.governance_check()');
    const after = (
        await admin.query(`select detail ->> 'person' as person from sgn.exception_record where rule_code = 'K-GOVERNANCE-KEY'`)
    ).rows.map((r) => r.person);
    assert.equal(new Set(after).size, after.length, '同一個人只開一次');
    // 持有治理類角色的人：有金鑰的不在例外裡，沒有的一定在
    const { rows } = await admin.query(
        `select distinct h::text as person, sgn_internal.passkey_usable_count(h) as keys
         from sgn.role g, unnest(sgn_internal.role_holders(g.code)) h where g.category = 'governance'`,
    );
    for (const r of rows) {
        if (r.keys === 0) assert.ok(after.includes(r.person), `沒有金鑰的 ${r.person} 應該有例外`);
        else if (!before.includes(r.person)) assert.ok(!after.includes(r.person), `有金鑰的 ${r.person} 不該新開例外`);
    }
    // 後端帳號執行不到
    await assert.rejects(app.query('select api_job.governance_check()'), (err) => err.code === '42501');
});
