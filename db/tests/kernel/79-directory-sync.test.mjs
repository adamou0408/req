// 人員同步的兩種宣告與異動紀錄（K-HR-SYNC；紅隊 redteam/findings.md 中-1）。
// 攻擊者模型：拿到人員同步帳號（sgn_sync）。舊版只列幾個人的「快照」會清空沒列到的主管關係；
// 在職狀態、email 由同步直接覆寫、不留紀錄。
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readDirectory, syncDirectory } from '../../tools/directory-sync.mjs';
import {
    call,
    closePools,
    config,
    createSubmittedCase,
    login,
    one,
    pool,
    rejectsWith,
    setSetting,
    settleManagerChange,
    settleSyncChanges,
} from './lib/harness.mjs';

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
const settle = async () => (await job.query('select api_job.directory_settle() as r')).rows[0].r;
/** 模擬冷卻期已過，再由排程套用（恢復在職、改名等延後的異動）。 */
const settleNow = async (...uids) => {
    for (const uid of uids) await settleSyncChanges(admin, ids[uid]);
    return settle();
};
// 停用門檻在時間窗內累計（D70）：前面的測試停用過的人也算。要測「單人立即生效」時把時間窗設成 0，測完設回預設。
const windowHours = (hours) => setSetting(admin, 'directory.deactivation_window_hours', hours);

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

test('K-HR-SYNC 紅隊第二輪 高-1 回歸：同步改主管後再停用原主管，主管關不會交給還沒生效的新主管，改由原主管的上一層', async () => {
    await windowHours(0);
    try {
        await sync('incremental', [entryOf('p04', { manager_external_id: 'p05' })]);
        await sync('incremental', [entryOf('p03', { active: false })]);
        assert.equal((await person('p03')).active, false);
        const p04 = await login(app, 'p04');
        const caseId = await createSubmittedCase(app, p04);
        const view = await call(app, 'case_get', p04.session, caseId);
        assert.deepEqual(view.waiting_on, [entryOf('p02').display_name], '原主管 p03 的主管（p02），不是剛改上去的 p05');
        // 沒有任何已生效關係的人（不是基準之後才到職）：不用未生效的關係
        const line = await one(admin, 'select (sgn_internal.resolve_manager($1)).manager_person_id as m', [ids.p04]);
        assert.equal(line.m, ids.p02);
    } finally {
        await sync('incremental', [entryOf('p03'), entryOf('p04')]);
        await settleNow('p03');
        await settleManagerChange(admin, ids.p04);
    }
    assert.equal((await person('p03')).active, true);
    assert.equal(await managerOf('p04'), ids.p03);
});

test('K-HR-SYNC 改 email、姓名進冷卻期並開例外：期間內維持原值，目錄改回就取消；過了冷卻期才套用並進鏈', async () => {
    const changed = await sync('incremental', [entryOf('p06', { email: 'attacker@evil.example' })]);
    assert.equal(changed.person_changes_deferred, 1);
    assert.equal((await exceptionOf(changed.exceptions[0])).detail.kind, 'person_change_deferred');
    assert.equal((await person('p06')).email, entryOf('p06').email, '冷卻期內維持原值');
    const deferred = await lastEvent('directory.person_change_deferred');
    assert.deepEqual([deferred.person, deferred.field, deferred.to], [ids.p06, 'email', 'attacker@evil.example']);
    // 目錄改回原值：取消，到期也不會套用
    await sync('incremental', [entryOf('p06')]);
    assert.deepEqual(await settleNow('p06'), { deactivations_applied: 0, person_changes_applied: 0 });
    assert.equal((await person('p06')).email, entryOf('p06').email);
    // 真的改了：過了冷卻期才套用並進鏈
    await sync('incremental', [entryOf('p06', { display_name: '蔡佩珊（新）' })]);
    assert.deepEqual(await settleNow('p06'), { deactivations_applied: 0, person_changes_applied: 1 });
    assert.equal((await person('p06')).display_name, '蔡佩珊（新）');
    assert.deepEqual((await lastEvent('directory.person_changed')).changes, {
        display_name: { from: entryOf('p06').display_name, to: '蔡佩珊（新）' },
    });
    await sync('incremental', [entryOf('p06')]);
    await settleNow('p06');
    assert.equal((await person('p06')).display_name, entryOf('p06').display_name);
});

test('K-HR-SYNC 紅隊第二輪 中-1 回歸：把姓名改成別人的名字不會立即生效；同名的人在畫面上加上 email', async () => {
    const p03name = entryOf('p03').display_name;
    await sync('incremental', [entryOf('p05', { display_name: p03name })]);
    assert.equal((await person('p05')).display_name, entryOf('p05').display_name);
    // 冷卻期過了才是同名：畫面上的名字（person_name 是唯一入口）加上 email，看得出是哪一位
    await settleNow('p05');
    const p04 = await login(app, 'p04');
    const caseId = await createSubmittedCase(app, p04);
    const view = await call(app, 'case_get', p04.session, caseId);
    // D79 (1)：同名時再加內部短代碼（email 可能也被冒用；在職者的 email 已唯一，短代碼是第二道區分）
    const p03id = ids.p03.replaceAll('-', '').slice(0, 6);
    assert.deepEqual(view.waiting_on, [`${p03name}（${entryOf('p03').email}・#${p03id}）`]);
    await sync('incremental', [entryOf('p05')]);
    await settleNow('p05');
    assert.equal((await person('p05')).display_name, entryOf('p05').display_name);
});

test('K-HR-SYNC 停用一個沒有控制類角色的人：立即生效並進鏈；恢復在職進冷卻期並開例外', async () => {
    await windowHours(0);
    try {
        const p06 = await login(app, 'p06');
        const result = await sync('incremental', [entryOf('p06', { active: false })]);
        assert.deepEqual([result.deactivated, result.deactivations_deferred, result.exceptions], [1, 0, []]);
        assert.equal((await person('p06')).active, false);
        await rejectsWith(call(app, 'me', p06.session), 'SESSION_INVALID');
        assert.equal((await lastEvent('directory.person_deactivated')).person, ids.p06);
        const back = await sync('incremental', [entryOf('p06')]);
        assert.deepEqual([back.reactivated, back.reactivations_deferred], [0, 1]);
        assert.equal((await exceptionOf(back.exceptions[0])).detail.kind, 'person_change_deferred');
        assert.equal((await person('p06')).active, false, '冷卻期內仍是停用');
        assert.deepEqual(await settleNow('p06'), { deactivations_applied: 0, person_changes_applied: 1 });
        assert.equal((await person('p06')).active, true);
        assert.equal((await lastEvent('directory.person_reactivated')).person, ids.p06);
    } finally {
        await windowHours(24);
    }
});

test('K-HR-SYNC 紅隊第二輪 中-1 回歸：停用的門檻在時間窗內累計，拆成多次增量同步也會延後並開例外', async () => {
    await windowHours(0);
    const first = await sync('incremental', [entryOf('p06', { active: false })]);
    assert.deepEqual([first.deactivated, first.deactivations_deferred], [1, 0], '時間窗內第一位：立即');
    await windowHours(24);
    try {
        const second = await sync('incremental', [entryOf('p07', { active: false })]);
        assert.deepEqual([second.deactivated, second.deactivations_deferred], [0, 1], '時間窗內累計超過門檻：延後');
        const exception = await exceptionOf(second.exceptions[0]);
        assert.equal(exception.detail.bulk, true);
        assert.ok(exception.detail.recent_in_window >= 1);
        assert.equal(exception.detail.window_hours, 24);
        assert.equal((await person('p07')).active, true);
        assert.equal((await lastEvent('directory.synced')).settings['directory.deactivation_window_hours'], 24);
    } finally {
        await sync('incremental', [entryOf('p06'), entryOf('p07')]);
        await settleNow('p06', 'p07');
    }
    assert.equal((await person('p06')).active, true);
    assert.equal((await person('p07')).active, true);
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
    assert.deepEqual(await settle(), { deactivations_applied: 0, person_changes_applied: 0 });
    await settleSyncChanges(admin, ids.p20);
    assert.deepEqual(await settle(), { deactivations_applied: 1, person_changes_applied: 0 });
    assert.equal((await person('p20')).active, false);
    assert.equal((await sync('incremental', [entryOf('p20')])).reactivations_deferred, 1);
    await settleNow('p20');
    assert.equal((await person('p20')).active, true);
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
    assert.deepEqual(await settle(), { deactivations_applied: 0, person_changes_applied: 0 });
    assert.equal((await person('p07')).active, true);
});

test('K-HR-SYNC 完整快照（差異在門檻內）：沒列到的人視為離職，逐筆進鏈', async () => {
    await windowHours(0);
    try {
        const result = await sync(
            'full',
            snapshot.filter((e) => e.external_id !== 'p08'),
        );
        assert.equal(result.rejected, false);
        assert.equal(result.deactivated, 1);
        assert.equal((await person('p08')).active, false);
        assert.equal((await sync('full', snapshot)).reactivations_deferred, 1);
        await settleNow('p08');
        assert.equal((await person('p08')).active, true);
    } finally {
        await windowHours(24);
    }
});

test('K-HR-SYNC 紅隊第二輪 低-2 回歸：同步新增的人寫進鏈（姓名、email、在職狀態、外部帳號）', async () => {
    const result = await sync('incremental', [
        {
            external_id: 'rt-ghost-79',
            display_name: '賴政達',
            email: 'rt-ghost-79@sim.example',
            active: true,
            manager_external_id: null,
            roles: [],
        },
    ]);
    assert.equal(result.rejected, false);
    const added = await lastEvent('directory.person_added');
    assert.deepEqual(
        [added.external_id, added.display_name, added.email, added.active, added.baseline],
        ['rt-ghost-79', '賴政達', 'rt-ghost-79@sim.example', true, false],
    );
    // 收尾：停用這個人（單人、時間窗設成 0，立即）
    await windowHours(0);
    try {
        await sync('incremental', [
            {
                external_id: 'rt-ghost-79',
                display_name: '賴政達',
                email: 'rt-ghost-79@sim.example',
                active: false,
                manager_external_id: null,
                roles: [],
            },
        ]);
    } finally {
        await windowHours(24);
    }
    assert.equal(
        (
            await one(
                admin,
                `select p.active from sgn.person p join sgn.person_identity i on i.person_id = p.id where i.external_id = 'rt-ghost-79'`,
            )
        ).active,
        false,
    );
});

test('K-HR-SYNC 紅隊第三輪 低-1 回歸：姓名含不可見字元、與在職者 email 相同的資料不採用並開例外；既有的人保留原本的姓名與 email', async () => {
    const tag = Date.now();
    const p19 = entryOf('p19');
    const result = await sync('incremental', [
        // 與資安長同名同 email 的新人：email 重複，不建立
        {
            external_id: `rt3-a-${tag}`,
            display_name: p19.display_name,
            email: p19.email.toUpperCase(),
            active: true,
            manager_external_id: null,
            roles: [],
        },
        // 同名夾零寬字元：不建立
        {
            external_id: `rt3-b-${tag}`,
            display_name: `${p19.display_name}\u200b`,
            email: `rt3-b-${tag}@sim.example`,
            active: true,
            manager_external_id: null,
            roles: [],
        },
        // 既有的人改成別人的 email：保留原本的 email，其餘照常
        entryOf('p06', { email: p19.email }),
    ]);
    assert.deepEqual(
        result.screened.map((r) => [r.field, r.reason]).sort(),
        [
            ['display_name', 'invisible_characters'],
            ['email', 'email_taken'],
            ['email', 'email_taken'],
        ].sort(),
    );
    const created = await one(admin, `select count(*)::int as n from sgn.person_identity where external_id like $1`, [`rt3-%-${tag}`]);
    assert.equal(created.n, 0);
    assert.equal((await person('p06')).email, entryOf('p06').email);
    const ex = await exceptionOf(result.exceptions.at(-1));
    assert.deepEqual([ex.rule_code, ex.detail.kind], ['K-HR-SYNC', 'entries_screened']);
    // 姓名做 NFC 正規化：分解形式的字與組合形式相同
    const nfd = 'Amélie';
    const r2 = await sync('incremental', [
        {
            external_id: `rt3-c-${tag}`,
            display_name: nfd,
            email: `rt3-c-${tag}@sim.example`,
            active: true,
            manager_external_id: null,
            roles: [],
        },
    ]);
    assert.deepEqual(r2.screened, []);
    const stored = await one(
        admin,
        `select p.display_name from sgn.person p join sgn.person_identity i on i.person_id = p.id where i.external_id = $1`,
        [`rt3-c-${tag}`],
    );
    assert.equal(stored.display_name, nfd.normalize('NFC'));
    await windowHours(0);
    try {
        await sync('incremental', [
            {
                external_id: `rt3-c-${tag}`,
                display_name: nfd,
                email: `rt3-c-${tag}@sim.example`,
                active: false,
                manager_external_id: null,
                roles: [],
            },
        ]);
    } finally {
        await windowHours(24);
    }
});

test('K-HR-SYNC 紅隊第三輪 資訊 1、2 回歸：同步改主管當下就開例外；新到職的人也只用已生效的主管關係', async () => {
    const tag = Date.now();
    // 改主管：同步當下就有例外（不等有人送單）
    const before = (await one(admin, 'select count(*)::int as n from sgn.exception_record')).n;
    const changed = await sync('incremental', [entryOf('p08', { manager_external_id: 'p05' })]);
    assert.equal(changed.manager_changes, 1);
    const ex = await exceptionOf(changed.exceptions.at(-1));
    assert.deepEqual([ex.rule_code, ex.detail.kind, ex.detail.changes[0].to], ['K-HR-SYNC', 'manager_changed', ids.p05]);
    assert.equal((await one(admin, 'select count(*)::int as n from sgn.exception_record')).n, before + 1);
    // 新人指定同謀當主管：找主管的入口不用還沒生效的關係（D70 的字面；不再為新到職的人例外）
    await sync('incremental', [
        {
            external_id: `rt3-hire-${tag}`,
            display_name: '新進員工',
            email: `rt3-hire-${tag}@sim.example`,
            active: true,
            manager_external_id: 'p05',
            roles: [],
        },
    ]);
    const hire = await one(
        admin,
        `select (sgn_internal.resolve_manager(i.person_id)).manager_person_id as m from sgn.person_identity i where i.external_id = $1`,
        [`rt3-hire-${tag}`],
    );
    assert.equal(hire.m, null);
    // 收尾：主管改回、新人離職（模擬冷卻期已過）
    await sync('incremental', [entryOf('p08')]);
    await settleManagerChange(admin, ids.p08);
    await windowHours(0);
    try {
        await sync('incremental', [
            {
                external_id: `rt3-hire-${tag}`,
                display_name: '新進員工',
                email: `rt3-hire-${tag}@sim.example`,
                active: false,
                manager_external_id: null,
                roles: [],
            },
        ]);
    } finally {
        await windowHours(24);
    }
});
