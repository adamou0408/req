// 交付程式（裁決 D63）：以 sgn_delivery 從資料庫領走該送的交付（api_delivery.delivery_claim），經交付 port 送到外部系統，
// 把外部系統的回應原樣交回（api_delivery.delivery_report）。它不產生、不改內容，也沒有簽章金鑰：
// 本文與簽章都是資料庫給的；送不到、要不要重送、驗證過了沒有，都由資料庫判斷。
// 用法：node api/src/delivery.ts              每個通道送一輪
//       node api/src/delivery.ts --every 2    每 2 秒一輪（常駐；tools/run-all.sh 啟動）
import pg from 'pg';
import { deliveryCalls } from '@sgn/contract';
import { dcHttpDelivery } from './dcHttp.ts';
import type { DeliveryItem, DeliveryPort } from './deliveryPort.ts';

const BATCH = 20;

/** 一個通道送一輪：領走、逐筆送出、回報。回傳送了幾筆。 */
export async function deliverChannel(db: pg.Pool, channel: string, port: DeliveryPort): Promise<number> {
    const claimed = (
        await db.query<{ r: DeliveryItem[] }>(`select api_delivery.${deliveryCalls.deliveryClaim.fn}($1, $2) as r`, [channel, BATCH])
    ).rows[0].r;
    for (const item of claimed) {
        const outcome = await port.send(item);
        await db.query(`select api_delivery.${deliveryCalls.deliveryReport.fn}($1, $2, $3)`, [item.op_id, item.lease_token, outcome]);
    }
    return claimed.length;
}

async function main(): Promise<void> {
    const { deliveryConfig } = await import('./config.ts');
    const db = new pg.Pool({ connectionString: deliveryConfig.dbUrl, max: 2 });
    const ports = Object.entries(deliveryConfig.channels).map(([channel, c]) => [channel, dcHttpDelivery(c)] as const);
    const once = async (): Promise<void> => {
        const out: Record<string, number> = {};
        for (const [channel, port] of ports) out[channel] = await deliverChannel(db, channel, port);
        if (Object.values(out).some((n) => n > 0)) console.log(JSON.stringify({ at: new Date().toISOString(), sent: out }));
    };
    const everyIndex = process.argv.indexOf('--every');
    await once();
    if (everyIndex > 0) setInterval(() => once().catch((err: unknown) => console.error(err)), Number(process.argv[everyIndex + 1]) * 1000);
    else await db.end();
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
