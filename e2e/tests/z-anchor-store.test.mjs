// 端對端：錨點存放處（裁決 D81 (4)；紅隊第四輪 中-4，redteam/exploits/32-audit-page-forged-chain.mjs）。
// 稽核頁的驗證程式（web/verify.js，原封不動）直接向錨點存放處取錨點，不經後端：後端（B）改寫了鏈，也換不了錨點。
// 「拿掉防法就失敗」：verify.js 若改回用後端給的錨點，第一個測試的改寫就會被判為 ok。
// 前提：tools/run-all.sh 啟動的錨點存放處、錨定程式、後端與頁面（檔名排在最後：其他端對端測試的事件都已錨定）。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { after, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUN_DIR, SECRETS_DIR, anchorFile, loadConfig, readEnvFile } from '../../db/tools/lib/env.mjs';
import { call, closePools, login, one, pool, setSetting } from '../../db/tests/kernel/lib/harness.mjs';
import { verifyCase } from '../../web/verify.js';

const config = loadConfig();
const app = pool('APP');
const admin = pool('ADMIN'); // 只用來找一筆屬於某張單、已經錨定的事件
after(closePools);
// 頁面的來源（verify.js 從這裡的 /config.json 得知錨點存放處；簽章檢查用 location）
globalThis.location = new URL(config.db.SGN_WEB_ORIGIN);
const sha = (...parts) => createHash('sha256').update(Buffer.concat(parts)).digest();

async function wholeChain(session) {
    const chain = [];
    for (let after = 0; ; ) {
        const rows = await call(app, 'audit_chain', session, after, 5000);
        chain.push(...rows);
        if (rows.length < 5000) return chain;
        after = Number(rows.at(-1).seq);
    }
}

test('K-AUDIT-CHAIN 後端改寫鏈上的一筆、重算之後的雜湊、連「錨點」一起換：稽核頁的驗證仍向獨立的錨點存放處取錨點，判定失敗', async () => {
    const auditor = await login(app, 'p22');
    // 等錨定程式把目前的鏈頭寫進存放處
    let anchors = [];
    for (let i = 0; i < 50; i += 1) {
        anchors = await (await fetch(new URL('/anchors', config.db.SGN_ANCHOR_ORIGIN))).json();
        if (anchors.length > 0) break;
        await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(anchors.length > 0, '錨點存放處有錨點');
    const chain = await wholeChain(auditor.session);
    const [picked] = (
        await admin.query(
            `select e.seq::int as seq, c.case_no::text as case_no from sgn.audit_event e join sgn.request_case c on c.id = e.case_id
             where e.seq <= $1 order by e.seq desc limit 1`,
            [anchors.at(-1).seq],
        )
    ).rows;
    const target = picked.seq;
    const audit = await call(app, 'audit_case', auditor.session, picked.case_no);
    const fingerprint = await call(app, 'audit_code_fingerprint', auditor.session);
    const backend = (rows, anc) => ({
        call: async (fn, body) => {
            if (fn === 'audit_chain') return rows.filter((r) => Number(r.seq) > body.after_seq).slice(0, body.limit);
            if (fn === 'audit_code_fingerprint') return fingerprint;
            throw new Error(fn);
        },
        anchors: async () => anc,
    });
    // 改寫：最後一個錨點那一筆的內容換掉，之後全部重算，連後端轉送的「錨點」也照改
    const forged = chain.map((r) => ({ ...r }));
    let prev = Buffer.from(forged.find((r) => Number(r.seq) === target).prev_hash, 'hex');
    for (const r of forged.filter((x) => Number(x.seq) >= target)) {
        if (Number(r.seq) === target) {
            const body = JSON.parse(Buffer.from(r.body, 'base64').toString('utf8'));
            body.data = { forged: true };
            r.body = Buffer.from(JSON.stringify(body), 'utf8').toString('base64');
        }
        r.prev_hash = prev.toString('hex');
        prev = sha(prev, Buffer.from(r.body, 'base64'));
        r.hash = prev.toString('hex');
    }
    const forgedAnchors = anchors.map((a) => ({ ...a, hash: forged.find((r) => Number(r.seq) === a.seq)?.hash ?? a.hash }));
    const honest = await verifyCase(backend(chain, anchors), audit);
    assert.deepEqual(honest.problems, [], '沒改寫時頁面判定沒有問題');
    const v = await verifyCase(backend(forged, forgedAnchors), audit);
    assert.equal(v.status, 'bad');
    assert.ok(
        v.problems.some((p) => String(p).includes('和外部錨點不符')),
        JSON.stringify(v.problems),
    );
});

test('K-AUDIT-CHAIN 錨點存放處只增不改、寫入要金鑰；資料檔屬於存放處的帳號，後端與錨定程式的帳號都改不了；後端不再轉送錨點', async () => {
    const url = new URL('/anchors', config.db.SGN_ANCHOR_ORIGIN);
    const anchors = await (await fetch(url)).json();
    const last = anchors.at(-1);
    const forged = { ...last, hash: '0'.repeat(64) };
    const post = (headers) =>
        fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(forged) });
    assert.equal((await post({})).status, 401);
    assert.equal((await post({ authorization: 'Bearer guess' })).status, 401);
    const file = anchorFile(config, config.db.SGN_DB_E2E);
    for (const user of ['sgn-api', 'sgn-anchor', 'sgn-delivery']) {
        assert.throws(
            () =>
                execFileSync('setpriv', ['--reuid', user, '--regid', user, '--clear-groups', '--', 'test', '-w', file], {
                    stdio: 'ignore',
                }),
            undefined,
            `${user} 寫得了錨點檔`,
        );
    }
    const res = await fetch(new URL('/anchors', config.db.SGN_RP_ORIGIN));
    assert.equal(res.status, 404, '後端沒有 /anchors');
});

// ── 紅隊第五輪 中-4（裁決 D84 (7)；redteam/exploits/41）──

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const anchorsNow = async () => (await fetch(new URL('/anchors', config.db.SGN_ANCHOR_ORIGIN))).json();

test('K-ANCHOR-LAG 拿到寫入金鑰（錨定程式的帳號）也只能寫序號更大的錨點：0 號、負的、等於或小於最後一個的都不收（指紋改變也一樣）', async () => {
    const key = readEnvFile(join(SECRETS_DIR, 'anchor.env')).SGN_ANCHOR_WRITE_KEY;
    const last = (await anchorsNow()).at(-1);
    const post = (a) =>
        fetch(new URL('/anchors', config.db.SGN_ANCHOR_ORIGIN), {
            method: 'POST',
            headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
            body: JSON.stringify({
                hash: 'ab'.repeat(32),
                code_fingerprint: 'x',
                anchored_at: new Date().toISOString(),
                label: 'test',
                ...a,
            }),
        });
    assert.equal((await post({ seq: 0 })).status, 422, '0 號');
    assert.equal((await post({ seq: -1 })).status, 422);
    assert.equal((await post({ seq: last.seq })).status, 409, '一樣的序號、換了指紋');
    assert.equal((await post({ seq: last.seq - 1, code_fingerprint: last.code_fingerprint })).status, 409, '比較小');
    assert.equal((await anchorsNow()).at(-1).seq >= last.seq, true);
});

test('K-ANCHOR-LAG 錨定停擺超過參數：稽核頁判為失敗（不是「尚未錨定」的警告），資料庫開例外；錨定程式被殺掉會被重新啟動，之後恢復', async () => {
    const auditor = await login(app, 'p22');
    const scheduler = pool('SCHEDULER');
    const pidFile = join(RUN_DIR, 'anchor.pid');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await setSetting(admin, 'audit.anchor_max_lag_seconds', 3);
    process.kill(pid, 'SIGSTOP');
    try {
        const c = await one(admin, `select case_no::text as case_no from sgn.request_case order by case_no desc limit 1`);
        await one(admin, `select sgn_internal.audit_append('test.anchor_lag', null, null, '{}'::jsonb) as seq`);
        await sleep(4500);
        const audit = await call(app, 'audit_case', auditor.session, c.case_no);
        const api = { call: (fn, body) => call(app, fn, auditor.session, ...Object.values(body ?? {})) };
        const result = await verifyCase(api, audit);
        assert.equal(result.status, 'bad', JSON.stringify(result.problems));
        assert.ok(result.problems.some((p) => /外部錨定落後/.test(p)));
        assert.equal((await one(scheduler, 'select api_job.anchor_lag_check() as r')).r.opened, 1, '資料庫開例外');
    } finally {
        process.kill(pid, 'SIGCONT');
        await setSetting(admin, 'audit.anchor_max_lag_seconds', 30);
    }
    // 監看（tools/run-all.sh）：錨定程式結束就重新啟動
    process.kill(pid, 'SIGKILL');
    let restarted = 0;
    for (let i = 0; i < 50 && !restarted; i += 1) {
        await sleep(200);
        const now = Number(readFileSync(pidFile, 'utf8'));
        if (now !== pid) {
            try {
                process.kill(now, 0);
                restarted = now;
            } catch {
                // 還在啟動
            }
        }
    }
    assert.ok(restarted, '錨定程式被重新啟動');
    const head = Number((await one(admin, 'select seq from sgn.audit_chain_head')).seq);
    let caught = false;
    for (let i = 0; i < 50 && !caught; i += 1) {
        await sleep(200);
        caught = (await anchorsNow()).at(-1).seq >= head;
    }
    assert.ok(caught, '重新啟動之後錨定恢復');
});
