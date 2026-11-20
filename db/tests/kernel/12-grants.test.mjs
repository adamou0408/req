// 執行權限（紅隊 redteam/findings.md 高-2）：每個執行期帳號能執行的 function 必須與路由表的允許清單完全相等，
// 多一個或少一個都失敗；資料庫測試用的資料庫與正式建置（端對端用的 sgn_e2e，沒有 db/testing/）都檢查。
// 另外把攻擊腳本 redteam/exploits/02-idp-decide-bypass.mjs 變成回歸測試：後端帳號拿到簽核人的身分提供者 token 也做不了決定。
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import pg from 'pg';
import { allowlist } from '../../tools/grants-sql.mjs';
import { adminUrl } from '../../tools/lib/env.mjs';
import {
    closePools,
    config,
    createSubmittedCase,
    decideIdp,
    idToken,
    issueChallenge,
    login,
    one,
    pool,
    rejectsWith,
} from './lib/harness.mjs';

const admin = pool('ADMIN');
const app = pool('APP');
const production = new pg.Pool({ connectionString: adminUrl(config, config.db.SGN_DB_E2E), max: 2 });
const databases = { [config.database]: admin, [config.db.SGN_DB_E2E]: production };

after(async () => {
    await production.end();
    await closePools();
});

// 這個帳號有 EXECUTE 權限的非系統 function（不論有沒有 schema 的 USAGE：多授權的就算多）
async function executable(db, role) {
    const { rows } = await db.query(
        `select n.nspname || '.' || p.proname as fn
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname not in ('pg_catalog', 'information_schema')
           and has_function_privilege($1, p.oid, 'execute')
         order by 1`,
        [role],
    );
    return rows.map((r) => r.fn);
}

test('架構：每個執行期帳號（sgn_app、sgn_sync、排程、對帳、錨定、寄信、交付、金鑰更新）能執行的 function 與路由表的允許清單完全相等（多一個或少一個都失敗）', async () => {
    for (const [database, db] of Object.entries(databases)) {
        for (const [key, { schema, fns }] of Object.entries(allowlist)) {
            const role = config.db[`SGN_ROLE_${key}`];
            const expected = [...new Set(fns.map((fn) => `${schema}.${fn}`))].sort();
            assert.deepEqual(await executable(db, role), expected, `${database}：${role}`);
        }
        // 合併角色 sgn_job（只給操作者）：自己沒有授權，經由成員關係正好是四個程式的聯集
        const union = ['SCHEDULER', 'RECONCILER', 'ANCHOR', 'MAILER'].flatMap((key) => allowlist[key].fns.map((fn) => `api_job.${fn}`));
        assert.deepEqual(await executable(db, config.db.SGN_ROLE_JOB), [...new Set(union)].sort(), `${database}：sgn_job`);
        const direct = await db.query(
            `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace, aclexplode(p.proacl) a
             where n.nspname = 'api_job' and a.grantee = $1::regrole`,
            [config.db.SGN_ROLE_JOB],
        );
        assert.deepEqual(direct.rows, [], `${database}：sgn_job 不得有直接授權`);
    }
});

test('架構（裁決 D84 (6)）：排程、對帳、錨定、寄信各用各的角色，彼此的入口互不相通（寄信讀不到稽核鏈、交不了對帳；錨定領不了通知；對帳跑不了排程）', async () => {
    const cross = [
        ['MAILER', 'events_after'],
        ['MAILER', 'reconciliation_submit'],
        ['ANCHOR', 'notification_claim'],
        ['ANCHOR', 'notification_mark'],
        ['RECONCILER', 'confirmation_expire_due'],
        ['RECONCILER', 'chain_head'],
        ['SCHEDULER', 'notification_mark'],
        ['SCHEDULER', 'reconciliation_submit'],
        ['SCHEDULER', 'anchor_recorded'],
    ];
    for (const [key, fn] of cross) {
        const role = config.db[`SGN_ROLE_${key}`];
        const { rows } = await admin.query(
            `select has_function_privilege($1, p.oid, 'execute') as ok from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'api_job' and p.proname = $2`,
            [role, fn],
        );
        assert.equal(rows.length, 1, `api_job.${fn} 存在`);
        assert.equal(rows[0].ok, false, `${role} 不得執行 api_job.${fn}`);
    }
    const roles = new Set(['SCHEDULER', 'RECONCILER', 'ANCHOR', 'MAILER'].map((key) => config.db[`SGN_ROLE_${key}`]));
    assert.equal(roles.size, 4, '四個不同的角色');
});

test('架構：路由表以外的 api function 一律不存在於正式建置；sgn_app 的允許清單沒有任何「只靠身分提供者」的決定入口', async () => {
    const apiFns = await production.query(
        `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'api'`,
    );
    const listed = new Set(allowlist.APP.fns);
    assert.deepEqual(
        apiFns.rows.map((r) => r.proname).filter((fn) => !listed.has(fn)),
        [],
    );
    assert.ok(!listed.has('case_decide_idp'));
    const deciders = await production.query(
        `select n.nspname || '.' || p.proname as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname not in ('pg_catalog', 'information_schema') and p.prosrc like '%sgn_internal.decision_commit(%' order by 1`,
    );
    assert.deepEqual(
        deciders.rows.map((r) => r.fn),
        ['api.case_decide_passkey'],
    );
});

test('架構：非系統 schema 的 function 都不對 PUBLIC 開放；owner 之後新建的 function 預設也不對任何執行期帳號開放', async () => {
    for (const [database, db] of Object.entries(databases)) {
        assert.deepEqual(await executable(db, 'public'), [], `${database}：PUBLIC`);
        const owner = await db.connect();
        try {
            await owner.query('begin');
            await owner.query(`set local role ${config.db.SGN_ROLE_OWNER}`);
            await owner.query(`create function api.grants_probe() returns int language sql as 'select 1'`);
            await owner.query(`create function api_sync.grants_probe() returns int language sql as 'select 1'`);
            const { rows } = await owner.query(
                `select r.rolname, n.nspname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 cross join (select unnest(array['public', $1, $2, $3]) as rolname) r
                 where p.proname = 'grants_probe' and has_function_privilege(r.rolname, p.oid, 'execute')`,
                [config.db.SGN_ROLE_APP, config.db.SGN_ROLE_SYNC, config.db.SGN_ROLE_JOB],
            );
            assert.deepEqual(
                rows,
                [],
                `${database}：新建的 function 預設就開放給 ${rows.map((r) => `${r.rolname}@${r.nspname}`).join(', ')}`,
            );
        } finally {
            await owner.query('rollback');
            owner.release();
        }
    }
});

test('K-DECISION-PROOF 紅隊 高-2 回歸：後端帳號拿到簽核人以挑戰值為 nonce 的身分提供者 token（例如在登入時換掉 nonce），也做不了決定', async () => {
    const applicant = await login(app, 'p04');
    const approver = await login(app, 'p03');
    const caseId = await createSubmittedCase(app, applicant);
    const ch = await issueChallenge(app, approver, caseId, 'approve', {});
    // 被入侵的後端在使用者登入時，把導向身分提供者的 nonce 換成決定挑戰值：拿到的就是這個 token
    const token = await idToken('p03', ch.challenge);
    await assert.rejects(decideIdp(app, ch.challenge_id, 'approve', token), (err) => {
        assert.ok(['42883', '42501'].includes(err.code), `應該沒有這個 function 或沒有權限，實際 ${err.code}: ${err.message}`);
        return true;
    });
    const task = await one(admin, `select status from sgn.case_task where case_id = $1`, [caseId]);
    assert.equal(task.status, 'pending');
    assert.equal((await one(admin, 'select state from sgn.request_case where id = $1', [caseId])).state, 'in_approval');
});

test('K-DECISION-PROOF 正式建置只接受通行金鑰的證明：參數預設只有 passkey，存其他種類的證明被擋下', async () => {
    const kinds = await one(production, `select sgn_internal.setting('decision.allowed_proof_kinds') as v`);
    assert.deepEqual(kinds.v, ['passkey']);
    const owner = await production.connect();
    try {
        await owner.query('begin');
        const ch = await one(
            owner,
            `insert into sgn.auth_challenge (purpose, challenge, binding, created_at, expires_at)
             values ('decision', sgn_internal.gen_random_bytes(32), '{}', now(), now()) returning id`,
        );
        await rejectsWith(
            owner.query(
                `insert into sgn.decision_proof (challenge_id, kind, raw, raw_sha256, created_at) values ($1, 'idp_stepup', '{}', '\\x00', now())`,
                [ch.id],
            ),
            'PROOF_KIND_NOT_ALLOWED',
        );
    } finally {
        await owner.query('rollback');
        owner.release();
    }
});
