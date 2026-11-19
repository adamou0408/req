// 軟體版的 WebAuthn 驗證器（只在測試）：產生 P-256 金鑰，依 WebAuthn 規格組出
// authenticatorData 與 clientDataJSON，以 DER 格式的 ES256 簽章。和瀏覽器產生的格式相同；
// 真實瀏覽器的版本見 test/80-browser-passkey.test.mjs。
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

const sha256 = (data) => createHash('sha256').update(data).digest();

export class SoftAuthenticator {
    constructor({ rpId, origin, zeroCounter = false }) {
        const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
        this.privateKey = privateKey;
        this.spki = publicKey.export({ format: 'der', type: 'spki' });
        this.credentialId = randomBytes(16);
        this.rpId = rpId;
        this.origin = origin;
        this.counter = 0;
        // 同步型通行金鑰（iCloud、Google）的計數器恆為 0，不能靠計數器擋重放。
        this.zeroCounter = zeroCounter;
    }

    get credentialIdB64() {
        return this.credentialId.toString('base64url');
    }

    get spkiB64() {
        return this.spki.toString('base64url');
    }

    /** challenge：資料庫給的 base64url 字串。flags 預設 UP|UV。 */
    assert(challenge, { flags = 0x05, origin = this.origin, rpId = this.rpId, type = 'webauthn.get' } = {}) {
        if (!this.zeroCounter) this.counter += 1;
        const counter = Buffer.alloc(4);
        counter.writeUInt32BE(this.counter);
        const authenticatorData = Buffer.concat([sha256(rpId), Buffer.from([flags]), counter]);
        const clientDataJSON = Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
        const signature = sign('sha256', Buffer.concat([authenticatorData, sha256(clientDataJSON)]), this.privateKey);
        return {
            credentialId: this.credentialIdB64,
            authenticatorData: authenticatorData.toString('base64url'),
            clientDataJSON: clientDataJSON.toString('base64url'),
            signature: signature.toString('base64url'),
        };
    }
}
