// 通行金鑰登記的 QR 碼（裁決 D76：背書人的裝置掃新裝置畫面上的 QR 碼，取得完整指紋）。頁面用自己寫的產生器
// （web/lib/qr.js，沒有加套件），這裡和參考實作 segno 產生的矩陣逐格比對（fixtures/qr-segno.json 記了產生方式），
// 並確認端對端測試用來扮演相機的讀取器（e2e/tests/lib/qr-read.mjs）讀得回同一個指紋。
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fingerprintFromPayload, fingerprintPayload, qrMatrix } from '../../../web/lib/qr.js';
import { readQr } from '../../../e2e/tests/lib/qr-read.mjs';

const reference = JSON.parse(readFileSync(new URL('./fixtures/qr-segno.json', import.meta.url), 'utf8'));
const rows = (m) => m.map((r) => r.map((on) => (on ? '1' : '0')).join(''));

test('K-PASSKEY-ENROLL QR 碼：頁面產生的矩陣和參考實作（segno）逐格相同；掃到的文字還原成同一個完整指紋，其他格式一律不收', () => {
    assert.ok(reference.vectors.length >= 8);
    for (const v of reference.vectors) {
        const matrix = qrMatrix(fingerprintPayload(v.fingerprint), v.mask);
        assert.deepEqual(rows(matrix), v.matrix, `${v.fingerprint} mask ${v.mask}`);
        assert.equal(fingerprintFromPayload(readQr(v.matrix.map((r) => [...r].map((c) => c === '1')))), v.fingerprint);
    }
    // 自動選的遮罩（扣分最少）：任何指紋都讀得回來
    for (let i = 0; i < 20; i++) {
        const fp = randomBytes(32).toString('hex');
        assert.equal(fingerprintFromPayload(readQr(qrMatrix(fingerprintPayload(fp)))), fp);
    }
    for (const bad of ['', 'SGN:', `SGN:${'A'.repeat(63)}`, `SGN:${'G'.repeat(64)}`, `XYZ:${'A'.repeat(64)}`, null])
        assert.equal(fingerprintFromPayload(bad), null, String(bad));
    assert.throws(() => qrMatrix('lowercase'), RangeError);
});
