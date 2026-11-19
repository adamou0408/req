// 通行金鑰的流程：發 options（含挑戰值）→ 驗證瀏覽器送回的結果 → 保存公鑰或證據。
// 瀏覽器與後端之間的二進位值一律是 base64url 字串。
import { createHash } from 'node:crypto';
import { ChallengeError, ChallengeRegistry, type IssuedChallenge } from './challenge.ts';
import { COSE_ALG_ES256, COSE_ALG_RS256 } from './cose.ts';
import { CredentialStore, type AssertionEvidence, type StoredCredential } from './store.ts';
import { verifyAssertion, verifyRegistration, WebAuthnError, type Expectation } from './verify.ts';
import type { SessionUser } from '../session.ts';

export interface RelyingParty {
    rpId: string;
    rpName: string;
    origin: string;
}

export interface RegistrationResponse {
    challengeId: string;
    id: string;
    response: { clientDataJSON: string; attestationObject: string; transports?: string[] };
}

export interface AssertionResponse {
    challengeId: string;
    id: string;
    response: { authenticatorData: string; clientDataJSON: string; signature: string; userHandle?: string | null };
}

export const userKeyOf = (user: SessionUser): string => `${user.iss}|${user.sub}`;
const b64 = (data: Buffer): string => data.toString('base64url');
const fromB64 = (text: unknown, field: string): Buffer => {
    if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text)) throw new WebAuthnError('REQUEST_MALFORMED', `${field} 不是 base64url`);
    return Buffer.from(text, 'base64url');
};
/** WebAuthn 的 user.id 不放個資：用穩定識別的雜湊。 */
const userHandleOf = (userKey: string): string => b64(createHash('sha256').update(userKey).digest().subarray(0, 16));
const TIMEOUT_MS = 120_000;

export class PasskeyService {
    readonly challenges: ChallengeRegistry;
    readonly store: CredentialStore;
    private readonly rp: RelyingParty;

    constructor(rp: RelyingParty, challenges: ChallengeRegistry, store: CredentialStore) {
        this.rp = rp;
        this.challenges = challenges;
        this.store = store;
    }

    private expectation(issued: IssuedChallenge): Expectation {
        return { challenge: issued.challenge, origin: this.rp.origin, rpId: this.rp.rpId, requireUserVerification: true };
    }

    async registrationOptions(user: SessionUser) {
        const userKey = userKeyOf(user);
        const issued = await this.challenges.issue({ purpose: 'register', userKey });
        return {
            challengeId: issued.challengeId,
            publicKey: {
                rp: { id: this.rp.rpId, name: this.rp.rpName },
                user: { id: userHandleOf(userKey), name: user.email || user.uid, displayName: user.name },
                challenge: b64(issued.challenge),
                pubKeyCredParams: [
                    { type: 'public-key', alg: COSE_ALG_ES256 },
                    { type: 'public-key', alg: COSE_ALG_RS256 },
                ],
                timeout: TIMEOUT_MS,
                attestation: 'none',
                authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
                excludeCredentials: this.store.forUser(userKey).map((c) => ({ type: 'public-key', id: c.credentialId })),
            },
        };
    }

    async finishRegistration(user: SessionUser, body: RegistrationResponse): Promise<StoredCredential> {
        const userKey = userKeyOf(user);
        const issued = takeChallenge(this.challenges, body.challengeId, 'register', userKey);
        const clientDataJSON = fromB64(body.response?.clientDataJSON, 'clientDataJSON');
        const attestationObject = fromB64(body.response?.attestationObject, 'attestationObject');
        const result = verifyRegistration(clientDataJSON, attestationObject, this.expectation(issued));
        const credentialId = b64(result.credentialId);
        if (body.id !== credentialId) throw new WebAuthnError('CREDENTIAL_ID_MISMATCH', '送來的 id 與公鑰資料裡的不同');
        const credential: StoredCredential = {
            credentialId,
            userKey,
            userUid: user.uid,
            alg: result.publicKey.alg,
            publicKeyCose: b64(result.publicKeyCose),
            publicKeySpki: b64(result.publicKey.spkiDer),
            publicKeyPem: result.publicKey.pem,
            signCount: result.signCount,
            createdAt: new Date().toISOString(),
            registration: {
                challengeId: issued.challengeId,
                challenge: b64(issued.challenge),
                clientDataJSON: b64(clientDataJSON),
                attestationObject: b64(attestationObject),
                attestationFormat: result.attestationFormat,
                aaguid: b64(result.aaguid),
                flags: result.flags,
                transports: body.response.transports ?? [],
            },
        };
        this.store.add(credential);
        return credential;
    }

    /** binding 是呼叫端想讓這次確認綁定的內容；這裡只原樣交給挑戰值產生器。 */
    async confirmationOptions(user: SessionUser, binding: Record<string, unknown>) {
        const userKey = userKeyOf(user);
        const credentials = this.store.forUser(userKey);
        if (credentials.length === 0) throw new WebAuthnError('NO_PASSKEY', '還沒有註冊通行金鑰');
        const issued = await this.challenges.issue({ purpose: 'confirm', userKey, binding });
        return {
            challengeId: issued.challengeId,
            binding: issued.binding,
            publicKey: {
                challenge: b64(issued.challenge),
                rpId: this.rp.rpId,
                timeout: TIMEOUT_MS,
                userVerification: 'required',
                allowCredentials: credentials.map((c) => ({ type: 'public-key', id: c.credentialId, transports: c.registration.transports })),
            },
        };
    }

    /** 驗證簽署結果。不論成敗都把原始資料記成證據。 */
    async finishConfirmation(user: SessionUser, body: AssertionResponse): Promise<AssertionEvidence> {
        const userKey = userKeyOf(user);
        const evidence = this.startEvidence(userKey, body);
        try {
            const issued = takeChallenge(this.challenges, body.challengeId, 'confirm', userKey);
            evidence.expectedChallenge = b64(issued.challenge);
            evidence.binding = issued.binding;
            const credential = this.store.get(body.id);
            if (!credential || credential.userKey !== userKey) throw new WebAuthnError('PASSKEY_UNKNOWN', '這把通行金鑰沒有註冊在這位使用者名下');
            evidence.publicKey = { alg: credential.alg, cose: credential.publicKeyCose, spki: credential.publicKeySpki, pem: credential.publicKeyPem };
            evidence.storedSignCountBefore = credential.signCount;
            const input = {
                authenticatorData: fromB64(body.response?.authenticatorData, 'authenticatorData'),
                clientDataJSON: fromB64(body.response?.clientDataJSON, 'clientDataJSON'),
                signature: fromB64(body.response?.signature, 'signature'),
            };
            const result = verifyAssertion(input, Buffer.from(credential.publicKeyCose, 'base64url'), credential.signCount, this.expectation(issued));
            this.store.updateSignCount(credential.credentialId, result.signCount);
            evidence.result = { ok: true, signCount: result.signCount };
        } catch (error) {
            if (!(error instanceof WebAuthnError || error instanceof ChallengeError)) throw error;
            evidence.result = { ok: false, code: error.code, message: error.message };
        }
        this.store.record(evidence);
        return evidence;
    }

    private startEvidence(userKey: string, body: AssertionResponse): AssertionEvidence {
        const raw = (value: unknown): string => (typeof value === 'string' ? value : '');
        return {
            recordedAt: new Date().toISOString(),
            userKey,
            rpId: this.rp.rpId,
            origin: this.rp.origin,
            challengeId: raw(body.challengeId),
            expectedChallenge: null,
            binding: null,
            credentialId: raw(body.id),
            publicKey: null,
            storedSignCountBefore: null,
            authenticatorData: raw(body.response?.authenticatorData),
            clientDataJSON: raw(body.response?.clientDataJSON),
            signature: raw(body.response?.signature),
            userHandle: typeof body.response?.userHandle === 'string' ? body.response.userHandle : null,
            result: { ok: false, code: 'NOT_VERIFIED', message: '尚未驗證' },
        };
    }
}

function takeChallenge(registry: ChallengeRegistry, challengeId: unknown, purpose: 'register' | 'confirm', userKey: string): IssuedChallenge {
    if (typeof challengeId !== 'string') throw new ChallengeError('CHALLENGE_UNKNOWN', '缺少 challengeId');
    return registry.take(challengeId, purpose, userKey);
}
