// 通行金鑰要簽的挑戰值（裁決 D68）：瀏覽器從畫面上顯示的內容自己算，不用後端給的值。
// 挑戰值＝SHA-256（RFC 8785 標準化的 {purpose, ref, content_sha256, decision, nonce}），
// content_sha256＝SHA-256（標準化的內容）。資料庫的 sgn_internal.signing_challenge 是同一個公式（db/kernel/250_signing.sql），
// db/tests/kernel/81-signing.test.mjs 檢查兩邊算出相同的位元組。瀏覽器與 Node（測試扮演瀏覽器）共用這一份。
import { canonicalize } from './jcs.js';

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

export const toB64url = (bytes) =>
    btoa(String.fromCharCode(...bytes))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replace(/=+$/, '');

export const fromB64url = (s) => Uint8Array.from(atob(s.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0));

export async function sha256(bytes) {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

/** 標準化 JSON 的 SHA-256（hex）。 */
export async function jsonSha256(value) {
    return hex(await sha256(new TextEncoder().encode(canonicalize(value))));
}

/** 畫面上的 terms（被授權者物件、起迄）換回資料庫保存的形式：{principal_id, valid_from, valid_to}，沒有值的鍵不出現。 */
export function storedTerms(terms) {
    const out = {
        principal_id: terms?.principal?.principal_id ?? terms?.principal_id,
        valid_from: terms?.valid_from,
        valid_to: terms?.valid_to,
    };
    return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== null && v !== undefined));
}

/** 一個版本的雜湊：內容與 terms 一起（資料庫的 case_version.version_sha256）。 */
export const versionSha256 = (content, terms) => jsonSha256({ content, terms: storedTerms(terms) });

/** 決定要簽的輸入：原因、縮小後那一版的雜湊、執行內容的雜湊（資料庫的 sgn_internal.decision_signed_content）。 */
export async function decisionContent(versionHash, decision, input) {
    if (['return', 'reject', 'recall'].includes(decision)) return { version_sha256: versionHash, input: { reason: input.reason } };
    if (decision === 'approve_reduced')
        return { version_sha256: versionHash, input: { version_sha256: await versionSha256(input.content, input.terms) } };
    if (decision === 'fulfil') return { version_sha256: versionHash, input: { payload_sha256: await jsonSha256(input.payload) } };
    return { version_sha256: versionHash, input: {} };
}

/** 挑戰值（32 bytes）。nonce 是資料庫給的 base64url 字串，其他都來自畫面。 */
export async function signingChallenge({ purpose, ref, content, decision, nonce }) {
    const text = canonicalize({ purpose, ref: String(ref), content_sha256: await jsonSha256(content), decision, nonce });
    return sha256(new TextEncoder().encode(text));
}

const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

function derInt(value) {
    let h = value.toString(16);
    if (h.length % 2) h = `0${h}`;
    let bytes = h.match(/../g).map((x) => parseInt(x, 16));
    if (bytes[0] & 0x80) bytes = [0, ...bytes];
    return [0x02, bytes.length, ...bytes];
}

/** ECDSA 簽章（DER）換成 low-s（D71：資料庫只收 low-s）。(r, n−s) 和 (r, s) 對同一份資料一樣有效。 */
export function lowS(der) {
    const read = (at) => {
        const len = der[at + 1];
        const bytes = der.slice(at + 2, at + 2 + len);
        return { value: BigInt(`0x${hex(bytes) || '0'}`), next: at + 2 + len };
    };
    const r = read(2);
    const s = read(r.next);
    if (s.value * 2n <= P256_N) return der;
    const body = [...derInt(r.value), ...derInt(P256_N - s.value)];
    return new Uint8Array([0x30, body.length, ...body]);
}

/** P-256 公鑰的指紋（未壓縮點的 SHA-256，hex）與兩邊對照用的六位數短碼（D65）。SPKI 的最後 65 bytes 就是未壓縮點。 */
export async function keyFingerprint(spki) {
    const point = spki.slice(spki.length - 65);
    const fingerprint = hex(await sha256(point));
    return { fingerprint, shortCode: shortCode(fingerprint) };
}

export const shortCode = (fingerprint) => String(parseInt(fingerprint.slice(0, 8), 16) % 1000000).padStart(6, '0');
