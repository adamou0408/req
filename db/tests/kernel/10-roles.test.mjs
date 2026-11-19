// 賭注三：角色隔離。一般後端角色不能讀寫任何資料表，只能執行 api 的 function。
// 以 pg_catalog 查「實際權限」，再以真的連線嘗試越權。
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { closePools, config, one, pool, rejectsPermission, rejectsWith } from './lib/harness.mjs';

const admin = pool('ADMIN');
const app = pool('APP');
const roles = {
    APP: config.db.SGN_ROLE_APP,
    VERIFIER: config.db.SGN_ROLE_TEST_VERIFIER,
    SYNC: config.db.SGN_ROLE_SYNC,
    ANCHOR: config.db.SGN_ROLE_JOB,
};
const allowedSchema = { APP: 'api', VERIFIER: 'api_verified', SYNC: 'api_sync', ANCHOR: 'api_job' };

after(closePools);

test('角色隔離：四個登入角色對任何資料表、序列、檢視都沒有任何權限', async () => {
    for (const role of Object.values(roles)) {
        const { rows } = await admin.query(
            `select n.nspname || '.' || c.relname as rel
             from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where c.relkind in ('r', 'v', 'm', 'S', 'p', 'f')
               and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
               and (has_table_privilege($1, c.oid, 'select, insert, update, delete, truncate, references, trigger')
                    or (c.relkind = 'S' and has_sequence_privilege($1, c.oid, 'usage, select, update')))`,
            [role],
        );
        assert.deepEqual(rows, [], `${role} 有資料表權限：${rows.map((r) => r.rel).join(', ')}`);
    }
});

test('角色隔離：每個登入角色能執行的非系統 function 只在自己的 schema', async () => {
    for (const [key, role] of Object.entries(roles)) {
        const { rows } = await admin.query(
            `select distinct n.nspname
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname not in ('pg_catalog', 'information_schema')
               and has_schema_privilege($1, n.oid, 'usage')
               and has_function_privilege($1, p.oid, 'execute')`,
            [role],
        );
        assert.deepEqual(rows.map((r) => r.nspname), [allowedSchema[key]], role);
    }
});

test('角色隔離：一般後端讀寫資料表一律被拒', async () => {
    await rejectsPermission(app.query('select * from sgn.request_case'));
    await rejectsPermission(app.query('select * from sgn.audit_event'));
    await rejectsPermission(app.query(`insert into sgn.audit_event values (999, now(), 'x', null, null, '\\x', '\\x', '\\x')`));
    await rejectsPermission(app.query(`update sgn.request_case set state = 'approved'`));
    await rejectsPermission(app.query('select * from sgn.passkey_credential'));
});

test('角色隔離：一般後端呼叫內部、驗證服務、同步、錨定的 function 一律被拒', async () => {
    const uuid = '00000000-0000-0000-0000-000000000000';
    await rejectsPermission(app.query(`select sgn_internal.decision_prepare($1, 'approve')`, [uuid]));
    await rejectsPermission(app.query(`select sgn_internal.audit_append('x', null, null, '{}')`));
    await rejectsPermission(app.query(`select sgn_internal.es256_verify('\\x', '\\x', '\\x')`));
    await rejectsPermission(app.query(`select api_verified.case_decide_passkey($1, 'approve', 'x', 1, '{}')`, [uuid]));
    await rejectsPermission(app.query(`select api_sync.directory_apply('sim-ldap', '[]')`));
    await rejectsPermission(app.query('select * from api_job.events_after(0, 10)'));
});

test('角色隔離：一般後端不能建立物件、不能切換成 owner', async () => {
    await rejectsPermission(app.query('create table public.x (id int)'));
    await rejectsPermission(app.query('create temp table x (id int)'));
    await assert.rejects(app.query(`set role ${config.db.SGN_ROLE_OWNER}`), /permission denied/);
});

test('架構：對外 function 都是 SECURITY DEFINER、固定 search_path、有 COMMENT', async () => {
    const { rows } = await admin.query(
        `select n.nspname || '.' || p.proname as fn, p.prosecdef, p.proconfig, obj_description(p.oid, 'pg_proc') as comment
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname in ('api', 'api_verified', 'api_sync', 'api_job')`,
    );
    assert.ok(rows.length >= 15);
    for (const row of rows) {
        assert.ok(row.prosecdef, `${row.fn} 不是 SECURITY DEFINER`);
        assert.ok((row.proconfig ?? []).some((c) => c.startsWith('search_path=')), `${row.fn} 沒固定 search_path`);
        assert.ok(row.comment, `${row.fn} 沒有 COMMENT`);
    }
});

test('PRB-CHAIN 稽核紀錄表連 owner 也擋下 UPDATE、DELETE、TRUNCATE', async () => {
    const owner = await admin.connect();
    try {
        await owner.query(`set role ${config.db.SGN_ROLE_OWNER}`);
        await rejectsWith(owner.query(`update sgn.audit_event set event_type = 'x' where seq = 1`), 'AUDIT_APPEND_ONLY');
        await rejectsWith(owner.query('delete from sgn.audit_event where seq = 1'), 'AUDIT_APPEND_ONLY');
        await rejectsWith(owner.query('truncate sgn.audit_event'), 'AUDIT_APPEND_ONLY');
        await rejectsWith(owner.query('update sgn.audit_chain_head set seq = 0'), 'AUDIT_APPEND_ONLY');
        await rejectsWith(owner.query('delete from sgn.audit_chain_head'), 'AUDIT_APPEND_ONLY');
    } finally {
        await owner.query('reset role');
        owner.release();
    }
    const row = await one(admin, 'select count(*)::int as n from sgn.audit_event where seq = 1');
    assert.equal(row.n, 1);
});
