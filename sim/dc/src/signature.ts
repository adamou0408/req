// 規則來源的驗證與回應的證明（裁決 D81 (2)：平台定義的「外部系統交付介面」完整等級）。
//
// 一、平台送來、會改變權限的請求（套用、撤回）必須帶平台的 Ed25519 簽章：
//
//   Sgn-Signature: keyid="<金鑰代號>", alg="ed25519", sig="<簽章的 base64>"
//
//   被簽的位元組 = "sgn-dc-sig/1\n" 的 UTF-8 + 請求本文的原始位元組（不重新序列化）。本文是一個信封：
//   {"format":"sgn_dc_request/1","channel","environment","method","path","not_after","payload"}
//   通道、環境、方法、路徑都要和這次請求一致，not_after 之後不收：同一份已簽章的規則不能送到別的環境、別的端點，
//   也不能在很久之後才送出。信任清單每個環境各自一份。
//
// 二、DC 的每個回應都帶「證明」（attestation）：DC 以自己的 ES256 金鑰簽一段文字 payload，內容是這次請求的摘要
//   （通道、環境、方法、路徑、請求本文的 SHA-256、平台給的一次性亂數 Sgn-Nonce）、HTTP 狀態、時間與結果本身。
//   平台只採信 payload 裡的結果（驗章之後）；回應本文的其他欄位只是同一份結果的可讀副本，給不驗章的人與工具看。
//   被簽的位元組 = "sgn-dc-attestation/1\n" + payload 的 UTF-8；簽章是 DER 編碼的 ECDSA（P-256、SHA-256）。
// 要換做法（JWS、HTTP Message Signatures）只需要換這個檔案。
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

export const SIGNATURE_HEADER = 'sgn-signature';
export const NONCE_HEADER = 'sgn-nonce';
export const REQUEST_FORMAT = 'sgn_dc_request/1';
export const ATTESTATION_FORMAT = 'sgn_dc_attestation/1';
const PREFIX = Buffer.from('sgn-dc-sig/1\n', 'utf8');
const ATTESTATION_PREFIX = Buffer.from('sgn-dc-attestation/1\n', 'utf8');
const HEADER = /^\s*keyid="([A-Za-z0-9._-]{1,64})",\s*alg="ed25519",\s*sig="([A-Za-z0-9+/]+={0,2})"\s*$/;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;

export class SignatureError extends Error {}

/** 信封已驗章，但內容和這次請求不符或已過期。code 是回應的錯誤代碼。 */
export class EnvelopeError extends Error {
    readonly code: 'target_mismatch' | 'signature_expired' | 'invalid_envelope';
    constructor(code: EnvelopeError['code'], message: string) {
        super(message);
        this.code = code;
    }
}

export type TrustedKeys = ReadonlyMap<string, KeyObject>;

// 檔案格式：{"keys": [{"key_id": "sgn-sgn_e2e", "public_key_pem": "-----BEGIN PUBLIC KEY-----…"}]}。
// 檔案不存在＝不信任任何金鑰（沒有開發用的預設金鑰）。
export function loadTrustedKeys(file: string): TrustedKeys {
    const keys = new Map<string, KeyObject>();
    if (!existsSync(file)) return keys;
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { keys?: { key_id: string; public_key_pem: string }[] };
    for (const k of parsed.keys ?? []) {
        const key = createPublicKey(k.public_key_pem);
        if (key.asymmetricKeyType !== 'ed25519') throw new Error(`金鑰 ${k.key_id} 不是 Ed25519`);
        keys.set(k.key_id, key);
    }
    return keys;
}

function signedBytes(body: Buffer): Buffer {
    return Buffer.concat([PREFIX, body]);
}

export function verifyRequest(keys: TrustedKeys, header: string | undefined, body: Buffer): string {
    if (header === undefined || header === '') throw new SignatureError('沒有簽章（Sgn-Signature）');
    const m = HEADER.exec(header);
    if (m === null || m[1] === undefined || m[2] === undefined) throw new SignatureError('簽章格式不符');
    const key = keys.get(m[1]);
    if (key === undefined) throw new SignatureError(`不認得的金鑰 ${m[1]}`);
    const sig = Buffer.from(m[2], 'base64');
    if (sig.length !== 64 || !verify(null, signedBytes(body), key, sig)) throw new SignatureError('簽章不符');
    return m[1];
}

export interface Target {
    readonly channel: string;
    readonly environment: string;
    readonly method: string;
    readonly path: string;
}

/** 已驗章的本文 → 信封裡的 payload。通道、環境、方法、路徑要和這次請求一致，而且還沒過期。 */
export function openEnvelope(body: Buffer, target: Target, now: Date): unknown {
    let env: Record<string, unknown>;
    try {
        env = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
    } catch {
        throw new EnvelopeError('invalid_envelope', '本文不是 JSON');
    }
    if (typeof env !== 'object' || env === null || env['format'] !== REQUEST_FORMAT) {
        throw new EnvelopeError('invalid_envelope', `本文必須是 ${REQUEST_FORMAT} 的信封`);
    }
    for (const key of ['channel', 'environment', 'method', 'path'] as const) {
        if (env[key] !== target[key]) {
            throw new EnvelopeError('target_mismatch', `簽章指定的 ${key} 是 ${JSON.stringify(env[key])}，這次請求是 ${target[key]}`);
        }
    }
    const notAfter = typeof env['not_after'] === 'string' ? Date.parse(env['not_after']) : Number.NaN;
    if (Number.isNaN(notAfter)) throw new EnvelopeError('invalid_envelope', 'not_after 必須是時間');
    if (now.getTime() > notAfter) throw new EnvelopeError('signature_expired', `簽章在 ${String(env['not_after'])} 之後失效`);
    return env['payload'];
}

export function signRequest(privateKeyPem: string, keyId: string, body: Buffer): string {
    const sig = sign(null, signedBytes(body), createPrivateKey(privateKeyPem));
    return `keyid="${keyId}", alg="ed25519", sig="${sig.toString('base64')}"`;
}

export function generateKeyPair(): { privatePem: string; publicPem: string } {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    return {
        privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    };
}

// ── 回應的證明 ──

export interface ResponseKey {
    readonly keyId: string;
    readonly privateKey: KeyObject;
    readonly publicPem: string;
}

/** 金鑰代號由公鑰決定（SPKI 的 SHA-256 前 16 個十六進位字），換金鑰就換代號。 */
export function responseKeyId(publicPem: string): string {
    const der = createPublicKey(publicPem).export({ type: 'spki', format: 'der' });
    return `simdc-${createHash('sha256').update(der).digest('hex').slice(0, 16)}`;
}

export function loadResponseKey(file: string): ResponseKey {
    const privateKey = createPrivateKey(readFileSync(file, 'utf8'));
    if (privateKey.asymmetricKeyType !== 'ec') throw new Error('回應證明的金鑰必須是 P-256');
    const publicPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
    return { keyId: responseKeyId(publicPem), privateKey, publicPem };
}

export function generateResponseKey(): { privatePem: string; publicPem: string } {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    return {
        privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    };
}

/** 平台給的一次性亂數：格式不對就當成沒有給（證明裡是 null）。 */
export function nonceOf(header: string | string[] | undefined): string | null {
    return typeof header === 'string' && NONCE.test(header) ? header : null;
}

export interface Attestation {
    readonly payload: string;
    readonly key_id: string;
    readonly alg: 'es256';
    readonly sig: string;
}

export interface AttestedFields extends Target {
    readonly query: string;
    readonly requestBody: Buffer;
    readonly nonce: string | null;
    readonly httpStatus: number;
    readonly result: unknown;
}

export function attest(key: ResponseKey, f: AttestedFields, now: Date): Attestation {
    const payload = JSON.stringify({
        format: ATTESTATION_FORMAT,
        channel: f.channel,
        environment: f.environment,
        method: f.method,
        path: f.path,
        query: f.query,
        request_sha256: createHash('sha256').update(f.requestBody).digest('hex'),
        nonce: f.nonce,
        http_status: f.httpStatus,
        issued_at: now.toISOString(),
        result: f.result,
    });
    const sig = sign('sha256', Buffer.concat([ATTESTATION_PREFIX, Buffer.from(payload, 'utf8')]), {
        key: key.privateKey,
        dsaEncoding: 'der',
    });
    return { payload, key_id: key.keyId, alg: 'es256', sig: sig.toString('base64') };
}

/** 驗一份證明（測試與平台的模擬 adapter 用同一個格式；平台正式的驗證在資料庫裡）。 */
export function attestationValid(publicPem: string, a: Attestation): boolean {
    return verify(
        'sha256',
        Buffer.concat([ATTESTATION_PREFIX, Buffer.from(a.payload, 'utf8')]),
        { key: createPublicKey(publicPem), dsaEncoding: 'der' },
        Buffer.from(a.sig, 'base64'),
    );
}
