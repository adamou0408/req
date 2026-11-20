// 瀏覽器的 WebAuthn 呼叫。二進位值與後端之間一律用 base64url（無 padding）。
import { lowS } from './lib/signing.js';

export const b64url = (buf) =>
    btoa(String.fromCharCode(...new Uint8Array(buf)))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replace(/=+$/, '');
export const unb64url = (s) => Uint8Array.from(atob(s.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0));

const uuidBytes = (uuid) => Uint8Array.from(uuid.replaceAll('-', '').match(/../g), (h) => parseInt(h, 16));

/** 建立通行金鑰。這一步的 challenge 不驗（attestation 為 none）；誰的金鑰由身分提供者再驗證與背書決定（D65）。 */
export async function createPasskey(me) {
    const cred = await navigator.credentials.create({
        publicKey: {
            challenge: crypto.getRandomValues(new Uint8Array(32)),
            rp: { id: location.hostname, name: '資料授權簽核' },
            user: { id: uuidBytes(me.person_id), name: me.name, displayName: me.name },
            pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
            authenticatorSelection: { userVerification: 'required', residentKey: 'required' },
            attestation: 'none',
        },
    });
    return { credentialId: b64url(cred.rawId), spki: b64url(cred.response.getPublicKey()) };
}

/**
 * 用通行金鑰簽這個頁面自己算出的挑戰值（32 bytes，web/lib/signing.js；不是後端給的值）。
 * 簽章送出前換成 low-s（D71：資料庫只收 low-s，同一個決定的證明只有一種位元表示）。
 */
export async function signChallenge(challenge) {
    const got = await navigator.credentials.get({
        publicKey: { challenge, rpId: location.hostname, userVerification: 'required', timeout: 60000 },
    });
    return {
        credentialId: b64url(got.rawId),
        authenticatorData: b64url(got.response.authenticatorData),
        clientDataJSON: b64url(got.response.clientDataJSON),
        signature: b64url(lowS(new Uint8Array(got.response.signature))),
    };
}
