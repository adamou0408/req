#!/usr/bin/env node
// 排程（帳號 sgn_scheduler；裁決 D84 (6)）：套用已過冷卻期的延後異動（api_job.directory_settle），清除過期的挑戰值（api_job.auth_challenge_purge），
// 治理類持有人沒有可用金鑰時開例外（api_job.governance_check），通知卡住時開例外（api_job.notification_stuck_check），
// 交付卡住時開例外（api_job.delivery_stuck_check），到期的授權結束並排清除（api_job.grant_expire_due），
// 確認期限已過還沒確認的單自動撤銷（api_job.confirmation_expire_due），
// 超過時間沒有有效的對帳回報時開例外（api_job.reconciliation_overdue_check），確認期限前提醒（api_job.confirmation_remind_due），
// 錨定落後時開例外（api_job.anchor_lag_check）。全部依路由表的 schedulerCalls（唯一來源）。
// 通知的寄送（api/src/mailer.ts）、交付（api/src/delivery.ts）、對帳（api/src/reconciler.ts）是另外的程式。
// 用法：node db/tools/jobs.mjs              跑一次
//       node db/tools/jobs.mjs --every 60   每 60 秒跑一次（常駐；tools/run-all.sh 啟動）
import pg from 'pg';
import { schedulerCalls } from '../../packages/contract/src/routes.ts';
import { PROGRAMS } from './lib/programs.mjs';
import { loadProgramConfig, programDbUrl } from './lib/env.mjs';

// 設定：自己的密鑰檔（.run/secrets/jobs.env），見 db/tools/lib/programs.mjs
const config = loadProgramConfig('jobs');
const pool = new pg.Pool({ connectionString: programDbUrl(config, PROGRAMS.jobs.roleKey), max: 1 });
const everyIndex = process.argv.indexOf('--every');

async function runOnce() {
    const out = {};
    for (const call of Object.values(schedulerCalls)) {
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
