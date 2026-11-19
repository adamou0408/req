// 通行金鑰與簽署證據的保存（記憶體內）。
// 每一筆都完整保留「拿到的原始資料」，可以匯出成 JSON，交給資料庫用同一份資料再驗一次。
// 所有二進位值都是 base64url（無 padding），與資料庫那邊的約定相同。

export interface StoredCredential {
    credentialId: string;
    userKey: string;
    userUid: string;
    alg: number;
    publicKeyCose: string;
    publicKeySpki: string;
    publicKeyPem: string;
    signCount: number;
    createdAt: string;
    registration: {
        challengeId: string;
        challenge: string;
        clientDataJSON: string;
        attestationObject: string;
        attestationFormat: string;
        aaguid: string;
        flags: number;
        transports: string[];
    };
}

export interface AssertionEvidence {
    recordedAt: string;
    userKey: string;
    rpId: string;
    origin: string;
    challengeId: string;
    /** 伺服器發出、預期被簽的挑戰值（取不到時為 null，例如挑戰值不存在或已用過）。 */
    expectedChallenge: string | null;
    binding: Record<string, unknown> | null;
    credentialId: string;
    /** 驗證當下用的公鑰（三種形式）；找不到憑證時為 null。 */
    publicKey: { alg: number; cose: string; spki: string; pem: string } | null;
    storedSignCountBefore: number | null;
    authenticatorData: string;
    clientDataJSON: string;
    signature: string;
    userHandle: string | null;
    result: { ok: true; signCount: number } | { ok: false; code: string; message: string };
}

export class CredentialStore {
    private readonly credentials = new Map<string, StoredCredential>();
    private readonly evidence: AssertionEvidence[] = [];

    add(credential: StoredCredential): void {
        if (this.credentials.has(credential.credentialId)) throw new Error('這把通行金鑰已經註冊過');
        this.credentials.set(credential.credentialId, credential);
    }

    get(credentialId: string): StoredCredential | undefined {
        return this.credentials.get(credentialId);
    }

    forUser(userKey: string): StoredCredential[] {
        return [...this.credentials.values()].filter((credential) => credential.userKey === userKey);
    }

    updateSignCount(credentialId: string, signCount: number): void {
        const credential = this.credentials.get(credentialId);
        if (credential) credential.signCount = signCount;
    }

    record(evidence: AssertionEvidence): void {
        this.evidence.push(evidence);
    }

    exportFor(userKey: string): { credentials: StoredCredential[]; assertions: AssertionEvidence[] } {
        return {
            credentials: this.forUser(userKey),
            assertions: this.evidence.filter((item) => item.userKey === userKey),
        };
    }
}
