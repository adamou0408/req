#!/usr/bin/env node
// 效能量測。量法：
// - 單次驗章：在 sgn_probe_bench 以 superuser 連線，逐次送 `select <verify>(...)`，每次用不同的金鑰與簽章，
//   以 process.hrtime 量客戶端來回時間（本機 TCP，含協定開銷；另量 `select 1` 當基準）。N = 200，先暖身 10 次。
// - 端到端決定：在 sgn_probe 以 sgn_probe_app 連線，事先建好 N 張送審中的單、挑戰值與證明，
//   只量「送出決定 → 資料庫回傳」那一個呼叫（含驗章、狀態轉移、寫證據、寫雜湊鏈、commit）。
//   (c) 量的是 HTTP 呼叫驗證服務的來回時間。
// - 併發：10 個連線同時做 (a) 共 N 次，量總時間與每次呼叫的分佈。
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { startVerifierService } from '../tools/verifier-service.mjs';
import { PROBE_DB_DIR, adminUrl } from '../tools/lib/env.mjs';
import {
    closePools, config, createSubmittedCase, decideIdp, decidePasskey, idToken, issueChallenge, login, one, pool,
    registerPasskey,
} from '../test/lib/harness.mjs';

const N = Number(process.env.BENCH_N ?? 200);
const WARMUP = 10;

function stats(samples) {
    const sorted = [...samples].sort((a, b) => a - b);
    const q = (p) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
    return { n: sorted.length, p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), max: +sorted[sorted.length - 1].toFixed(2) };
}
async function timed(fn) {
    const t = process.hrtime.bigint();
    await fn();
    return Number(process.hrtime.bigint() - t) / 1e6;
}
async function measure(count, prepare, run) {
    const inputs = [];
    for (let i = 0; i < count + WARMUP; i += 1) inputs.push(await prepare(i));
    const samples = [];
    for (let i = 0; i < inputs.length; i += 1) {
        const ms = await timed(() => run(inputs[i]));
        if (i >= WARMUP) samples.push(ms);
    }
    return stats(samples);
}

function ecVector() {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    const msg = randomBytes(64);
    return [msg, sign('sha256', msg, privateKey), Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')])];
}
const rsaKeys = Array.from({ length: 8 }, () => generateKeyPairSync('rsa', { modulusLength: 2048 }));
function rsVector(i) {
    const { privateKey, publicKey } = rsaKeys[i % rsaKeys.length];
    const jwk = publicKey.export({ format: 'jwk' });
    const msg = randomBytes(300);
    return [msg, sign('sha256', msg, privateKey), Buffer.from(jwk.n, 'base64url'), Buffer.from(jwk.e, 'base64url')];
}

async function primitiveBench() {
    const db = new pg.Client({ connectionString: adminUrl(config, config.probe.PROBE_BENCH_DB) });
    await db.connect();
    const expectTrue = async (sql, args) => {
        const { rows } = await db.query(sql, args);
        if (rows[0].ok !== true) throw new Error(`verify returned ${rows[0].ok}`);
    };
    const result = {
        baseline_select_1: await measure(N, () => null, () => db.query('select 1')),
        es256_plpgsql: await measure(N, ecVector, (v) => expectTrue('select sgn_crypto.es256_verify($1, $2, $3) as ok', v)),
        es256_plpython: await measure(N, ecVector, (v) => expectTrue('select sgn_crypto.py_es256_verify($1, $2, $3) as ok', v)),
        rs256_plpgsql: await measure(N, rsVector, (v) => expectTrue('select sgn_crypto.rs256_verify($1, $2, $3, $4) as ok', v)),
        rs256_plpython: await measure(N, rsVector, (v) => expectTrue('select sgn_crypto.py_rs256_verify($1, $2, $3, $4) as ok', v)),
    };
    await db.end();
    return result;
}

async function decisionBench() {
    const app = pool('APP');
    const applicant = await login(app, 'p04');
    const manager = await login(app, 'p03');
    const key = await registerPasskey(app, manager);
    const expectApproved = (state) => {
        if (state !== 'approved') throw new Error(`state ${state}`);
    };
    const newChallenge = async () => issueChallenge(app, manager, await createSubmittedCase(app, applicant));

    const baseline = await measure(N, async () => createSubmittedCase(app, applicant), (caseId) =>
        app.query('select api.case_get($1, $2)', [applicant.session, caseId]),
    );
    const a = await measure(N, async () => {
        const ch = await newChallenge();
        return { ch, assertion: key.assert(ch.challenge) };
    }, async ({ ch, assertion }) => expectApproved(await decidePasskey(app, ch.challenge_id, 'approve', assertion)));
    const b = await measure(N, async () => {
        const ch = await newChallenge();
        return { ch, token: await idToken('p03', ch.challenge) };
    }, async ({ ch, token }) => expectApproved(await decideIdp(app, ch.challenge_id, 'approve', token)));
    const service = await startVerifierService({ port: 0 });
    const c = await measure(N, async () => {
        const ch = await newChallenge();
        const s = key.assert(ch.challenge);
        return JSON.stringify({
            challenge_id: ch.challenge_id, decision: 'approve', credential_id: s.credentialId,
            authenticator_data: s.authenticatorData, client_data_json: s.clientDataJSON, signature: s.signature,
        });
    }, async (body) => {
        const res = await fetch(`${service.url}/decide`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
        expectApproved((await res.json()).state);
    });
    await service.close();

    // 併發：10 個連線同時核准。每個連線各用一把自己的金鑰，避免計數器互相等待。
    const workers = 10;
    const keys = [key];
    while (keys.length < workers) keys.push(await registerPasskey(app, manager));
    const jobs = [];
    for (let i = 0; i < N; i += 1) {
        const ch = await newChallenge();
        jobs.push({ ch, assertion: keys[i % workers].assert(ch.challenge) });
    }
    const samples = [];
    const started = process.hrtime.bigint();
    await Promise.all(
        Array.from({ length: workers }, async (_, w) => {
            const client = await app.connect();
            for (let i = w; i < jobs.length; i += workers) {
                const { ch, assertion } = jobs[i];
                samples.push(await timed(async () => {
                    const { rows } = await client.query('select api.case_decide_passkey($1, $2, $3, $4, $5, $6) as s', [
                        ch.challenge_id, 'approve', assertion.credentialId, assertion.authenticatorData, assertion.clientDataJSON, assertion.signature,
                    ]);
                    expectApproved(rows[0].s);
                }));
            }
            client.release();
        }),
    );
    const totalMs = Number(process.hrtime.bigint() - started) / 1e6;
    const concurrent = { ...stats(samples), workers, total_ms: +totalMs.toFixed(0), per_second: +(N / (totalMs / 1000)).toFixed(1) };
    const chainLen = await one(pool('ADMIN'), 'select seq from sgn.audit_chain_head');
    return { baseline_case_get: baseline, a_passkey_in_db: a, b_idp_token_in_db: b, c_verifier_service_http: c, a_passkey_10_connections: concurrent, chain_length_after: Number(chainLen.seq) };
}

const result = { measured_at: new Date().toISOString(), n: N, unit: 'ms', primitive: await primitiveBench(), decision: await decisionBench() };
await closePools();
mkdirSync(join(PROBE_DB_DIR, '.run'), { recursive: true });
writeFileSync(join(PROBE_DB_DIR, '.run', 'bench.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
