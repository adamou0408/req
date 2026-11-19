// WebAuthn 註冊與簽署的驗證（W3C WebAuthn Level 2 §7.1、§7.2 的必要步驟）。
// 輸入、輸出都是原始 bytes；不保存任何東西，保存由 store.ts 負責。
import { createHash, verify as verifySignature } from 'node:crypto';
import { decodeCbor, type CborValue } from './cbor.ts';
import { COSE_ALG_ES256, parseCoseKey, type CosePublicKey } from './cose.ts';

export class WebAuthnError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
        super(message);
        this.code = code;
    }
}

function check(condition: unknown, code: string, message: string): asserts condition {
    if (!condition) throw new WebAuthnError(code, message);
}

const sha256 = (data: Uint8Array): Buffer => createHash('sha256').update(data).digest();

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

export interface Expectation {
    challenge: Buffer;
    origin: string;
    rpId: string;
    requireUserVerification: boolean;
}

export interface AuthenticatorData {
    rpIdHash: Buffer;
    flags: number;
    signCount: number;
    attestedCredential?: { aaguid: Buffer; credentialId: Buffer; publicKeyCose: Buffer };
}

export function parseAuthenticatorData(data: Buffer): AuthenticatorData {
    check(data.length >= 37, 'AUTH_DATA_MALFORMED', 'authenticatorData 太短');
    const parsed: AuthenticatorData = { rpIdHash: data.subarray(0, 32), flags: data[32], signCount: data.readUInt32BE(33) };
    if (parsed.flags & FLAG_AT) {
        check(data.length >= 55, 'AUTH_DATA_MALFORMED', 'attestedCredentialData 太短');
        const idLength = data.readUInt16BE(53);
        const keyStart = 55 + idLength;
        check(data.length > keyStart, 'AUTH_DATA_MALFORMED', 'attestedCredentialData 不完整');
        // 公鑰後面可能接 extensions，所以用 CBOR 解碼算出公鑰的結束位置。
        const { end } = decodeCbor(data, keyStart);
        parsed.attestedCredential = {
            aaguid: data.subarray(37, 53),
            credentialId: data.subarray(55, keyStart),
            publicKeyCose: data.subarray(keyStart, end),
        };
    }
    return parsed;
}

interface ClientData {
    type: string;
    challenge: string;
    origin: string;
    crossOrigin?: boolean;
}

function checkClientData(clientDataJSON: Buffer, type: string, expected: Expectation): void {
    let clientData: ClientData;
    try {
        clientData = JSON.parse(clientDataJSON.toString('utf8')) as ClientData;
    } catch {
        throw new WebAuthnError('CLIENT_DATA_MALFORMED', 'clientDataJSON 不是 JSON');
    }
    check(clientData.type === type, 'CLIENT_DATA_TYPE', `clientDataJSON 的 type 不是 ${type}`);
    check(clientData.challenge === expected.challenge.toString('base64url'), 'CHALLENGE_MISMATCH', '簽署的挑戰值與發出的不同');
    check(clientData.origin === expected.origin, 'ORIGIN_MISMATCH', `origin 不符：${clientData.origin}`);
    check(clientData.crossOrigin !== true, 'CROSS_ORIGIN', '不接受跨來源的 iframe 呼叫');
}

function checkAuthenticatorData(authData: AuthenticatorData, expected: Expectation): void {
    check(authData.rpIdHash.equals(sha256(Buffer.from(expected.rpId))), 'RP_ID_MISMATCH', 'rpIdHash 不符');
    check(authData.flags & FLAG_UP, 'USER_NOT_PRESENT', '驗證器沒有確認使用者在場');
    check(!expected.requireUserVerification || authData.flags & FLAG_UV, 'USER_NOT_VERIFIED', '驗證器沒有驗證使用者（生物辨識或 PIN）');
}

export interface RegistrationResult {
    credentialId: Buffer;
    publicKey: CosePublicKey;
    publicKeyCose: Buffer;
    signCount: number;
    aaguid: Buffer;
    attestationFormat: string;
    flags: number;
}

/** 驗證 navigator.credentials.create() 的結果。attestation 以 none 處理：不驗證驗證器的出身。 */
export function verifyRegistration(clientDataJSON: Buffer, attestationObject: Buffer, expected: Expectation): RegistrationResult {
    checkClientData(clientDataJSON, 'webauthn.create', expected);
    let attestation: CborValue;
    try {
        attestation = decodeCbor(attestationObject).value;
    } catch {
        throw new WebAuthnError('ATTESTATION_MALFORMED', 'attestationObject 不是 CBOR');
    }
    check(attestation instanceof Map, 'ATTESTATION_MALFORMED', 'attestationObject 不是 map');
    const fmt = attestation.get('fmt');
    const rawAuthData = attestation.get('authData');
    check(typeof fmt === 'string' && rawAuthData instanceof Uint8Array, 'ATTESTATION_MALFORMED', 'attestationObject 缺少 fmt 或 authData');
    const authData = parseAuthenticatorData(Buffer.from(rawAuthData));
    checkAuthenticatorData(authData, expected);
    const attested = authData.attestedCredential;
    check(attested, 'AUTH_DATA_MALFORMED', '註冊結果沒有公鑰');
    let publicKey: CosePublicKey;
    try {
        publicKey = parseCoseKey(attested.publicKeyCose);
    } catch (error) {
        throw new WebAuthnError('PUBLIC_KEY_UNSUPPORTED', (error as Error).message);
    }
    return {
        credentialId: Buffer.from(attested.credentialId),
        publicKey,
        publicKeyCose: Buffer.from(attested.publicKeyCose),
        signCount: authData.signCount,
        aaguid: Buffer.from(attested.aaguid),
        attestationFormat: fmt,
        flags: authData.flags,
    };
}

export interface AssertionInput {
    authenticatorData: Buffer;
    clientDataJSON: Buffer;
    signature: Buffer;
}

export interface AssertionResult {
    signCount: number;
    flags: number;
}

/** 驗證 navigator.credentials.get() 的結果。storedSignCount 是上次記下的計數器。 */
export function verifyAssertion(
    input: AssertionInput,
    publicKeyCose: Buffer,
    storedSignCount: number,
    expected: Expectation,
): AssertionResult {
    checkClientData(input.clientDataJSON, 'webauthn.get', expected);
    const authData = parseAuthenticatorData(input.authenticatorData);
    checkAuthenticatorData(authData, expected);
    const publicKey = parseCoseKey(publicKeyCose);
    // 被簽的資料是 authenticatorData || SHA-256(clientDataJSON)；ES256 的簽章是 DER 編碼。
    const signedData = Buffer.concat([input.authenticatorData, sha256(input.clientDataJSON)]);
    const valid = verifySignature(
        'sha256',
        signedData,
        publicKey.alg === COSE_ALG_ES256 ? { key: publicKey.key, dsaEncoding: 'der' } : publicKey.key,
        input.signature,
    );
    check(valid, 'SIGNATURE_INVALID', '簽章驗證失敗');
    // 計數器恆為 0 的驗證器（同步型通行金鑰）不比對；有在數的就必須遞增，倒退代表驗證器可能被複製。
    const counting = authData.signCount !== 0 || storedSignCount !== 0;
    check(!counting || authData.signCount > storedSignCount, 'COUNTER_REGRESSED', '簽章計數器沒有遞增');
    return { signCount: authData.signCount, flags: authData.flags };
}
