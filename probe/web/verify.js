// 稽核人員的瀏覽器自己做的驗證。不相信後端、也不相信資料庫算好的任何雜湊或判斷：
//   1. 整條雜湊鏈從創世重算（hash_n = sha256(hash_{n-1} || body_n)），比對外部錨點與程式指紋
//   2. 這張單的每筆事件都在重算過的鏈上
//   3. 內容指紋 = sha256(內容原文)，和送審、核准時記下的一致
//   4. 核准的通行金鑰簽章用 WebCrypto 重驗，公鑰對得到鏈上的登記事件，簽章的人就是送審時指定的簽核人
// 限制：這支程式本身由後端送來；正式環境的稽核工具要從獨立管道取得（見 probe/docs/path-findings.md）。
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
    let prev = new Uint8Array(32);
    let expected = 1;
    for (let after = 0; ; ) {
        const rows = await api.auditChain(after, PAGE);
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
            prev = computed;
            expected = seq + 1;
            after = seq;
        }
        if (rows.length < PAGE) break;
    }
    return { problems, hashBySeq, lastSeq: expected - 1 };
}

async function verifyAnchors(api, chain) {
    const problems = [];
    const anchors = await api.anchors();
    for (const anchor of anchors) {
        if (anchor.seq > chain.lastSeq) problems.push(`外部錨點記到第 ${anchor.seq} 筆，資料庫只剩 ${chain.lastSeq} 筆（被刪除或還原過）`);
        else if (anchor.seq > 0 && chain.hashBySeq.get(anchor.seq) !== anchor.hash) problems.push(`第 ${anchor.seq} 筆和外部錨點不符`);
    }
    const last = anchors.at(-1);
    if (last?.code_fingerprint && last.code_fingerprint !== (await api.auditCodeFingerprint())) {
        problems.push('資料庫的程式在最後一次錨定之後被改過');
    }
    return { problems, lastAnchorSeq: last?.seq ?? 0, anchorCount: anchors.length };
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

async function verifyPasskeyProof(proof, event, events, submitted) {
    const problems = [];
    const data = event.parsed.data;
    if (hex(await sha256(new TextEncoder().encode(proof.raw_text))) !== data.proof_sha256) problems.push('證明原文和紀錄裡的指紋不符');
    const raw = JSON.parse(proof.raw_text);
    const clientDataBytes = unb64url(raw.client_data_json);
    const clientData = JSON.parse(utf8.decode(clientDataBytes));
    const authData = unb64url(raw.authenticator_data);
    if (clientData.type !== 'webauthn.get' || clientData.challenge !== data.challenge) problems.push('簽章不是針對這次決定的挑戰值');
    if (clientData.origin !== location.origin) problems.push('簽章來自別的網站');
    if ((authData[32] & 0x05) !== 0x05) problems.push('簽章時沒有經過使用者驗證');
    const key = await crypto.subtle.importKey('raw', unb64url(proof.public_key), { name: 'ECDSA', namedCurve: 'P-256' }, false, [
        'verify',
    ]);
    const signed = concat(authData, await sha256(clientDataBytes));
    const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToRaw(unb64url(raw.signature)), signed);
    if (!valid) problems.push('通行金鑰簽章驗不過');
    const registered = events.find((e) => e.parsed.type === 'passkey.registered' && e.parsed.data.credential_id === raw.credential_id);
    if (!registered) problems.push('找不到這把通行金鑰的登記紀錄');
    else {
        if (hex(await sha256(unb64url(proof.public_key))) !== registered.parsed.data.public_key_sha256) problems.push('公鑰和登記紀錄不符');
        if (registered.parsed.actor !== event.parsed.actor) problems.push('簽章的金鑰不屬於做決定的人');
    }
    if (submitted && event.parsed.actor !== submitted.parsed.data.approver) problems.push('做決定的人不是送審時指定的簽核人');
    return problems;
}

/** 驗證一張單。回傳 { status: 'ok' | 'warn' | 'bad', checks, problems, unanchored, events }。 */
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
    const contentHash = hex(await sha256(new TextEncoder().encode(audit.case.content_text)));
    if (contentHash !== audit.case.content_sha256) problems.push('申請內容和內容指紋不符');
    const submitted = ownEvents.findLast((e) => e.parsed.type === 'case.submitted');
    let proofsChecked = 0;
    for (const e of ownEvents.filter((x) => ['case.approve', 'case.return'].includes(x.parsed.type))) {
        if (e.parsed.data.content_sha256 !== contentHash) problems.push(`第 ${e.seq} 筆決定簽的不是現在這份內容`);
        const proof = audit.proofs.find((p) => p.challenge === e.parsed.data.challenge);
        if (!proof || proof.kind !== 'passkey') problems.push(`第 ${e.seq} 筆決定沒有可重驗的通行金鑰證明`);
        else problems.push(...(await verifyPasskeyProof(proof, e, events, submitted)));
        proofsChecked += 1;
    }
    const unanchored = ownEvents.filter((e) => e.seq > anchors.lastAnchorSeq).length;
    const checks = [
        `整條雜湊鏈 ${chain.lastSeq} 筆從頭重算`,
        `比對外部錨點 ${anchors.anchorCount} 個（最後一個到第 ${anchors.lastAnchorSeq} 筆）與程式指紋`,
        `這張單的 ${ownEvents.length} 筆紀錄都在鏈上`,
        '申請內容和內容指紋一致',
        `重驗 ${proofsChecked} 個決定的通行金鑰簽章、金鑰登記與簽核人`,
    ];
    const status = problems.length ? 'bad' : unanchored > 0 || anchors.anchorCount === 0 ? 'warn' : 'ok';
    return { status, checks, problems, unanchored, events: ownEvents };
}
