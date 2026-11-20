// 交付程式（裁決 D63）：以 sgn_delivery 從資料庫領走該送的交付（api_delivery.delivery_claim），經交付 port 送到外部系統，
// 把外部系統的回應原樣交回（api_delivery.delivery_report）。它不產生、不改內容，也沒有簽章金鑰：
// 本文與簽章都是資料庫給的；送不到、要不要重送、驗證過了沒有，都由資料庫依外部系統的證明判斷。
// 設定只讀自己的（裁決 D81 (1)）：.run/secrets/delivery.env（sgn_delivery 的密碼、外部系統的 platform 金鑰）與外部系統的位址。
// 用法：node api/src/delivery.ts              每個通道送一輪
//       node api/src/delivery.ts --every 2    每 2 秒一輪（常駐；tools/run-all.sh 啟動）
import pg from 'pg';
import { deliveryCalls } from '@sgn/contract';
import { dcServiceEnv, loadProgramConfig, programDbUrl } from '../../db/tools/lib/env.mjs';
import { PROGRAMS } from '../../db/tools/lib/programs.mjs';
import { dcHttpDelivery, type DcHttpOptions } from './dcHttp.ts';
import type { DeliveryItem, DeliveryPort } from './deliveryPort.ts';

const BATCH = 20;

/** 一個通道送一輪：領走、逐筆送出、回報。回傳送了幾筆。 */
export async function deliverChannel(db: pg.Pool, channel: string, port: DeliveryPort): Promise<number> {
    const claimed = (
        await db.query<{ r: DeliveryItem[] }>(`select api_delivery.${deliveryCalls.deliveryClaim.fn}($1, $2) as r`, [channel, BATCH])
    ).rows[0].r;
    for (const item of claimed) {
        const outcome = await port.send(item);
        try {
            await db.query(`select api_delivery.${deliveryCalls.deliveryReport.fn}($1, $2, $3)`, [item.op_id, item.lease_token, outcome]);
        } catch (err) {
            // 送的途中這筆被作廢（撤銷時正在送的套用與驗證，裁決 D84 (4)）：資料庫不收它的回報，這一輪的其他筆照常回報
            if (!String((err as Error).message).startsWith('DELIVERY_LEASE:')) throw err;
            console.log(
                JSON.stringify({ at: new Date().toISOString(), op_id: item.op_id, report: 'not_accepted', reason: 'DELIVERY_LEASE' }),
            );
        }
    }
    return claimed.length;
}

type ProgramConfig = { db: Record<string, string>; secret: Record<string, string>; database: string };

/**
 * 交付通道 → adapter（docs/contract/02-pack-data-access.md §8.5：選用哪個 adapter 由設定決定）。
 * 哪個受管系統走哪個通道是資料庫的參數（delivery.channel）；這裡只決定通道怎麼連。開發環境的通道 dc 連 sim/dc 的 main 實例。
 */
function deliveryConfig(): { dbUrl: string; channels: Record<string, DcHttpOptions> } {
    const env = loadProgramConfig('delivery') as ProgramConfig;
    const dc = dcServiceEnv('main') as Record<string, string>;
    return {
        dbUrl: programDbUrl(env, PROGRAMS.delivery.roleKey) as string,
        channels: {
            [dc.SIM_DC_CHANNEL]: { base: `http://${dc.SIM_DC_HOST}:${dc.SIM_DC_PORT}/v1`, key: env.secret.SGN_DC_KEY, timeoutMs: 10000 },
        },
    };
}

async function main(): Promise<void> {
    const config = deliveryConfig();
    const db = new pg.Pool({ connectionString: config.dbUrl, max: 2 });
    const ports = Object.entries(config.channels).map(([channel, c]) => [channel, dcHttpDelivery(c)] as const);
    const once = async (): Promise<void> => {
        // 每一輪先回報心跳（裁決 D88 (3)：同時檢查其他程式有沒有停擺）；心跳失敗不擋住交付
        await db.query(`select api_delivery.${deliveryCalls.deliveryHeartbeat.fn}()`).catch((err: unknown) => console.error(err));
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
