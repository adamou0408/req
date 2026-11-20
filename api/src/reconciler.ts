// 對帳程式（策略 4）：以排程帳號 sgn_job、外部系統的唯讀稽核金鑰，拉外部系統實際存在的權限，原樣交給資料庫驗證與比對
// （api_job.reconciliation_submit：只採信外部系統的證明；多出來的、少掉的、範圍不同的各開例外）。和交付程式不同帳號、不同金鑰，
// 交付程式被拿走而謊報時這裡會抓到；這個程式自己被拿走也改不了回報，只能不交（資料庫逾期開例外）。
// 設定只讀自己的（裁決 D81 (1)）：.run/secrets/reconciler.env（sgn_job 的密碼、外部系統的 auditor 金鑰）與外部系統的位址。
// 用法：node api/src/reconciler.ts              每個通道對一次
//       node api/src/reconciler.ts --every 30   每 30 秒一次（常駐；tools/run-all.sh 啟動）
import pg from 'pg';
import { jobCalls } from '@sgn/contract';
import { dcServiceEnv, loadProgramConfig, programDbUrl } from '../../db/tools/lib/env.mjs';
import { PROGRAMS } from '../../db/tools/lib/programs.mjs';
import { dcHttpReconciliation, type DcHttpOptions } from './dcHttp.ts';
import type { ReconciliationPort } from './deliveryPort.ts';

/** 一個通道對一次帳，回傳資料庫的摘要。 */
export async function reconcileChannel(db: pg.Pool, channel: string, port: ReconciliationPort): Promise<unknown> {
    const report = await port.fetchReport();
    return (await db.query<{ r: unknown }>(`select api_job.${jobCalls.reconciliationSubmit.fn}($1, $2) as r`, [channel, report])).rows[0].r;
}

type ProgramConfig = { db: Record<string, string>; secret: Record<string, string>; database: string };

function reconcilerConfig(): { dbUrl: string; channels: Record<string, DcHttpOptions> } {
    const env = loadProgramConfig('reconciler') as ProgramConfig;
    const dc = dcServiceEnv('main') as Record<string, string>;
    return {
        dbUrl: programDbUrl(env, PROGRAMS.reconciler.roleKey) as string,
        channels: {
            [dc.SIM_DC_CHANNEL]: { base: `http://${dc.SIM_DC_HOST}:${dc.SIM_DC_PORT}/v1`, key: env.secret.SGN_DC_KEY, timeoutMs: 10000 },
        },
    };
}

async function main(): Promise<void> {
    const config = reconcilerConfig();
    const db = new pg.Pool({ connectionString: config.dbUrl, max: 1 });
    const ports = Object.entries(config.channels).map(([channel, c]) => [channel, dcHttpReconciliation(c)] as const);
    const once = async (): Promise<void> => {
        for (const [channel, port] of ports) {
            console.log(JSON.stringify({ at: new Date().toISOString(), channel, result: await reconcileChannel(db, channel, port) }));
        }
    };
    const everyIndex = process.argv.indexOf('--every');
    await once();
    if (everyIndex > 0) setInterval(() => once().catch((err: unknown) => console.error(err)), Number(process.argv[everyIndex + 1]) * 1000);
    else await db.end();
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
