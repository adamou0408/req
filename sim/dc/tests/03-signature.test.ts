// 規則來源：沒簽章、簽章錯、金鑰不受信任、內容被改過的規則都被拒絕，而且資料庫完全沒有變動。
// 呼叫方：沒有金鑰、金鑰錯、沒有權限的呼叫方被拒絕。
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
    call,
    envelope,
    example1,
    KEYS,
    platformPrivateKey,
    signed,
    sql,
    startServer,
    stopServer,
    TEST_KEY_ID,
    untrustedKey,
} from './harness.ts';

const PRINCIPAL = '0b9f6c3e-0000-4000-8000-00000000000c';
const ROLE = 'simdc_t_p_0b9f6c3e00004000800000000000000c';
const path = '/v1/rule-sets/DA-2026-0300';
const body = envelope('PUT', path, example1(PRINCIPAL, 'DA-2026-0300'));

async function nothingApplied(): Promise<void> {
    assert.equal((await sql('select 1 from pg_roles where rolname = $1', [ROLE])).length, 0);
    assert.equal((await sql(`select 1 from simdc_meta.rule_set where case_no = 'DA-2026-0300'`)).length, 0);
}

before(startServer);
after(stopServer);

test('沒有簽章 → 401', async () => {
    const r = await call('PUT', path, { body });
    assert.equal(r.status, 401);
    assert.equal(r.body['code'], 'signature_invalid');
    await nothingApplied();
});

test('不受信任的金鑰簽的 → 401', async () => {
    assert.equal((await call('PUT', path, { body, headers: signed(body, untrustedKey) })).status, 401);
    // 冒用受信任的金鑰代號也一樣
    assert.equal((await call('PUT', path, { body, headers: signed(body, untrustedKey, TEST_KEY_ID) })).status, 401);
    assert.equal((await call('PUT', path, { body, headers: signed(body, platformPrivateKey(), 'unknown-key') })).status, 401);
    await nothingApplied();
});

test('簽章之後內容被改過 → 401', async () => {
    const headers = signed(body);
    const tampered = body.replace('"export":false', '"export":true');
    assert.notEqual(tampered, body);
    assert.equal((await call('PUT', path, { body: tampered, headers })).status, 401);
    // 只改空白（JSON 意思相同）也不行：簽的是原始位元組
    assert.equal((await call('PUT', path, { body: `${body} `, headers })).status, 401);
    await nothingApplied();
});

test('簽章格式不對 → 401', async () => {
    for (const value of ['garbage', 'keyid="test-platform", alg="rsa", sig="AAAA"', `keyid="${TEST_KEY_ID}", alg="ed25519", sig="AAAA"`]) {
        assert.equal((await call('PUT', path, { body, headers: { 'sgn-signature': value } })).status, 401, value);
    }
    await nothingApplied();
});

test('撤回也要簽章', async () => {
    assert.equal((await call('PUT', path, { body, headers: signed(body) })).status, 200);
    const w = envelope('DELETE', path, { request_id: 'w-1', case_no: 'DA-2026-0300' });
    assert.equal((await call('DELETE', path, { body: w })).status, 401);
    assert.equal((await call('DELETE', path, { body: w, headers: signed(w, untrustedKey, TEST_KEY_ID) })).status, 401);
    assert.equal((await sql('select 1 from pg_roles where rolname = $1', [ROLE])).length, 1);
    assert.equal((await call('DELETE', path, { body: w, headers: signed(w) })).status, 200);
    assert.equal((await sql('select 1 from pg_roles where rolname = $1', [ROLE])).length, 0);
});

test('路徑的單號和本文不同 → 拒絕', async () => {
    const other = envelope('PUT', '/v1/rule-sets/DA-2026-0399', example1(PRINCIPAL, 'DA-2026-0300'));
    const r = await call('PUT', '/v1/rule-sets/DA-2026-0399', { body: other, headers: signed(other) });
    assert.equal(r.status, 422);
});

test('呼叫方的驗證', async () => {
    assert.equal((await call('GET', '/v1/rule-sets', { key: null })).status, 401);
    assert.equal((await call('GET', '/v1/rule-sets', { key: 'wrong-key' })).status, 401);
    assert.equal((await call('GET', '/v1/rule-sets', { key: KEYS.auditor })).status, 200);
    // 稽核只能讀，不能套用、不能做測試查詢、不能用後門
    assert.equal((await call('PUT', path, { key: KEYS.auditor, body, headers: signed(body) })).status, 403);
    assert.equal((await call('POST', '/v1/test-query', { key: KEYS.auditor, body: '{}' })).status, 403);
    assert.equal((await call('POST', '/v1/admin/reset', { key: KEYS.platform, body: '{}' })).status, 403);
    // 管理後門的金鑰也不能套用規則
    assert.equal((await call('PUT', path, { key: KEYS.admin, body, headers: signed(body) })).status, 403);
});

test('規則結構不對 → 422（只檢查能不能執行，不做業務判斷）', async () => {
    const rs0 = example1(PRINCIPAL, 'DA-2026-0300');
    const bad = [
        { ...rs0, format: 'dc_rule_set/1' },
        { ...rs0, rules: [] },
        { ...rs0, valid: { from: '2027-01-01', to: '2026-01-01' } },
        { ...rs0, grantee: { type: 'team', principal_id: "x'; drop role postgres; --", name: 'x' } },
    ];
    for (const rs of bad) {
        const text = envelope('PUT', path, rs);
        assert.equal((await call('PUT', path, { body: text, headers: signed(text) })).status, 422, text.slice(0, 80));
    }
});
