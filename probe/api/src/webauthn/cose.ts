// COSE 公鑰（RFC 9052／9053）轉成 Node 的 KeyObject，並輸出 SPKI（DER、PEM）。
// 只支援 ES256（P-256）與 RS256，這是主流通行金鑰與本探針的資料庫會用到的。
import { createPublicKey, type KeyObject } from 'node:crypto';
import { decodeCbor, type CborValue } from './cbor.ts';

export const COSE_ALG_ES256 = -7;
export const COSE_ALG_RS256 = -257;
const COSE_KTY_EC2 = 2;
const COSE_KTY_RSA = 3;
const COSE_CRV_P256 = 1;

export interface CosePublicKey {
    alg: number;
    key: KeyObject;
    spkiDer: Buffer;
    pem: string;
}

export class CoseError extends Error {}

function bytesOf(map: Map<CborValue, CborValue>, label: number): Buffer {
    const value = map.get(label);
    if (!(value instanceof Uint8Array)) throw new CoseError(`COSE 欄位 ${label} 不是位元組`);
    return Buffer.from(value);
}

export function parseCoseKey(cose: Uint8Array): CosePublicKey {
    const { value, end } = decodeCbor(cose);
    if (!(value instanceof Map)) throw new CoseError('COSE 公鑰不是 map');
    if (end !== cose.length) throw new CoseError('COSE 公鑰後面有多餘資料');
    const kty = value.get(1);
    const alg = value.get(3);
    let key: KeyObject;
    if (kty === COSE_KTY_EC2 && alg === COSE_ALG_ES256) {
        if (value.get(-1) !== COSE_CRV_P256) throw new CoseError('ES256 公鑰的曲線不是 P-256');
        // createPublicKey 會檢查點在曲線上。
        key = createPublicKey({
            key: { kty: 'EC', crv: 'P-256', x: bytesOf(value, -2).toString('base64url'), y: bytesOf(value, -3).toString('base64url') },
            format: 'jwk',
        });
    } else if (kty === COSE_KTY_RSA && alg === COSE_ALG_RS256) {
        key = createPublicKey({
            key: { kty: 'RSA', n: bytesOf(value, -1).toString('base64url'), e: bytesOf(value, -2).toString('base64url') },
            format: 'jwk',
        });
    } else {
        throw new CoseError(`不支援的公鑰：kty=${String(kty)} alg=${String(alg)}`);
    }
    return {
        alg,
        key,
        spkiDer: key.export({ type: 'spki', format: 'der' }),
        pem: key.export({ type: 'spki', format: 'pem' }).toString(),
    };
}
