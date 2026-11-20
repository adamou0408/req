// 端對端：錨點存放處（裁決 D81 (4)；紅隊第四輪 中-4，redteam/exploits/32-audit-page-forged-chain.mjs）。
// 稽核頁的驗證程式（web/verify.js，原封不動）直接向錨點存放處取錨點，不經後端：後端（B）改寫了鏈，也換不了錨點。
// 「拿掉防法就失敗」：verify.js 若改回用後端給的錨點，第一個測試的改寫就會被判為 ok。
// 前提：tools/run-all.sh 啟動的錨點存放處、錨定程式、後端與頁面（檔名排在最後：其他端對端測試的事件都已錨定）。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { after, test } from 'node:test';
import { anchorFile, loadConfig } from '../../db/tools/lib/env.mjs';
import { call, closePools, login, pool } from '../../db/tests/kernel/lib/harness.mjs';
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
