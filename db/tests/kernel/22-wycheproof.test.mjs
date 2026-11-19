// 純 PL/pgSQL 的 ES256 以業界標準測試資料驗：Google Wycheproof 的 ECDSA P-256 / SHA-256 向量，全部都跑。
// 來源：Go 模組代理 github.com/google/wycheproof@v0.0.0-20261111220454-65ca494727a5（go mod download），
//   testvectors_v1/ecdsa_secp256r1_sha256_test.json（DER 簽章，484 個；WebAuthn 用這種格式，走正式路徑的 es256_verify）
//   testvectors_v1/ecdsa_secp256r1_sha256_p1363_test.json（r||s 簽章，262 個；資料庫沒有 P1363 的解析，
//   長度不是 64 bytes 的由測試這邊判為無效，其餘直接交給驗章核心 p256_verify_digest）
// 授權：Apache License 2.0（fixtures/wycheproof/LICENSE）。檔案未修改；sha256 見 docs/handoff/promote.md。
// 判定：valid 必須驗過、invalid 必須驗不過；這一版的兩個檔案沒有 acceptable，若之後更新出現 acceptable，測試會失敗，
// 要逐項決定處理方式（不自動當成 valid 或 invalid）。
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { RUN_DIR } from '../../tools/lib/env.mjs';
import { closePools, pool } from './lib/harness.mjs';

const admin = pool('ADMIN');
const summary = {};
after(async () => {
    mkdirSync(RUN_DIR, { recursive: true });
    writeFileSync(join(RUN_DIR, 'wycheproof-results.json'), `${JSON.stringify(summary, null, 2)}\n`);
    await closePools();
});

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/wycheproof/${name}`, import.meta.url), 'utf8'));

function flatten(file) {
    return file.testGroups.flatMap((group) =>
        group.tests.map((t) => ({
            tcId: t.tcId,
            comment: t.comment,
            flags: t.flags,
            result: t.result,
            msg: t.msg,
            sig: t.sig,
            pk: group.publicKey.uncompressed,
            spki: group.publicKeyDer,
        })),
    );
}

function compare(name, cases, verdicts) {
    const counts = { valid: 0, invalid: 0, acceptable: 0 };
    const mismatches = [];
    cases.forEach((c, i) => {
        counts[c.result] += 1;
        if (verdicts[i] !== (c.result === 'valid'))
            mismatches.push({ tcId: c.tcId, comment: c.comment, expected: c.result, got: verdicts[i] });
    });
    summary[name] = { total: cases.length, ...counts, mismatches: mismatches.length };
    assert.equal(counts.acceptable, 0, 'acceptable 類別出現了：要逐項決定處理方式');
    assert.deepEqual(mismatches, []);
    return counts;
}

test('Wycheproof ECDSA P-256 SHA-256（DER）：484 個向量，es256_verify 的結果與 valid／invalid 全部一致', async () => {
    const file = load('ecdsa_secp256r1_sha256_test.json');
    const cases = flatten(file);
    assert.equal(cases.length, file.numberOfTests);
    const { rows } = await admin.query(
        `select sgn_internal.es256_verify(decode(c ->> 'msg', 'hex'), decode(c ->> 'sig', 'hex'), decode(c ->> 'pk', 'hex')) as ok,
                sgn_internal.p256_spki_to_point(decode(c ->> 'spki', 'hex')) = decode(c ->> 'pk', 'hex') as spki_ok
         from jsonb_array_elements($1::jsonb) with ordinality as e (c, ord) order by e.ord`,
        [JSON.stringify(cases)],
    );
    // 每一組的公開金鑰也用 SPKI 解析一次（通行金鑰登記時走這條）
    assert.ok(
        rows.every((r) => r.spki_ok),
        'SPKI 解析出的公鑰和向量的未壓縮公鑰不同',
    );
    const counts = compare(
        'der',
        cases,
        rows.map((r) => r.ok),
    );
    assert.deepEqual(counts, { valid: 174, invalid: 310, acceptable: 0 });
});

test('Wycheproof ECDSA P-256 SHA-256（P1363 r||s）：262 個向量，驗章核心 p256_verify_digest 的結果與 valid／invalid 全部一致', async () => {
    const file = load('ecdsa_secp256r1_sha256_p1363_test.json');
    const cases = flatten(file);
    assert.equal(cases.length, file.numberOfTests);
    const wellFormed = cases.filter((c) => c.sig.length === 128);
    const { rows } = await admin.query(
        `select sgn_internal.p256_verify_digest(
                    sha256(decode(c ->> 'msg', 'hex')),
                    sgn_internal.bytes_to_int(substring(decode(c ->> 'sig', 'hex') from 1 for 32)),
                    sgn_internal.bytes_to_int(substring(decode(c ->> 'sig', 'hex') from 33 for 32)),
                    sgn_internal.bytes_to_int(substring(decode(c ->> 'pk', 'hex') from 2 for 32)),
                    sgn_internal.bytes_to_int(substring(decode(c ->> 'pk', 'hex') from 34 for 32))
                ) as ok
         from jsonb_array_elements($1::jsonb) with ordinality as e (c, ord) order by e.ord`,
        [JSON.stringify(wellFormed)],
    );
    const byId = new Map(wellFormed.map((c, i) => [c.tcId, rows[i].ok]));
    const counts = compare(
        'p1363',
        cases,
        cases.map((c) => byId.get(c.tcId) ?? false),
    );
    summary.p1363.rejected_by_length_in_test = cases.length - wellFormed.length;
    assert.deepEqual(counts, { valid: 173, invalid: 89, acceptable: 0 });
});
