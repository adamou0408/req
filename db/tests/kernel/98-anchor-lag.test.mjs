// 錨定落後由資料庫開例外（K-ANCHOR-LAG；裁決 D84 (7)；紅隊第五輪 中-4，redteam/exploits/41）。
// 錨定程式把錨點寫進存放處之後回報（api_job.anchor_recorded，資料庫用自己的鏈比對）；排程（api_job.anchor_lag_check）
// 在最後一次記下的錨點之後的事件超過參數時開例外並通知。存放處的序號規則與稽核頁的判定在端對端（e2e/tests/z-anchor-store.test.mjs）。
// 「拿掉防法就失敗」：回報不比對雜湊（H 可以謊報）、或排程不檢查落後（錨定停擺沒人知道），這裡就會失敗。
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { closePools, one, pool, rejectsPermission, rejectsWith, setSetting } from './lib/harness.mjs';

const admin = pool('ADMIN');
const anchor = pool('ANCHOR');
const scheduler = pool('SCHEDULER');
const mailer = pool('MAILER');
after(closePools);

const head = () => one(anchor, 'select * from api_job.chain_head()');
const fingerprint = async () => (await one(anchor, 'select api_job.code_fingerprint() as fp')).fp;
const record = (seq, hash, fp) => one(anchor, 'select api_job.anchor_recorded($1, $2, $3) as r', [seq, hash, fp]).then((r) => r.r);
const lagCheck = () => one(scheduler, 'select api_job.anchor_lag_check() as r').then((r) => r.r.opened);
const lagExceptions = async () =>
    (await one(admin, `select count(*)::int as n from sgn.exception_record where rule_code = 'K-ANCHOR-LAG'`)).n;

test('K-ANCHOR-LAG 錨定程式的回報要和資料庫自己的鏈相符（序號、雜湊、程式指紋），0 號與不存在的序號不收；舊的不重複記', async () => {
    const h = await head();
    const fp = await fingerprint();
    await rejectsWith(record(Number(h.seq), '00'.repeat(32), fp), 'ANCHOR_RECEIPT_INVALID');
    await rejectsWith(record(0, '00'.repeat(32), fp), 'ANCHOR_RECEIPT_INVALID');
    await rejectsWith(record(Number(h.seq) + 1000, h.hash, fp), 'ANCHOR_RECEIPT_INVALID');
    await rejectsWith(record(Number(h.seq), h.hash, 'x'), 'ANCHOR_RECEIPT_INVALID');
    assert.equal((await record(Number(h.seq), h.hash, fp)).recorded, true);
    const older = await one(admin, 'select seq, encode(hash, $2) as hash from sgn.audit_event where seq = $1', [Number(h.seq) - 1, 'hex']);
    assert.equal((await record(Number(older.seq), older.hash, fp)).recorded, false, '比已記下的舊：不重複記');
    // 只有錨定程式的角色能回報；寄信程式不行
    await rejectsPermission(mailer.query('select api_job.anchor_recorded(1, $1, $2)', [h.hash, fp]));
});

test('K-ANCHOR-LAG 錨定停擺：最後一次記下的錨點之後的事件超過參數，排程開例外並通知（每段落後一筆，寫明參數）；記下新的錨點之後恢復正常', async () => {
    const h = await head();
    await record(Number(h.seq), h.hash, await fingerprint());
    assert.equal(await lagCheck(), 0, '剛錨定：沒有落後');
    await setSetting(admin, 'audit.anchor_max_lag_seconds', 1);
    try {
        // 錨定程式停掉之後，鏈上又有新的事件（這裡用一筆設定的變動）
        await setSetting(admin, 'audit.anchor_max_lag_events', 10000);
        await one(admin, `select sgn_internal.audit_append('test.anchor_lag', null, null, '{}'::jsonb) as seq`);
        await new Promise((r) => setTimeout(r, 1500));
        const before = await lagExceptions();
        assert.equal(await lagCheck(), 1);
        assert.equal(await lagExceptions(), before + 1);
        const ex = await one(admin, `select detail from sgn.exception_record where rule_code = 'K-ANCHOR-LAG' order by id desc limit 1`);
        assert.equal(Number(ex.detail.last_anchored_seq), Number(h.seq));
        assert.deepEqual(ex.detail.settings, { 'audit.anchor_max_lag_seconds': 1, 'audit.anchor_max_lag_events': 10000 });
        assert.ok(
            (await one(admin, `select count(*)::int as n from sgn.notification_outbox where event_code = 'audit.anchor_lag'`)).n >= 1,
            '通知稽核主管與資安長',
        );
        assert.equal(await lagCheck(), 0, '同一段落後只開一筆');
        const now = await head();
        await record(Number(now.seq), now.hash, await fingerprint());
        assert.equal(await lagCheck(), 0, '錨定恢復');
    } finally {
        await setSetting(admin, 'audit.anchor_max_lag_seconds', 30);
    }
});
