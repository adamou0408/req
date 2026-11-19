// 雜湊鏈的離線驗證邏輯。不信任資料庫算出的任何雜湊：從原始 body bytes 重算。
// 演算法（公開）：hash_n = sha256(hash_{n-1} || body_n)，hash_0 = 32 個 0x00；body 是 UTF-8 JSON，內含 seq。
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';
import pg from 'pg';

export const GENESIS = Buffer.alloc(32);
const PAGE = 5000;

export function readAnchors(file) {
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
}

export function appendAnchor(file, anchor) {
    const fd = openSync(file, 'a');
    try {
        writeSync(fd, `${JSON.stringify(anchor)}\n`);
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
}

export async function* readEvents(db, afterSeq = 0) {
    let after = afterSeq;
    for (;;) {
        const { rows } = await db.query('select * from api_job.events_after($1, $2)', [after, PAGE]);
        for (const row of rows) yield row;
        if (rows.length < PAGE) return;
        after = Number(rows[rows.length - 1].seq);
    }
}

/** 逐筆檢查一個事件，回傳這筆重算出來的雜湊與發現的問題。 */
export function checkEvent(row, expectedSeq, prevHash) {
    const problems = [];
    const seq = Number(row.seq);
    const body = Buffer.from(row.body, 'base64');
    const computed = createHash('sha256').update(prevHash).update(body).digest();
    if (seq !== expectedSeq) problems.push({ type: 'SEQ_GAP', seq, expected: expectedSeq });
    if (row.prev_hash !== prevHash.toString('hex')) problems.push({ type: 'LINK_BROKEN', seq });
    if (row.hash !== computed.toString('hex')) problems.push({ type: 'HASH_MISMATCH', seq });
    let parsed;
    try {
        parsed = JSON.parse(body.toString('utf8'));
    } catch {
        problems.push({ type: 'BODY_UNPARSABLE', seq });
        return { computed, problems };
    }
    const columnsMatch =
        parsed.seq === seq &&
        parsed.type === row.event_type &&
        (parsed.case_id ?? null) === (row.case_id ?? null) &&
        (parsed.actor ?? null) === (row.actor_person_id ?? null) &&
        new Date(parsed.at).getTime() === new Date(row.occurred_at).getTime();
    if (!columnsMatch) problems.push({ type: 'COLUMN_MISMATCH', seq });
    return { computed, problems };
}

/**
 * 全量驗證：從創世重算整條鏈，比對鏈頭，並比對資料庫以外的錨點檔。
 * 回傳 { ok, problems, count, head }。
 */
export async function verifyChain({ dbUrl, anchorFile }) {
    const db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
    const problems = [];
    const computedBySeq = new Map();
    let prev = GENESIS;
    let expected = 1;
    try {
        for await (const row of readEvents(db, 0)) {
            const { computed, problems: found } = checkEvent(row, expected, prev);
            problems.push(...found);
            computedBySeq.set(Number(row.seq), computed.toString('hex'));
            prev = computed;
            expected = Number(row.seq) + 1;
        }
        const {
            rows: [head],
        } = await db.query('select * from api_job.chain_head()');
        const lastSeq = expected - 1;
        if (Number(head.seq) !== lastSeq || head.hash !== prev.toString('hex')) {
            problems.push({ type: 'HEAD_MISMATCH', head_seq: Number(head.seq), last_seq: lastSeq });
        }
        const anchors = anchorFile ? readAnchors(anchorFile) : [];
        const lastAnchor = anchors[anchors.length - 1];
        const {
            rows: [code],
        } = await db.query('select api_job.code_fingerprint() as fp');
        if (lastAnchor?.code_fingerprint && lastAnchor.code_fingerprint !== code.fp) {
            problems.push({ type: 'CODE_CHANGED', since_anchor_seq: lastAnchor.seq });
        }
        for (const anchor of anchors) {
            if (anchor.seq > lastSeq) {
                problems.push({ type: 'ANCHOR_BEYOND_HEAD', anchor_seq: anchor.seq, last_seq: lastSeq });
            } else if (anchor.seq > 0 && computedBySeq.get(anchor.seq) !== anchor.hash) {
                problems.push({ type: 'ANCHOR_MISMATCH', anchor_seq: anchor.seq });
            }
        }
        return { ok: problems.length === 0, problems, count: lastSeq, anchors: anchors.length, head };
    } finally {
        await db.end();
    }
}

/**
 * 錨定一次：從上一個錨點開始重算到目前鏈頭（增量驗證），一致才把新的鏈頭與程式指紋寫到資料庫以外的檔案。
 * 不一致就不寫，回傳問題。程式指紋改變（例如正式的 migration）也不寫，要由人確認後另行處理；探針沒有做這個流程。
 */
export async function anchorOnce({ dbUrl, anchorFile, label = 'sgn' }) {
    const anchors = readAnchors(anchorFile);
    const last = anchors[anchors.length - 1] ?? { seq: 0, hash: GENESIS.toString('hex') };
    const db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
    const problems = [];
    try {
        let prev = Buffer.from(last.hash, 'hex');
        let expected = last.seq + 1;
        let first = true;
        for await (const row of readEvents(db, Math.max(last.seq - 1, 0))) {
            const seq = Number(row.seq);
            if (first && last.seq > 0) {
                first = false;
                if (seq !== last.seq || row.hash !== last.hash) problems.push({ type: 'ANCHOR_MISMATCH', anchor_seq: last.seq });
                continue;
            }
            first = false;
            const { computed, problems: found } = checkEvent(row, expected, prev);
            problems.push(...found);
            prev = computed;
            expected = seq + 1;
        }
        if (first && last.seq > 0) problems.push({ type: 'ANCHOR_BEYOND_HEAD', anchor_seq: last.seq });
        const {
            rows: [code],
        } = await db.query('select api_job.code_fingerprint() as fp');
        if (last.code_fingerprint && last.code_fingerprint !== code.fp) {
            problems.push({ type: 'CODE_CHANGED', since_anchor_seq: last.seq });
        }
        if (problems.length) return { ok: false, problems };
        const anchor = {
            seq: expected - 1,
            hash: prev.toString('hex'),
            code_fingerprint: code.fp,
            anchored_at: new Date().toISOString(),
            label,
        };
        if (anchor.seq > last.seq || anchor.code_fingerprint !== last.code_fingerprint) appendAnchor(anchorFile, anchor);
        return { ok: true, anchor };
    } finally {
        await db.end();
    }
}
