#!/usr/bin/env node
// 排程（帳號 sgn_job）：套用已過冷卻期的延後異動（api_job.directory_settle），清除過期的挑戰值（api_job.auth_challenge_purge），
// 治理類持有人沒有可用金鑰時開例外（api_job.governance_check）。通知的寄送是另一個程式（api/src/mailer.ts）。
// 用法：node db/tools/jobs.mjs              跑一次
//       node db/tools/jobs.mjs --every 60   每 60 秒跑一次（常駐；tools/run-all.sh 啟動）
import pg from 'pg';
import { jobCalls } from '../../packages/contract/src/routes.ts';
import { loadConfig, roleUrl } from './lib/env.mjs';

const config = loadConfig();
const pool = new pg.Pool({ connectionString: roleUrl(config, 'JOB'), max: 1 });
const everyIndex = process.argv.indexOf('--every');

async function runOnce() {
    const out = {};
    for (const call of [jobCalls.directorySettle, jobCalls.authChallengePurge, jobCalls.governanceCheck]) {
        out[call.fn] = (await pool.query(`select api_job.${call.fn}() as r`)).rows[0].r;
    }
    console.log(JSON.stringify({ at: new Date().toISOString(), ...out }));
}

await runOnce();
if (everyIndex > 0) {
    setInterval(() => runOnce().catch((err) => console.error(err.message)), Number(process.argv[everyIndex + 1]) * 1000);
} else {
    await pool.end();
}
