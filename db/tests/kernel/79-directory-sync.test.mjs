// 人員同步的兩種宣告與異動紀錄（K-HR-SYNC；紅隊 redteam/findings.md 中-1）。
// 攻擊者模型：拿到人員同步帳號（sgn_sync）。舊版只列幾個人的「快照」會清空沒列到的主管關係；
// 在職狀態、email 由同步直接覆寫、不留紀錄。
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readDirectory, syncDirectory } from '../../tools/directory-sync.mjs';
import { call, closePools, config, login, one, pool, rejectsWith, settleManagerChange, settleSyncChanges } from './lib/harness.mjs';

const app = pool('APP');
const admin = pool('ADMIN');
const syncDb = pool('SYNC');
const job = pool('JOB');
let snapshot;
const ids = {};

const syncRaw = (kind, total, entries) =>
    syncDb.query('select api_sync.directory_apply($1, $2, $3, $4) as r', ['sim-ldap', kind, total, JSON.stringify(entries)]);
const sync = async (kind, entries) => (await syncRaw(kind, entries.length, entries)).rows[0].r;
const entryOf = (uid, changes = {}) => ({ ...snapshot.find((e) => e.external_id === uid), ...changes });
const person = (uid) => one(admin, 'select display_name, email, active from sgn.person where id = $1', [ids[uid]]);
const managerOf = async (uid) =>
    (await one(admin, 'select manager_person_id from sgn.reporting_line where person_id = $1 and valid_to is null', [ids[uid]]))
        ?.manager_person_id ?? null;
const exceptionOf = (id) => one(admin, 'select rule_code, detail from sgn.exception_record where id = $1', [id]);
const lastEvent = async (type) =>
    (
        await one(
            admin,
            `select convert_from(body, 'UTF8')::jsonb -> 'data' as data from sgn.audit_event where event_type = $1 order by seq desc limit 1`,
            [type],
        )
    ).data;
const activeCount = async () => (await one(admin, 'select count(*)::int as n from sgn.person where active')).n;

before(async () => {
    snapshot = await readDirectory(config);
    const { rows } = await admin.query(`select external_id, person_id from sgn.person_identity where source = 'sim-ldap'`);
    for (const r of rows) ids[r.external_id] = r.person_id;
});
after(async () => {
    await syncDirectory(config);
    await closePools();
});

test('K-HR-SYNC 紅隊 中-1 回歸：不宣告種類、總筆數不符、欄位不對、主管對不到，整批拒絕', async () => {
    const one04 = [entryOf('p04')];
    await rejectsWith(syncRaw('partial', 1, one04), 'SYNC_KIND_REQUIRED');
    await rejectsWith(syncRaw(null, 1, one04), 'SYNC_KIND_REQUIRED');
    await rejectsWith(syncRaw('incremental', 2, one04), 'SYNC_TOTAL_MISMATCH');
    await rejectsWith(syncRaw('incremental', null, one04), 'SYNC_TOTAL_MISMATCH');
    await rejectsWith(sync('incremental', [{ ...entryOf('p04'), department: 'x' }]), 'DIRECTORY_ENTRY_INVALID');
    const missing = entryOf('p04');
    delete missing.email;
    await rejectsWith(sync('incremental', [missing]), 'DIRECTORY_ENTRY_INVALID');
    await rejectsWith(sync('incremental', [entryOf('p04'), entryOf('p04')]), 'DIRECTORY_ENTRY_INVALID');
    await rejectsWith(sync('incremental', [entryOf('p04', { manager_external_id: 'nobody' })]), 'DIRECTORY_MANAGER_UNKNOWN');
    assert.equal(await managerOf('p04'), ids.p03);
});

test('K-HR-SYNC 紅隊 中-1 回歸：只列幾個人的完整快照整批拒絕並開例外，沒列到的人與主管關係都不變', async () => {
    const before = await activeCount();
    const result = await sync('full', [entryOf('p04', { manager_external_id: null })]);
    assert.equal(result.rejected, true);
    assert.equal(result.diff.missing, snapshot.length - 1);
    const exception = await exceptionOf(result.exceptions[0]);
    assert.equal(exception.rule_code, 'K-HR-SYNC');
    assert.equal(exception.detail.kind, 'full_snapshot_over_threshold');
    assert.equal(exception.detail.max_change_percent, 20);
    assert.equal((await lastEvent('directory.sync_rejected')).exception_id, result.exceptions[0]);
    assert.equal(await activeCount(), before);
    assert.equal(await managerOf('p04'), ids.p03);
});

test('K-HR-SYNC 增量同步只動有列到的人：主管不在同一批也對得到；只有明寫 null 才移除主管（進鏈）', async () => {
    const before = await activeCount();
    const result = await sync('incremental', [entryOf('p04')]);
    assert.equal(result.manager_changes, 0);
    assert.equal(await managerOf('p04'), ids.p03);
    assert.equal(await activeCount(), before);
    const removed = await sync('incremental', [entryOf('p04', { manager_external_id: null })]);
    assert.equal(removed.manager_changes, 1);
    assert.equal(await managerOf('p04'), null);
    assert.equal((await lastEvent('directory.manager_changed')).new_manager, null);
    await sync('incremental', [entryOf('p04')]);
    await settleManagerChange(admin, ids.p04);
    assert.equal(await managerOf('p04'), ids.p03);
});

test('K-HR-SYNC 改 email、姓名逐筆進鏈', async () => {
    await sync('incremental', [entryOf('p06', { email: 'attacker@evil.example' })]);
    assert.equal((await person('p06')).email, 'attacker@evil.example');
    const event = await lastEvent('directory.person_changed');
    assert.equal(event.person, ids.p06);
    assert.deepEqual(event.changes, { email: { from: entryOf('p06').email, to: 'attacker@evil.example' } });
    await sync('incremental', [entryOf('p06')]);
    assert.equal((await person('p06')).email, entryOf('p06').email);
});

test('K-HR-SYNC 停用一個沒有控制類角色的人：立即生效並進鏈；目錄又說在職就恢復', async () => {
    const p06 = await login(app, 'p06');
    const result = await sync('incremental', [entryOf('p06', { active: false })]);
    assert.deepEqual([result.deactivated, result.deactivations_deferred, result.exceptions], [1, 0, []]);
    assert.equal((await person('p06')).active, false);
    await rejectsWith(call(app, 'me', p06.session), 'SESSION_INVALID');
    assert.equal((await lastEvent('directory.person_deactivated')).person, ids.p06);
    const back = await sync('incremental', [entryOf('p06')]);
    assert.equal(back.reactivated, 1);
    assert.equal((await lastEvent('directory.person_reactivated')).person, ids.p06);
});

test('K-HR-SYNC 停用持有控制類角色的人：進冷卻期並開例外，期間內仍在職；過了冷卻期由排程套用', async () => {
    const result = await sync('incremental', [entryOf('p20', { active: false })]);
    assert.deepEqual([result.deactivated, result.deactivations_deferred], [0, 1]);
    const exception = await exceptionOf(result.exceptions[0]);
    assert.equal(exception.rule_code, 'K-HR-SYNC');
    assert.equal(exception.detail.kind, 'deactivation_deferred');
    assert.deepEqual(exception.detail.persons, [ids.p20]);
    assert.equal((await person('p20')).active, true);
    // 冷卻期內排程不會套用
    assert.deepEqual((await job.query('select api_job.directory_settle() as r')).rows[0].r, { deactivations_applied: 0 });
    await settleSyncChanges(admin, ids.p20);
    assert.deepEqual((await job.query('select api_job.directory_settle() as r')).rows[0].r, { deactivations_applied: 1 });
    assert.equal((await person('p20')).active, false);
    assert.equal((await sync('incremental', [entryOf('p20')])).reactivated, 1);
});

test('K-HR-SYNC 一次停用多人：全部延後到冷卻期之後並開例外；目錄又說在職就取消', async () => {
    const result = await sync('incremental', [entryOf('p06', { active: false }), entryOf('p07', { active: false })]);
    assert.deepEqual([result.deactivated, result.deactivations_deferred], [0, 2]);
    const exception = await exceptionOf(result.exceptions[0]);
    assert.equal(exception.detail.bulk, true);
    assert.equal(exception.detail.bulk_deactivation_max, 1);
    assert.equal((await person('p06')).active, true);
    await sync('incremental', [entryOf('p06'), entryOf('p07')]);
    await settleSyncChanges(admin, ids.p06);
    await settleSyncChanges(admin, ids.p07);
    assert.deepEqual((await job.query('select api_job.directory_settle() as r')).rows[0].r, { deactivations_applied: 0 });
    assert.equal((await person('p07')).active, true);
});

test('K-HR-SYNC 完整快照（差異在門檻內）：沒列到的人視為離職，逐筆進鏈', async () => {
    const result = await sync(
        'full',
        snapshot.filter((e) => e.external_id !== 'p08'),
    );
    assert.equal(result.rejected, false);
    assert.equal(result.deactivated, 1);
    assert.equal((await person('p08')).active, false);
    assert.equal((await sync('full', snapshot)).reactivated, 1);
    assert.equal((await person('p08')).active, true);
});
