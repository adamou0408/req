// 軟體版的 WebAuthn 驗證器（只在測試）：產生 P-256 金鑰，依 WebAuthn 規格組出
// authenticatorData 與 clientDataJSON，以 DER 格式的 ES256 簽章。和瀏覽器產生的格式相同；
// 真實瀏覽器的版本見 test/80-browser-passkey.test.mjs。
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { lowS } from '../../../../web/lib/signing.js';

const sha256 = (data) => createHash('sha256').update(data).digest();

export class SoftAuthenticator {
    constructor({ rpId, origin, zeroCounter = false, privateKeyPkcs8 = null, credentialId = null, counterFrom = null }) {
        if (privateKeyPkcs8) {
            this.privateKey = createPrivateKey({ key: Buffer.from(privateKeyPkcs8, 'base64'), format: 'der', type: 'pkcs8' });
        } else {
            this.privateKey = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
        }
        this.spki = createPublicKey(this.privateKey).export({ format: 'der', type: 'spki' });
        this.credentialId = credentialId ? Buffer.from(credentialId, 'base64url') : randomBytes(16);
        // 跨行程共用的金鑰（登記人）：計數器取時間，讓不同行程依序使用時仍然遞增。
        this.counterFrom = counterFrom;
        this.rpId = rpId;
        this.origin = origin;
        this.counter = 0;
        // 同步型通行金鑰（iCloud、Google）的計數器恆為 0，不能靠計數器擋重放。
        this.zeroCounter = zeroCounter;
    }

    /** 匯出成可以在另一個行程還原的形式（只在測試：私鑰明文）。 */
    toJSON() {
        return {
            privateKeyPkcs8: this.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
            credentialId: this.credentialIdB64,
        };
    }

    get credentialIdB64() {
        return this.credentialId.toString('base64url');
    }

    get spkiB64() {
        return this.spki.toString('base64url');
    }

    /** challenge：要簽的挑戰值（base64url；由扮演瀏覽器的測試程式從畫面內容算出，web/lib/signing.js）。flags 預設 UP|UV。 */
    assert(challenge, { flags = 0x05, origin = this.origin, rpId = this.rpId, type = 'webauthn.get' } = {}) {
        if (this.counterFrom) this.counter = Math.max(this.counter + 1, this.counterFrom());
        else if (!this.zeroCounter) this.counter += 1;
        const counter = Buffer.alloc(4);
        counter.writeUInt32BE(this.counter);
        const authenticatorData = Buffer.concat([sha256(rpId), Buffer.from([flags]), counter]);
        const clientDataJSON = Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
        // 瀏覽器端送出前換成 low-s（web/webauthn.js）；這裡扮演瀏覽器加驗證器，做同一件事。
        const signature = Buffer.from(lowS(sign('sha256', Buffer.concat([authenticatorData, sha256(clientDataJSON)]), this.privateKey)));
        return {
            credentialId: this.credentialIdB64,
            authenticatorData: authenticatorData.toString('base64url'),
            clientDataJSON: clientDataJSON.toString('base64url'),
            signature: signature.toString('base64url'),
        };
    }
}
