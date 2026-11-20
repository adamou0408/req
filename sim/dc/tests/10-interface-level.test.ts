// 裁決 D81 (2)：外部系統交付介面的完整等級。
//   - 被簽的內容帶通道、環境、方法、路徑與期限：同一份已簽章的請求換一個環境、端點、方法或過期之後都不收
//   - 每個環境各自的信任清單：正式環境的平台金鑰在遮罩環境無效，反之亦然
//   - 每個回應都有 DC 的證明：涵蓋請求本文的摘要、平台給的一次性亂數、HTTP 狀態與結果；改過的回應驗不過
// 每個案例都是「拿掉這道防法就會失敗」的形式：例如拿掉環境比對，送到遮罩環境的請求就會被套用。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';
import { attestationValid, type Attestation } from '../src/signature.ts';
import {
    attested,
    call,
    envelope,
    example1,
    KEYS,
    MASKED_KEY_ID,
    platformPrivateKey,
    reconciliation,
    responsePublicKey,
    signed,
    sql,
    startServer,
    stopServer,
} from './harness.ts';

const PRINCIPAL = '0b9f6c3e-0000-4000-8000-000000000100';
const ROLE = 'simdc_t_p_0b9f6c3e000040008000000000000100';
const CASE = 'DA-2026-1000';
const path = `/v1/rule-sets/${CASE}`;

async function nothingApplied(caseNo = CASE): Promise<void> {
    assert.equal((await sql('select 1 from pg_roles where rolname = $1', [ROLE])).length, 0);
    assert.equal((await sql('select 1 from simdc_meta.rule_set where case_no = $1', [caseNo])).length, 0);
}

before(startServer);
after(stopServer);

test('同一份已簽章的規則送到另一個環境 → 拒絕（環境在被簽的內容裡）', async () => {
    const body = envelope('PUT', path, example1(PRINCIPAL, CASE));
    // 遮罩環境：環境不符（就算遮罩環境也信任這把金鑰）
    const masked = await call('PUT', `/masked/v1/rule-sets/${CASE}`, { body, headers: signed(body) });
    assert.equal(masked.status, 401, '遮罩環境不信任正式環境的金鑰');
    const maskedKey = signed(body, platformPrivateKey(MASKED_KEY_ID), MASKED_KEY_ID);
    const r = await call('PUT', `/masked/v1/rule-sets/${CASE}`, { body, headers: maskedKey });
    assert.equal(r.status, 409);
    assert.equal(r.body['code'], 'target_mismatch');
    assert.equal((await sql('select 1 from simdc_meta.rule_set where case_no = $1', [CASE], process.env['SIM_DC_DB_MASKED'])).length, 0);
});

test('每個環境各自的信任清單：遮罩環境的金鑰在正式環境無效', async () => {
    const body = envelope('PUT', path, example1(PRINCIPAL, CASE));
    const r = await call('PUT', path, { body, headers: signed(body, platformPrivateKey(MASKED_KEY_ID), MASKED_KEY_ID) });
    assert.equal(r.status, 401);
    await nothingApplied();
});

test('方法、路徑、通道與簽章不符 → 拒絕', async () => {
    const payload = example1(PRINCIPAL, CASE);
    for (const over of [{ method: 'DELETE' }, { path: '/rule-sets/DA-2026-1001' }, { channel: 'other' }, { environment: 'sim_dc' }]) {
        const body = envelope('PUT', path, payload, over);
        const r = await call('PUT', path, { body, headers: signed(body) });
        assert.equal(r.status, 409, JSON.stringify(over));
        assert.equal(r.body['code'], 'target_mismatch');
    }
    await nothingApplied();
});

test('過期的簽章 → 401 signature_expired', async () => {
    const body = envelope('PUT', path, example1(PRINCIPAL, CASE), { not_after: new Date(Date.now() - 1000).toISOString() });
    const r = await call('PUT', path, { body, headers: signed(body) });
    assert.equal(r.status, 401);
    assert.equal(r.body['code'], 'signature_expired');
    await nothingApplied();
});

test('不是信封的本文（舊格式：直接簽規則）→ 拒絕', async () => {
    const body = JSON.stringify(example1(PRINCIPAL, CASE));
    const r = await call('PUT', path, { body, headers: signed(body) });
    assert.equal(r.status, 422);
    assert.equal(r.body['code'], 'invalid_envelope');
    await nothingApplied();
});

test('回應的證明：涵蓋請求摘要、一次性亂數、HTTP 狀態與結果', async () => {
    const body = envelope('PUT', path, example1(PRINCIPAL, CASE));
    const nonce = 'n0nce-for-this-attempt-0001';
    const r = await call('PUT', path, { body, headers: { ...signed(body), 'sgn-nonce': nonce } });
    assert.equal(r.status, 200);
    const p = attested(r);
    assert.equal(p.nonce, nonce);
    assert.equal(p.request_sha256, createHash('sha256').update(body).digest('hex'));
    assert.equal(p.http_status, 200);
    assert.equal(p.method, 'PUT');
    assert.equal(p.path, `/rule-sets/${CASE}`);
    assert.equal(p.environment, process.env['SIM_DC_DB']);
    assert.equal(p.channel, process.env['SIM_DC_CHANNEL']);
    assert.equal(p.result['status'], 'applied');
    // 改過結果的證明驗不過（網路上的人只能擋下，不能改）
    const a = r.body['attestation'] as Attestation;
    assert.equal(attestationValid(responsePublicKey(), { ...a, payload: a.payload.replace('"applied"', '"withdrawn"') }), false);
    // 錯誤的回應也有證明
    const denied = await call('PUT', path, { body, headers: { 'sgn-nonce': nonce } });
    assert.equal(attested(denied).http_status, 401);
    assert.equal(attested(denied).result['code'], 'signature_invalid');
});

test('對帳回報的證明：結果就是完整的回報，改了可讀副本也不影響被簽的內容', async () => {
    const r = await call('GET', '/v1/reconciliation', { key: KEYS.auditor });
    const p = attested(r);
    assert.equal(p.path, '/reconciliation');
    assert.deepEqual(p.result['items'], r.body['items']);
    assert.ok((await reconciliation()).some((i) => i.properties['case_no'] === CASE));
});

test('撤回整張單 → 封存：之後送來較新的已簽章版本也不收', async () => {
    const w = envelope('DELETE', path, { request_id: 'w-1000', case_no: CASE });
    assert.equal((await call('DELETE', path, { body: w, headers: signed(w) })).status, 200);
    const v2 = { ...example1(PRINCIPAL, CASE), case_version_no: 2 };
    const body = envelope('PUT', path, v2);
    const r = await call('PUT', path, { body, headers: signed(body) });
    assert.equal(r.status, 409);
    assert.equal(r.body['code'], 'archived');
    assert.equal((await sql('select 1 from pg_roles where rolname = $1', [ROLE])).length, 0);
});
