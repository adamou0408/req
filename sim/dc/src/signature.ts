// 規則來源的驗證：會改變權限的請求（套用、撤回）必須帶平台的 Ed25519 簽章。
//
//   Sgn-Signature: keyid="<金鑰代號>", alg="ed25519", sig="<簽章的 base64>"
//
// 被簽的位元組 = "sgn-dc-sig/1\n" 的 UTF-8 + 請求本文的原始位元組（不重新序列化）。
// 平台送出的本文必須就是簽章時的那串位元組；DC 收到後先驗簽章，再解析 JSON。
// 前綴是領域分隔：同一把金鑰簽的其他東西，不會剛好也是一個有效的 DC 請求。
// 要換做法（例如改用 JWS 或 HTTP Message Signatures）只需要換這個檔案。
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const SIGNATURE_HEADER = 'sgn-signature';
const PREFIX = Buffer.from('sgn-dc-sig/1\n', 'utf8');
const HEADER = /^\s*keyid="([A-Za-z0-9._-]{1,64})",\s*alg="ed25519",\s*sig="([A-Za-z0-9+/]+={0,2})"\s*$/;

export class SignatureError extends Error {}

export type TrustedKeys = ReadonlyMap<string, KeyObject>;

// 檔案格式：{"keys": [{"key_id": "platform-dev", "public_key_pem": "-----BEGIN PUBLIC KEY-----…"}]}
export function loadTrustedKeys(file: string): TrustedKeys {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { keys?: { key_id: string; public_key_pem: string }[] };
    const keys = new Map<string, KeyObject>();
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
