// 對帳程式（策略 4）：以排程帳號 sgn_job、外部系統的唯讀稽核金鑰，拉外部系統實際存在的權限，交給資料庫比對
// （api_job.reconciliation_submit：多出來的、少掉的、範圍不同的各開例外）。和交付程式不同帳號、不同金鑰，
// 交付程式被拿走而謊報時這裡會抓到。
// 用法：node api/src/reconciler.ts              每個通道對一次
//       node api/src/reconciler.ts --every 30   每 30 秒一次（常駐；tools/run-all.sh 啟動）
import pg from 'pg';
import { jobCalls } from '@sgn/contract';
import { dcHttpReconciliation } from './dcHttp.ts';
import type { ReconciliationPort } from './deliveryPort.ts';

/** 一個通道對一次帳，回傳資料庫的摘要。 */
export async function reconcileChannel(db: pg.Pool, channel: string, port: ReconciliationPort): Promise<unknown> {
    const report = await port.fetchReport();
    return (await db.query<{ r: unknown }>(`select api_job.${jobCalls.reconciliationSubmit.fn}($1, $2) as r`, [channel, report])).rows[0].r;
}

async function main(): Promise<void> {
    const { reconcilerConfig } = await import('./config.ts');
    const db = new pg.Pool({ connectionString: reconcilerConfig.dbUrl, max: 1 });
    const ports = Object.entries(reconcilerConfig.channels).map(([channel, c]) => [channel, dcHttpReconciliation(c)] as const);
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
