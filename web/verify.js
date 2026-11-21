// 稽核人員的瀏覽器自己做的驗證。不相信後端、也不相信資料庫算好的任何雜湊或判斷：
//   1. 整條雜湊鏈從創世重算（hash_n = sha256(hash_{n-1} || body_n)），比對外部錨點與程式指紋
//   2. 這張單的每筆事件都在重算過的鏈上
//   3. 內容指紋 = sha256(RFC 8785 標準化的內容)，瀏覽器自己標準化，和送審、核准時記下的一致
//   4. 每個決定（核准、縮小後核准、退回、駁回、撤回、標記已套用）的通行金鑰簽章用 WebCrypto 重驗，
//      簽的是鏈上記下的那一版內容，公鑰對得到鏈上的登記事件，決定者是那一關開始時指派或認領的人（撤回是申請人）
// 錨點直接向獨立的錨點存放處取得（頁面來源的 /config.json 告訴它在哪裡），不經後端（裁決 D81 (4)）：
// 後端改寫了鏈，也換不了錨點。這支程式不依賴頁面的模組，離線（Node）時給 location 就能跑。
// 限制：這支程式本身由頁面的伺服器送來（D68：和後端分開部署）；正式環境的稽核工具要從獨立管道取得（見 docs/handoff/probe-path-findings.md）。
import { canonicalize } from './lib/jcs.js';
import { signingChallenge, toB64url } from './lib/signing.js';
import { unb64url } from './webauthn.js';

const PAGE = 5000;
const utf8 = new TextDecoder();
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const fromHex = (h) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');
const concat = (...parts) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
        out.set(p, at);
        at += p.length;
    }
    return out;
};
const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));

async function verifyChain(api) {
    const problems = [];
    const hashBySeq = new Map();
    const occurredAt = new Map();
    let prev = new Uint8Array(32);
    let expected = 1;
    for (let after = 0; ; ) {
        const rows = await api.call('audit_chain', { after_seq: after, limit: PAGE });
        for (const row of rows) {
            const seq = Number(row.seq);
            const body = fromB64(row.body);
            const computed = await sha256(concat(prev, body));
            if (seq !== expected) problems.push(`序號不連續：第 ${seq} 筆（應為 ${expected}）`);
            if (row.prev_hash !== hex(prev)) problems.push(`第 ${seq} 筆的前一筆雜湊對不上`);
            if (row.hash !== hex(computed)) problems.push(`第 ${seq} 筆的內容和雜湊不符`);
            const parsed = JSON.parse(utf8.decode(body));
            const columnsMatch =
                parsed.seq === seq &&
                parsed.type === row.event_type &&
                (parsed.case_id ?? null) === (row.case_id ?? null) &&
                (parsed.actor ?? null) === (row.actor_person_id ?? null) &&
                new Date(parsed.at).getTime() === new Date(row.occurred_at).getTime();
            if (!columnsMatch) problems.push(`第 ${seq} 筆的查詢欄位和原文不一致`);
            hashBySeq.set(seq, hex(computed));
            occurredAt.set(seq, row.occurred_at);
            prev = computed;
            expected = seq + 1;
            after = seq;
        }
        if (rows.length < PAGE) break;
    }
    return { problems, hashBySeq, occurredAt, lastSeq: expected - 1 };
}

/** 錨點存放處的全部錨點：位置來自頁面來源的 /config.json（不是後端）。 */
export async function fetchAnchors() {
    const { ANCHOR_ORIGIN } = await (await fetch(new URL('/config.json', location.origin))).json();
    const res = await fetch(new URL('/anchors', ANCHOR_ORIGIN), { cache: 'no-store' });
    if (!res.ok) throw new Error(`錨點存放處 HTTP ${res.status}`);
    return res.json();
}

async function verifyAnchors(api, chain) {
    const problems = [];
    const anchors = await fetchAnchors();
    for (const anchor of anchors) {
        if (anchor.seq > chain.lastSeq) problems.push(`外部錨點記到第 ${anchor.seq} 筆，資料庫只剩 ${chain.lastSeq} 筆（被刪除或還原過）`);
        else if (anchor.seq > 0 && chain.hashBySeq.get(anchor.seq) !== anchor.hash) problems.push(`第 ${anchor.seq} 筆和外部錨點不符`);
    }
    const last = anchors.at(-1);
    const code = await api.call('audit_code_fingerprint');
    if (last?.code_fingerprint && last.code_fingerprint !== code.code_fingerprint) {
        problems.push('資料庫的程式在最後一次錨定之後被改過');
    }
    const lag = anchorLag(chain, last?.seq ?? 0, code.anchor_policy);
    if (lag) problems.push(lag);
    return { problems, lastAnchorSeq: last?.seq ?? 0, anchorCount: anchors.length };
}

/**
 * 錨定落後超過參數（裁決 D84 (7)）：最後一個錨點之後的事件，最舊一筆超過 max_lag_seconds 或筆數超過 max_lag_events，就是失敗，
 * 不是「尚未錨定」的警告——錨定停擺時，之後的紀錄只靠資料庫保護，後端改寫了也看不出來。參數不足一個週期的落後仍只是警告。
 */
function anchorLag(chain, lastAnchorSeq, policy) {
    const events = chain.lastSeq - Math.min(lastAnchorSeq, chain.lastSeq);
    if (events <= 0) return null;
    const oldest = chain.occurredAt.get(chain.lastSeq - events + 1);
    const seconds = Math.round((Date.now() - new Date(oldest).getTime()) / 1000);
    if (events > policy.max_lag_events || seconds > policy.max_lag_seconds) {
        return `外部錨定落後：最後一個錨點之後有 ${events} 筆紀錄、最舊一筆已經 ${seconds} 秒（上限 ${policy.max_lag_seconds} 秒、${policy.max_lag_events} 筆）`;
    }
    return null;
}

function derToRaw(der) {
    // ECDSA DER：30 len 02 rlen r 02 slen s → 64 bytes r||s
    const read = (at) => {
        const len = der[at + 1];
        let int = der.slice(at + 2, at + 2 + len);
        while (int.length > 32 && int[0] === 0) int = int.slice(1);
        return { int: concat(new Uint8Array(32 - int.length), int), next: at + 2 + len };
    };
    const r = read(2);
    const s = read(r.next);
    return concat(r.int, s.int);
}

async function verifyPasskeyProof(proof, event, events) {
    const problems = [];
    const data = event.parsed.data;
    const raw = proof.raw;
    if (hex(await sha256(new TextEncoder().encode(canonicalize(raw)))) !== data.proof_sha256) problems.push('證明原文和紀錄裡的指紋不符');
    const clientDataBytes = unb64url(raw.client_data_json);
    const clientData = JSON.parse(utf8.decode(clientDataBytes));
    const authData = unb64url(raw.authenticator_data);
    if (clientData.type !== 'webauthn.get' || clientData.challenge !== data.challenge) problems.push('簽章不是針對這次決定的挑戰值');
    if (clientData.origin !== location.origin) problems.push('簽章來自別的網站');
    if ((authData[32] & 0x05) !== 0x05) problems.push('簽章時沒有經過使用者驗證');
    const key = await crypto.subtle.importKey('raw', unb64url(proof.public_key), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const signed = concat(authData, await sha256(clientDataBytes));
    const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToRaw(unb64url(raw.signature)), signed);
    if (!valid) problems.push('通行金鑰簽章驗不過');
    const registered = events.find((e) => e.parsed.type === 'passkey.registered' && e.parsed.data.credential_id === raw.credential_id);
    if (!registered) problems.push('找不到這把通行金鑰的登記紀錄');
    else {
        if (hex(await sha256(unb64url(proof.public_key))) !== registered.parsed.data.public_key_sha256) problems.push('公鑰和登記紀錄不符');
        if (registered.parsed.actor !== event.parsed.actor) problems.push('簽章的金鑰不屬於做決定的人');
    }
    return problems;
}

// 決定的種類（事件類型 case.<決定>）；撤回只能由申請人，其餘必須是鏈上指派或認領了這張單工作的人。
const DECISIONS = ['approve', 'approve_reduced', 'return', 'reject', 'recall', 'fulfil'].map((d) => `case.${d}`);

/** 鏈上記下的每一版內容指紋（建立、修改、縮小、依新的定義重新綁定都會記）。 */
function versionHashes(ownEvents) {
    const map = new Map();
    for (const e of ownEvents) {
        const d = e.parsed.data ?? {};
        if (['case.created', 'case.revised', 'case.reduced', 'case.rebound'].includes(e.parsed.type)) map.set(d.version, d.content_sha256);
    }
    return map;
}

/** 鏈上記下的決定者：每一關開始時指派的人，加上認領的人；申請人是建立申請的人。 */
function deciders(ownEvents) {
    const assigned = new Set();
    for (const e of ownEvents) {
        if (e.parsed.type === 'case.stage_opened')
            for (const task of e.parsed.data.tasks ?? []) if (task.assignee) assigned.add(task.assignee);
        if (e.parsed.type === 'case.claimed') assigned.add(e.parsed.actor);
    }
    const applicant = ownEvents.find((e) => e.parsed.type === 'case.created')?.parsed.actor;
    return { assigned, applicant };
}

async function verifyDecisions(audit, events, ownEvents) {
    const problems = [];
    const hashes = versionHashes(ownEvents);
    const who = deciders(ownEvents);
    let checked = 0;
    for (const e of ownEvents.filter((x) => DECISIONS.includes(x.parsed.type))) {
        const d = e.parsed.data;
        if (hashes.get(d.version) !== d.content_sha256) problems.push(`第 ${e.seq} 筆決定簽的內容和鏈上第 ${d.version} 版的指紋不符`);
        // 挑戰值是由「簽了什麼」（用途、單號、內容、決定種類）與 nonce 算出來的（D68）：自己重算一次
        if (d.signed && toB64url(await signingChallenge({ ...d.signed, nonce: d.nonce })) !== d.challenge)
            problems.push(`第 ${e.seq} 筆決定記下的挑戰值和它簽的內容對不上`);
        const proof = audit.proofs.find((p) => p.challenge === d.challenge);
        if (!proof || proof.kind !== 'passkey') problems.push(`第 ${e.seq} 筆決定沒有可重驗的通行金鑰證明`);
        else problems.push(...(await verifyPasskeyProof(proof, e, events)));
        const eligible = e.parsed.type === 'case.recall' ? e.parsed.actor === who.applicant : who.assigned.has(e.parsed.actor);
        if (!eligible) problems.push(`第 ${e.seq} 筆決定的人不是鏈上指派或認領這張單的人`);
        if (e.parsed.type !== 'case.recall' && e.parsed.actor === who.applicant) problems.push(`第 ${e.seq} 筆決定由申請人自己做出`);
        checked += 1;
    }
    return { problems, checked, hashes };
}

/** 驗證一張單。回傳 { status: 'ok' | 'warn' | 'bad', checks, problems, unanchored, events }；events 含這張單的事件與所用通行金鑰的登記事件。 */
export async function verifyCase(api, audit) {
    const chain = await verifyChain(api);
    const anchors = await verifyAnchors(api, chain);
    const problems = [...chain.problems, ...anchors.problems];
    const events = audit.events.map((e) => ({ ...e, parsed: JSON.parse(utf8.decode(fromB64(e.body))) }));
    for (const e of events) {
        const recomputed = hex(await sha256(concat(fromHex(e.prev_hash), fromB64(e.body))));
        if (recomputed !== chain.hashBySeq.get(e.seq)) problems.push(`這張單的第 ${e.seq} 筆紀錄和整條鏈對不上`);
    }
    const ownEvents = events.filter((e) => e.parsed.case_id === audit.case.case_id);
    const contentHash = hex(await sha256(new TextEncoder().encode(canonicalize(audit.case.content))));
    if (contentHash !== audit.case.content_sha256) problems.push('申請內容和內容指紋不符');
    const decisions = await verifyDecisions(audit, events, ownEvents);
    problems.push(...decisions.problems);
    if (decisions.hashes.get(audit.case.version) !== contentHash) problems.push('目前的內容不是鏈上記下的最新一版');
    const proofsChecked = decisions.checked;
    // 錨點之後的紀錄只靠資料庫保護：逐筆標示，有任何一筆就不算驗證通過（status 是 warn，不是 ok）
    for (const e of events) e.anchored = e.seq <= anchors.lastAnchorSeq;
    const unanchored = ownEvents.filter((e) => !e.anchored).length;
    const checks = [
        `整條雜湊鏈 ${chain.lastSeq} 筆從頭重算`,
        `比對外部錨點 ${anchors.anchorCount} 個（最後一個到第 ${anchors.lastAnchorSeq} 筆）與程式指紋`,
        `這張單的 ${ownEvents.length} 筆紀錄都在鏈上`,
        '申請內容和內容指紋一致，且是鏈上記下的最新一版',
        `重驗 ${proofsChecked} 個決定：各自簽的版本、通行金鑰簽章、金鑰登記，決定者是鏈上指派或認領的人`,
    ];
    const status = problems.length ? 'bad' : unanchored > 0 || anchors.anchorCount === 0 ? 'warn' : 'ok';
    return { status, checks, problems, unanchored, events };
}
