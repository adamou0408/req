// 離線重驗 probe/docs/webauthn-vectors.json：同一份資料用 Node 端的驗證器與「只用 PEM + OpenSSL」各驗一次，
// 結果必須和檔案裡的 expected 相同。資料庫那邊拿同一份檔案驗，應得到相同的成敗。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { verifyAssertion, WebAuthnError } from '../../api/src/frontdoor/webauthn/verify.ts';

interface Vector {
    name: string;
    expectedChallenge: string;
    storedSignCountBefore: number;
    authenticatorData: string;
    clientDataJSON: string;
    signature: string;
    expected: { ok: boolean; code?: string };
}

const file = JSON.parse(readFileSync(new URL('../../docs/webauthn-vectors.json', import.meta.url), 'utf8')) as {
    rpId: string;
    origin: string;
    credential: { publicKeyCose: string; publicKeyPem: string };
    vectors: Vector[];
};
const bytes = (b64: string) => Buffer.from(b64, 'base64url');

function runNodeVerifier(v: Vector): { ok: boolean; code?: string } {
    try {
        verifyAssertion(
            { authenticatorData: bytes(v.authenticatorData), clientDataJSON: bytes(v.clientDataJSON), signature: bytes(v.signature) },
            bytes(file.credential.publicKeyCose),
            v.storedSignCountBefore,
            { challenge: bytes(v.expectedChallenge), origin: file.origin, rpId: file.rpId, requireUserVerification: true },
        );
        return { ok: true };
    } catch (error) {
        if (error instanceof WebAuthnError) return { ok: false, code: error.code };
        throw error;
    }
}

describe('測試向量', () => {
    it('四組都在', () => {
        assert.deepEqual(
            file.vectors.map((v) => v.name),
            ['valid', 'tampered-signature', 'tampered-clientDataJSON', 'replay-other-challenge'],
        );
    });

    for (const v of file.vectors) {
        it(`${v.name}：Node 驗證器的結果與 expected 相同`, () => {
            const result = runNodeVerifier(v);
            assert.equal(result.ok, v.expected.ok);
            if (!v.expected.ok) assert.equal(result.code, v.expected.code);
        });

        it(`${v.name}：只用 PEM 公鑰驗原始簽章（不經 COSE 解析）`, () => {
            const signed = Buffer.concat([bytes(v.authenticatorData), createHash('sha256').update(bytes(v.clientDataJSON)).digest()]);
            const signatureValid = verify('sha256', signed, { key: file.credential.publicKeyPem, dsaEncoding: 'der' }, bytes(v.signature));
            // 重放那組的簽章本身是有效的：擋下它的是挑戰值不符，不是簽章。
            const expectSignatureValid = v.name === 'valid' || v.name === 'replay-other-challenge';
            assert.equal(signatureValid, expectSignatureValid);
        });
    }
});
