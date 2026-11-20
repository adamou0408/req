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

/**
 * 決定要簽的內容（資料庫的 sgn_internal.decision_signed_payload；裁決 D75）：版本雜湊、顯示摘要的雜湊與輸入。
 * display 是畫面畫出決定畫面用的那一份顯示摘要（頁面只從它畫，簽的就是它）。輸入：原因、縮小後那一版的雜湊與顯示、
 * 執行內容的雜湊。
 */
export async function decisionContent(display, decision, input) {
    const base = { version_sha256: display.version_sha256, display_sha256: await jsonSha256(display) };
    if (['return', 'reject', 'recall'].includes(decision)) return { ...base, input: { reason: input.reason } };
    if (decision === 'approve_reduced')
        return {
            ...base,
            input: { version_sha256: await versionSha256(input.content, input.terms), display_sha256: await jsonSha256(input.display) },
        };
    if (decision === 'fulfil') return { ...base, input: { payload_sha256: await jsonSha256(input.payload) } };
    return { ...base, input: {} };
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

/** P-256 公鑰的指紋（未壓縮點的 SHA-256，hex）。SPKI 的最後 65 bytes 就是未壓縮點。 */
export async function keyFingerprint(spki) {
    return hex(await sha256(spki.slice(spki.length - 65)));
}

/**
 * 金鑰登記核對碼的成本（log2 的迭代次數）可以接受的範圍（裁決 D76）。成本由資料庫的參數 passkey.enrollment_code_cost 決定、
 * 經後端送到兩邊的頁面；新裝置的頁面若接受任意成本，被入侵的後端就能在受害者畫面上換很多種成本，一次比對很多個目標
 * （多目標碰撞）。所以頁面只接受這個窄範圍（最多 5 種），而且成本也是鹽的一部分，每個目標都要付完整的慢速雜湊。
 * db/tests/kernel/84-enrollment-code.test.mjs 檢查參數的預設值在這個範圍內。
 */
export const ENROLLMENT_CODE_COST = Object.freeze({ min: 20, max: 24 });

async function slowCode(fingerprint, cost) {
    const text = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', text.encode(fingerprint), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', hash: 'SHA-256', salt: text.encode(`sgn/passkey-enrollment/${cost}`), iterations: 2 ** cost },
        key,
        64,
    );
    return (BigInt(`0x${hex(new Uint8Array(bits))}`) % 10n ** 12n).toString().padStart(12, '0');
}

/**
 * 金鑰登記的 12 位數核對碼（D76）：從完整指紋以 PBKDF2-HMAC-SHA256（2^cost 次，單次約一秒）算出，讓離線碰撞不可行
 * （約 10^12 次慢速雜湊）。新裝置的畫面與背書人的畫面各自從自己拿到的指紋算，兩人當面或電話核對。
 * 成本不在 ENROLLMENT_CODE_COST 範圍內時立即丟錯（不回傳 promise）。
 */
export function shortCode(fingerprint, cost) {
    if (!Number.isInteger(cost) || cost < ENROLLMENT_CODE_COST.min || cost > ENROLLMENT_CODE_COST.max)
        throw new RangeError(`核對碼的成本 ${cost} 不在 ${ENROLLMENT_CODE_COST.min}–${ENROLLMENT_CODE_COST.max}`);
    if (!/^[0-9a-f]{64}$/.test(fingerprint)) throw new RangeError('指紋格式不正確');
    return slowCode(fingerprint, cost);
}

/** 12 位數分成三組顯示（1234 5678 9012）。 */
export const groupedCode = (code) => code.replace(/(\d{4})(?=\d)/g, '$1 ');
