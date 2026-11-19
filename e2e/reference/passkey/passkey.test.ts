// 通行金鑰在 Node 端驗證的端對端測試（資料庫驗證的對照組）。
// 真的 Chromium + CDP 虛擬驗證器（ctap2、內建、要求 UV），390px 寬。
// 跑完會把真實的簽署資料寫到 .run/webauthn-vectors.json（執行期檔案）；資料庫測試用的是凍結在 db/tests/kernel/fixtures/ 的一份。
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';
import { startRp, type RunningRp } from './rp-server.ts';
import { userKeyOf } from './src/webauthn/service.ts';
import type { AssertionEvidence } from './src/webauthn/store.ts';

const RUN_DIR = new URL('../../../.run/', import.meta.url);
const VECTORS_FILE = new URL('webauthn-vectors.json', RUN_DIR);

type Assertion = { challengeId: string; id: string; response: Record<string, string | null> };
type VerifyResult = { ok: boolean; code?: string; signCount?: number };

let rp: RunningRp;
let browser: Browser;
let page: Page;
const picked: Record<string, AssertionEvidence> = {};

const sign = (binding: Record<string, unknown>) =>
    page.evaluate((b) => (window as never as { probe: { sign(b: unknown): Promise<Assertion> } }).probe.sign(b), binding);
const submit = (assertion: Assertion) =>
    page.evaluate((a) => (window as never as { probe: { submit(a: unknown): Promise<VerifyResult> } }).probe.submit(a), assertion);
function required<T>(value: T | null | undefined, what: string): T {
    if (value === undefined || value === null) throw new Error(`缺少 ${what}`);
    return value;
}
const lastEvidence = (): AssertionEvidence => required(rp.service.store.exportFor(userKeyOf(rp.user)).assertions.at(-1), '證據紀錄');

function flipLastByte(b64: string): string {
    const bytes = Buffer.from(b64, 'base64url');
    bytes[bytes.length - 1] ^= 0x01;
    return bytes.toString('base64url');
}

before(async () => {
    rp = await startRp();
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: {
            protocol: 'ctap2',
            transport: 'internal',
            hasResidentKey: true,
            hasUserVerification: true,
            isUserVerified: true,
            automaticPresenceSimulation: true,
        },
    });
    await page.goto(rp.origin);
});

after(async () => {
    await browser?.close();
    await rp?.close();
});

describe('通行金鑰（Node 端驗證）', () => {
    it('390px 寬沒有水平捲動', async () => {
        const width = await page.evaluate(() => document.documentElement.scrollWidth);
        assert.ok(width <= 390, `scrollWidth=${width}`);
    });

    it('註冊：保存 COSE 與 SPKI 公鑰', async () => {
        await page.tap('#register');
        await page.locator('#result', { hasText: '已註冊通行金鑰' }).waitFor();
        const [credential] = rp.service.store.forUser(userKeyOf(rp.user));
        assert.equal(credential.alg, -7);
        assert.match(credential.publicKeyPem, /BEGIN PUBLIC KEY/);
        assert.equal(credential.registration.attestationFormat, 'none');
    });

    it('按「用通行金鑰確認」：一次點擊後驗證通過，並記下步數', async () => {
        const started = performance.now();
        await page.tap('#confirm'); // 使用者的第 1 步；驗證器的生物辨識由虛擬驗證器自動通過（實機上是第 2 步）
        await page.locator('#result', { hasText: '驗證通過' }).waitFor();
        const evidence = lastEvidence();
        assert.equal(evidence.result.ok, true);
        console.log(`# 確認流程：頁面操作 1 次 + 驗證器 UV 1 次；耗時 ${Math.round(performance.now() - started)} ms（虛擬驗證器）`);
        picked.valid = evidence;
    });

    it('竄改 signature 會失敗', async () => {
        const assertion = await sign({ case: 'tamper-signature' });
        assertion.response.signature = flipLastByte(required(assertion.response.signature, 'signature'));
        const result = await submit(assertion);
        assert.equal(result.ok, false);
        assert.equal(result.code, 'SIGNATURE_INVALID');
        picked.tamperedSignature = lastEvidence();
    });

    it('竄改 clientDataJSON（語意不變、只多一個空白）也會失敗', async () => {
        const assertion = await sign({ case: 'tamper-client-data' });
        const text = Buffer.from(required(assertion.response.clientDataJSON, 'clientDataJSON'), 'base64url').toString('utf8');
        const tampered = text.replace('"type":"webauthn.get"', '"type": "webauthn.get"');
        assert.notEqual(tampered, text);
        assertion.response.clientDataJSON = Buffer.from(tampered).toString('base64url');
        const result = await submit(assertion);
        assert.equal(result.code, 'SIGNATURE_INVALID');
        picked.tamperedClientData = lastEvidence();
    });

    it('重放：用 A 挑戰值的簽署結果配 B 挑戰值會失敗；再送一次 A 也會失敗', async () => {
        const first = await sign({ case: 'replay-A' });
        assert.equal((await submit(first)).ok, true);
        const other = await page.evaluate(() =>
            fetch('/confirm/options', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: '{"binding":{"case":"replay-B"}}',
            }).then((r) => r.json()),
        );
        const replayed = await submit({ ...first, challengeId: other.challengeId });
        assert.equal(replayed.code, 'CHALLENGE_MISMATCH');
        picked.replayOtherChallenge = lastEvidence();
        const again = await submit(first);
        assert.equal(again.code, 'CHALLENGE_UNKNOWN');
    });

    it('匯出測試向量', () => {
        const [credential] = rp.service.store.forUser(userKeyOf(rp.user));
        const vector = (name: string, description: string, e: AssertionEvidence) => ({
            name,
            description,
            expectedChallenge: e.expectedChallenge,
            binding: e.binding,
            storedSignCountBefore: e.storedSignCountBefore,
            credentialId: e.credentialId,
            authenticatorData: e.authenticatorData,
            clientDataJSON: e.clientDataJSON,
            clientDataJSONText: Buffer.from(e.clientDataJSON, 'base64url').toString('utf8'),
            clientDataHash: createHash('sha256').update(Buffer.from(e.clientDataJSON, 'base64url')).digest('base64url'),
            signature: e.signature,
            expected: e.result.ok ? { ok: true, signCount: e.result.signCount } : { ok: false, code: e.result.code },
        });
        const file = {
            description:
                '真實 Chromium（CDP 虛擬驗證器，ctap2/internal/UV）產生的 WebAuthn 簽署資料。由 e2e/reference/passkey/passkey.test.ts 自動產生，請勿手改。二進位值皆為 base64url（無 padding）。被簽的資料＝authenticatorData || SHA-256(clientDataJSON)；ES256 簽章為 DER。',
            generatedAt: new Date().toISOString(),
            rpId: 'localhost',
            origin: rp.origin,
            requireUserVerification: true,
            credential: {
                credentialId: credential.credentialId,
                alg: credential.alg,
                publicKeyCose: credential.publicKeyCose,
                publicKeySpki: credential.publicKeySpki,
                publicKeyPem: credential.publicKeyPem,
                registration: credential.registration,
            },
            vectors: [
                vector('valid', '有效的簽署', picked.valid),
                vector('tampered-signature', 'signature 最後一個 byte 被翻轉', picked.tamperedSignature),
                vector(
                    'tampered-clientDataJSON',
                    'clientDataJSON 的 type 後多一個空白（JSON 語意相同，bytes 不同）',
                    picked.tamperedClientData,
                ),
                vector(
                    'replay-other-challenge',
                    '對挑戰值 A 的有效簽署，拿來回應挑戰值 B（expectedChallenge 是 B）',
                    picked.replayOtherChallenge,
                ),
            ],
        };
        mkdirSync(RUN_DIR, { recursive: true });
        writeFileSync(VECTORS_FILE, `${JSON.stringify(file, null, 2)}\n`);
    });
});
