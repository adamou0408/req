// 未登入可達的面與離線驗證的落後（裁決 D71；紅隊第二輪 低-1、低-2，redteam/exploits/09、11）。
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { readAnchors, verifyChain } from '../../tools/chain-lib.mjs';
import { RUN_DIR, roleUrl } from '../../tools/lib/env.mjs';
import { call, closePools, config, one, pool, rejectsWith, setSetting } from './lib/harness.mjs';

const app = pool('APP');
const admin = pool('ADMIN');
const job = pool('JOB');
after(closePools);

const pendingFrom = async (source) =>
    (
        await one(
            admin,
            `select count(*)::int as n from sgn.auth_challenge
             where purpose = 'session' and consumed_at is null and expires_at > clock_timestamp() and source = $1`,
            [source],
        )
    ).n;

test('K-LOGIN-THROTTLE 紅隊第三輪 中-2 回歸：上限每個來源各自計算、在資料庫；灌滿一個來源不影響其他來源，沒有全域上限（D78）', async () => {
    assert.deepEqual(await call(app, 'frontdoor_policy'), { client_source: 'socket', trusted_proxies: [] });
    const flooded = `192.0.2.${Math.floor(Math.random() * 200) + 1}`;
    const perSource = (
        await one(admin, `select default_value::int as n from sgn.setting_definition where key = 'auth.login_pending_per_source'`)
    ).n;
    for (let i = await pendingFrom(flooded); i < perSource; i++) await call(app, 'session_begin', flooded);
    await rejectsWith(call(app, 'session_begin', flooded), 'AUTH_RATE_LIMITED');
    const status = await one(admin, `select http_status from sgn.error_catalog where code = 'AUTH_RATE_LIMITED'`);
    assert.equal(status.http_status, 429);
    // 其他來源（另一位正常使用者）照常
    assert.ok((await call(app, 'session_begin', '198.51.100.7')).nonce);
    // 全域上限與後端記憶體裡的次數參數都已刪除
    const gone = await one(
        admin,
        `select count(*)::int as n from sgn.setting_definition where key in ('auth.login_pending_max', 'auth.login_attempts_per_minute')`,
    );
    assert.equal(gone.n, 0);
    // 短存活時間：登入挑戰值 auth.login_challenge_ttl_seconds 秒內過期
    const ttl = await one(
        admin,
        `select max(extract(epoch from expires_at - created_at))::int as s from sgn.auth_challenge where purpose = 'session' and source = $1`,
        [flooded],
    );
    assert.ok(ttl.s <= 120, `存活 ${ttl.s} 秒`);
});

test('K-LOGIN-THROTTLE 過期的挑戰值由排程清除：登入挑戰值一過期就清，其他用途過期超過保留時間才清，被決定證明引用的不動', async () => {
    const expired = await call(app, 'session_begin', '203.0.113.9');
    await admin.query(`update sgn.auth_challenge set expires_at = clock_timestamp() - interval '1 second' where id = $1`, [
        expired.challenge_id,
    ]);
    const begin = await call(app, 'session_begin');
    await admin.query(
        `update sgn.auth_challenge set created_at = created_at - interval '3 days', expires_at = expires_at - interval '3 days' where id = $1`,
        [begin.challenge_id],
    );
    const referenced = await one(admin, 'select count(*)::int as n from sgn.decision_proof');
    const purged = (await job.query('select api_job.auth_challenge_purge() as r')).rows[0].r;
    assert.ok(purged.purged >= 1);
    assert.equal((await one(admin, 'select count(*)::int as n from sgn.auth_challenge where id = $1', [begin.challenge_id])).n, 0);
    assert.equal((await one(admin, 'select count(*)::int as n from sgn.auth_challenge where id = $1', [expired.challenge_id])).n, 0);
    assert.equal((await one(admin, 'select count(*)::int as n from sgn.decision_proof')).n, referenced.n);
    // 後端帳號清不了
    await assert.rejects(app.query('select api_job.auth_challenge_purge()'), (err) => err.code === '42501');
});

test('K-ANCHOR-LAG 離線驗證工具回報最後一個錨點之後有幾筆、多久；超過參數或完全沒有錨點即判失敗', async () => {
    mkdirSync(RUN_DIR, { recursive: true });
    const none = join(RUN_DIR, 'test-anchors-none.jsonl');
    writeFileSync(none, '');
    const dbUrl = roleUrl(config, 'JOB');
    const empty = await verifyChain({ dbUrl, anchorFile: none });
    assert.equal(empty.ok, false);
    assert.ok(empty.problems.some((p) => p.type === 'ANCHOR_LAG'));
    assert.equal(empty.unanchored.events, empty.count);
    // 錨點停在某一筆：之後的筆數超過參數就失敗；參數放寬到涵蓋這段落後才通過
    const head = Number((await one(admin, 'select seq from sgn.audit_chain_head')).seq);
    const anchored = await one(admin, `select seq, encode(hash, 'hex') as hash from sgn.audit_event where seq = $1`, [head - 3]);
    const stale = join(RUN_DIR, 'test-anchors-stale.jsonl');
    writeFileSync(stale, `${JSON.stringify({ seq: Number(anchored.seq), hash: anchored.hash })}\n`);
    assert.equal(readAnchors(stale).length, 1);
    await setSetting(admin, 'audit.anchor_max_lag_events', 2);
    try {
        const late = await verifyChain({ dbUrl, anchorFile: stale });
        assert.equal(late.ok, false, JSON.stringify(late.problems));
        const lag = late.problems.find((p) => p.type === 'ANCHOR_LAG');
        assert.deepEqual([lag.events, lag.max_events, lag.after_anchor_seq], [3, 2, head - 3]);
        await setSetting(admin, 'audit.anchor_max_lag_events', 3);
        const ok = await verifyChain({ dbUrl, anchorFile: stale });
        assert.equal(ok.ok, true, JSON.stringify(ok.problems));
        assert.equal(ok.unanchored.events, 3);
        // 時間：最舊一筆沒被涵蓋的紀錄比參數還舊
        await setSetting(admin, 'audit.anchor_max_lag_seconds', 0);
        const old = await new Promise((r) => setTimeout(r, 1100)).then(() => verifyChain({ dbUrl, anchorFile: stale }));
        assert.ok(old.problems.some((p) => p.type === 'ANCHOR_LAG' && p.seconds > 0));
    } finally {
        await setSetting(admin, 'audit.anchor_max_lag_events', 10000);
        await setSetting(admin, 'audit.anchor_max_lag_seconds', 30);
    }
});
