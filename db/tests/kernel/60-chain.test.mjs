// 賭注二：只增不改的事件表 + 雜湊鏈 + 資料庫以外的錨點檔，抓不抓得到竄改與整條重算。
// 攻擊者模型：資料庫最高權限者（superuser，可以停用 trigger、直接改表、從備份還原），但碰不到錨點檔。
// 每個攻擊情境在主資料庫的複本上做，互不影響。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { anchorOnce, readAnchors, verifyChain } from '../../tools/chain-lib.mjs';
import { DB_DIR, adminUrl, roleUrl } from '../../tools/lib/env.mjs';
import {
    closePools, config, createSubmittedCase, decidePasskey, issueChallenge, login, newAuthenticator, one, pool,
    registerPasskey,
} from './lib/harness.mjs';

const runDir = join(DB_DIR, '.run');
const anchorFile = join(runDir, 'test-anchors.jsonl');
const backupFile = join(runDir, 'test-backup-before-writes.dump');
const mainDb = config.database;
const copies = [];
const WRITERS = 20;
const PER_WRITER = 25;
const TAIL = 5;
let anchoredSeq;
let lastSeq;

async function adminQuery(database, sql, params) {
    const client = new pg.Client({ connectionString: adminUrl(config, database) });
    await client.connect();
    try {
        return await client.query(sql, params);
    } finally {
        await client.end();
    }
}

async function copyOfMain(name) {
    const db = `${mainDb}_t_${name}`;
    copies.push(db);
    await adminQuery('postgres', `drop database if exists "${db}"`);
    await adminQuery('postgres', `create database "${db}" template "${mainDb}"`);
    await adminQuery(db, `grant connect on database "${db}" to "${config.db.SGN_ROLE_JOB}"`);
    return db;
}

const verifyDb = (db) => verifyChain({ dbUrl: roleUrl(config, 'JOB', db), anchorFile });
const problemTypes = (result) => [...new Set(result.problems.map((p) => p.type))].sort();

// 以 superuser 停用 trigger 後重算從 p_from 開始的整條鏈與鏈頭：攻擊者「整條重算」的手法。
const RECOMPUTE = `
do $$
declare
    r record;
    v_prev bytea;
begin
    select prev_hash into v_prev from sgn.audit_event where seq = %FROM%;
    for r in select seq, body from sgn.audit_event where seq >= %FROM% order by seq loop
        update sgn.audit_event set prev_hash = v_prev, hash = sha256(v_prev || r.body) where seq = r.seq;
        v_prev := sha256(v_prev || r.body);
    end loop;
    update sgn.audit_chain_head set seq = (select max(seq) from sgn.audit_event), hash = v_prev;
end $$`;

async function tamper(db, statements) {
    await adminQuery(db, 'alter table sgn.audit_event disable trigger user');
    await adminQuery(db, 'alter table sgn.audit_chain_head disable trigger user');
    for (const sql of statements) await adminQuery(db, sql);
    await adminQuery(db, 'alter table sgn.audit_event enable trigger user');
    await adminQuery(db, 'alter table sgn.audit_chain_head enable trigger user');
}
const replaceBody = (seq) =>
    `update sgn.audit_event set body = convert_to(replace(convert_from(body, 'UTF8'), '"type"', '"forged": true, "type"'), 'UTF8') where seq = ${seq}`;

before(async () => {
    mkdirSync(runDir, { recursive: true });
    rmSync(anchorFile, { force: true });
    execFileSync('pg_dump', ['--format=custom', `--file=${backupFile}`, adminUrl(config)]);
});

after(async () => {
    await closePools();
    for (const db of copies) await adminQuery('postgres', `drop database if exists "${db}" with (force)`);
});

test('PRB-CHAIN 20 個連線同時寫入：序號連續、沒有分叉、整條鏈驗得過', async () => {
    const app = pool('APP');
    const user = await login(app, 'p04');
    const before = await one(pool('ADMIN'), 'select seq from sgn.audit_chain_head');
    const clients = await Promise.all(Array.from({ length: WRITERS }, () => app.connect()));
    const started = process.hrtime.bigint();
    await Promise.all(
        clients.map(async (client, w) => {
            for (let i = 0; i < PER_WRITER; i += 1) {
                await client.query('select * from api.case_create($1, $2)', [user.session, { writer: w, i }]);
            }
        }),
    );
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    clients.forEach((c) => c.release());
    const admin = pool('ADMIN');
    const stats = await one(
        admin,
        `select count(*)::int as n, min(seq)::int as lo, max(seq)::int as hi, count(distinct prev_hash)::int as prevs
         from sgn.audit_event where seq > $1`,
        [before.seq],
    );
    assert.equal(stats.n, WRITERS * PER_WRITER);
    assert.equal(stats.hi - stats.lo + 1, stats.n, '序號有缺口');
    assert.equal(stats.prevs, stats.n, '有兩筆接在同一個前一筆之後（分叉）');
    const result = await verifyDb(mainDb);
    assert.equal(result.ok, true, JSON.stringify(result.problems.slice(0, 5)));
    console.log(`# concurrent append: ${stats.n} events by ${WRITERS} connections in ${elapsedMs.toFixed(0)} ms (${(stats.n / (elapsedMs / 1000)).toFixed(0)} events/s)`);

    const anchored = await anchorOnce({ dbUrl: roleUrl(config, 'JOB'), anchorFile });
    assert.equal(anchored.ok, true);
    anchoredSeq = anchored.anchor.seq;
    for (let i = 0; i < TAIL; i += 1) {
        await app.query('select * from api.case_create($1, $2)', [user.session, { tail: i }]);
    }
    lastSeq = Number((await one(admin, 'select seq from sgn.audit_chain_head')).seq);
    assert.equal(lastSeq, anchoredSeq + TAIL);
    await closePools();
});

test('竄改 1：改一筆（錨點之前）不重算 → HASH_MISMATCH 與 ANCHOR_MISMATCH', async () => {
    const db = await copyOfMain('edit');
    await tamper(db, [replaceBody(10)]);
    const result = await verifyDb(db);
    assert.equal(result.ok, false);
    assert.ok(problemTypes(result).includes('HASH_MISMATCH'));
    assert.ok(problemTypes(result).includes('ANCHOR_MISMATCH'));
});

test('竄改 1b：只改查詢用的欄位（行為人）不動 body → COLUMN_MISMATCH', async () => {
    const db = await copyOfMain('column');
    await tamper(db, [`update sgn.audit_event set actor_person_id = gen_random_uuid() where seq = 10`]);
    assert.deepEqual(problemTypes(await verifyDb(db)), ['COLUMN_MISMATCH']);
});

test('竄改 2：改一筆（錨點之前）後整條重算 → 鏈本身一致，只有錨點抓得到（ANCHOR_MISMATCH）', async () => {
    const db = await copyOfMain('recompute');
    await tamper(db, [replaceBody(10), RECOMPUTE.replaceAll('%FROM%', '10')]);
    assert.deepEqual(problemTypes(await verifyDb(db)), ['ANCHOR_MISMATCH']);
});

test('竄改 2b：錨定工具從上一個錨點增量驗證，被整條重算過的資料庫拿不到新錨點', async () => {
    const db = await copyOfMain('recompute2');
    await tamper(db, [replaceBody(10), RECOMPUTE.replaceAll('%FROM%', '10')]);
    const anchorsBefore = readAnchors(anchorFile).length;
    const result = await anchorOnce({ dbUrl: roleUrl(config, 'JOB', db), anchorFile });
    assert.equal(result.ok, false);
    assert.equal(result.problems[0].type, 'ANCHOR_MISMATCH');
    assert.equal(readAnchors(anchorFile).length, anchorsBefore, '不一致時不得寫入新錨點');
});

test('竄改 3（已知缺口，預期抓不到）：改「最後一個錨點之後」的一筆並重算 → 驗證通過', async () => {
    const db = await copyOfMain('tailedit');
    await tamper(db, [replaceBody(lastSeq - 1), RECOMPUTE.replaceAll('%FROM%', String(lastSeq - 1))]);
    const result = await verifyDb(db);
    assert.equal(result.ok, true, '若抓到了，代表錨點已涵蓋這一筆，請更新報告');
});

test('竄改 4（已知缺口，預期抓不到）：刪掉錨點之後的最後 3 筆並修正鏈頭 → 驗證通過', async () => {
    const db = await copyOfMain('taildelete');
    await tamper(db, [
        `delete from sgn.audit_event where seq > ${lastSeq - 3}`,
        `update sgn.audit_chain_head set seq = ${lastSeq - 3}, hash = (select hash from sgn.audit_event where seq = ${lastSeq - 3})`,
    ]);
    assert.equal((await verifyDb(db)).ok, true);
});

test('竄改 5：刪到錨點之前（最後 TAIL+2 筆）並修正鏈頭 → ANCHOR_BEYOND_HEAD', async () => {
    const db = await copyOfMain('deeperdelete');
    const keep = anchoredSeq - 2;
    await tamper(db, [
        `delete from sgn.audit_event where seq > ${keep}`,
        `update sgn.audit_chain_head set seq = ${keep}, hash = (select hash from sgn.audit_event where seq = ${keep})`,
    ]);
    assert.deepEqual(problemTypes(await verifyDb(db)), ['ANCHOR_BEYOND_HEAD']);
});

test('竄改 6：從舊備份還原（pg_dump → pg_restore）→ ANCHOR_BEYOND_HEAD', async () => {
    const db = `${mainDb}_t_restore`;
    copies.push(db);
    await adminQuery('postgres', `drop database if exists "${db}"`);
    await adminQuery('postgres', `create database "${db}" owner "${config.db.SGN_ROLE_OWNER}"`);
    execFileSync('pg_restore', ['--dbname', adminUrl(config, db), backupFile]);
    await adminQuery(db, `grant connect on database "${db}" to "${config.db.SGN_ROLE_JOB}"`);
    const result = await verifyDb(db);
    assert.deepEqual(problemTypes(result), ['ANCHOR_BEYOND_HEAD']);
    assert.ok(result.count < anchoredSeq);
});

test('竄改 7：最高權限者把驗章 function 換成不驗的版本 → 偽造的核准會成功（擋不住），但驗證工具報 CODE_CHANGED', async () => {
    const db = await copyOfMain('forgefn');
    await adminQuery(db, `grant connect on database "${db}" to "${config.db.SGN_ROLE_APP}"`);
    await adminQuery(db, `
        create or replace function sgn_internal.webauthn_verify(p_expected_challenge bytea, p_credential_id text,
            p_authenticator_data text, p_client_data_json text, p_signature text)
        returns uuid language sql set search_path = pg_catalog, pg_temp as
        $f$ select person_id from sgn.passkey_credential where credential_id = sgn_internal.b64url_decode(p_credential_id) $f$`);
    const copyApp = new pg.Pool({ connectionString: roleUrl(config, 'APP', db) });
    try {
        const applicant = await login(copyApp, 'p04');
        const manager = await login(copyApp, 'p03');
        const managerKey = await registerPasskey(copyApp, manager);
        const caseId = await createSubmittedCase(copyApp, applicant);
        const ch = await issueChallenge(copyApp, manager, caseId);
        const forged = { ...newAuthenticator().assert(ch.challenge), credentialId: managerKey.credentialIdB64 };
        assert.equal(await decidePasskey(copyApp, ch.challenge_id, 'approve', forged), 'approved');
    } finally {
        await copyApp.end();
    }
    const result = await verifyDb(db);
    assert.ok(problemTypes(result).includes('CODE_CHANGED'), JSON.stringify(result.problems));
});

test('竄改 8：最高權限者停用只增不改的 trigger（還沒恢復時）→ CODE_CHANGED；恢復之後就看不出來', async () => {
    const db = await copyOfMain('notrigger');
    await adminQuery(db, 'alter table sgn.audit_event disable trigger audit_event_no_update_delete');
    assert.deepEqual(problemTypes(await verifyDb(db)), ['CODE_CHANGED']);
    await adminQuery(db, 'alter table sgn.audit_event enable trigger audit_event_no_update_delete');
    assert.equal((await verifyDb(db)).ok, true);
});

test('驗證工具的速度：全量重算整條鏈', async () => {
    const started = process.hrtime.bigint();
    const result = await verifyDb(mainDb);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(result.ok, true);
    console.log(`# full verify: ${result.count} events in ${ms.toFixed(0)} ms (${(result.count / (ms / 1000)).toFixed(0)} events/s)`);
});
