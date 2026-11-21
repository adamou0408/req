// 交付測試共用：交付程式（api/src/delivery.ts 的 deliverChannel，帳號 sgn_delivery）配上交付 port 的模擬 adapter
// （api/src/dcMock.ts，只用在單元測試）跑一輪又一輪；把一張單從送審簽到執行關。真的外部系統（sim/dc）在合約測試與端對端測試。
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { dcMockDelivery } from '../../../../api/src/dcMock.ts';
import { deliverChannel } from '../../../../api/src/delivery.ts';
import { roleUrl } from '../../../tools/lib/env.mjs';
import { call, config, login, registerPasskey, setSetting } from '../../kernel/lib/harness.mjs';
import { DA, decide, today } from './lib.mjs';

export const CHANNEL = 'dc';
export const CONTEXT = 'sgn-dc-sig/1';

export function deliveryPool() {
    return new pg.Pool({ connectionString: roleUrl(config, 'DELIVERY'), max: 3 });
}

/**
 * 模擬的外部系統：信任這個資料庫目前的交付簽章公鑰；回報的目錄版本是平台目前的版本；它自己的回應證明金鑰（每次一把新的）登記進資料庫
 * （和 sim/dc 的 unit 實例的金鑰並存，不退役它；環境代碼用資料庫設定的那一個）。
 */
export async function mockDc(admin) {
    const keys = (await admin.query('select sgn_internal.signing_keys_current() as k')).rows[0].k;
    const environment = (
        await admin.query(`select sgn_internal.setting('delivery.target_environment', array['channel:${CHANNEL}']) #>> '{}' as e`)
    ).rows[0].e;
    const catalog = (await admin.query(`select pack_data_access.catalog_current() ->> 'sha256' as s`)).rows[0].s;
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const keyId = `mock-${randomUUID().slice(0, 8)}`;
    await admin.query('select sgn_internal.channel_key_register($1, $2, $3, false)', [
        CHANNEL,
        keyId,
        publicKey.export({ type: 'spki', format: 'pem' }),
    ]);
    return dcMockDelivery({
        trustedKeys: keys,
        context: CONTEXT,
        today: () => today(),
        channel: CHANNEL,
        environment,
        responseKey: { keyId, privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() },
        // 模擬的外部系統用的目錄版本：預設和平台目前的版本相同（D92 (1)）；測試改它模擬使用方的目錄改了
        catalog: { sha256: catalog },
    });
}

/** 交付程式跑到沒有可送的為止（每一輪領走、送出、回報）。回傳總共送了幾筆。 */
export async function drain(delivery, port, rounds = 20) {
    let total = 0;
    for (let i = 0; i < rounds; i += 1) {
        const n = await deliverChannel(delivery, CHANNEL, port);
        if (n === 0) return total;
        total += n;
    }
    throw new Error('交付一直有東西可送');
}

/** 交付設定：資料中心走系統對系統（種子的預設），重送立即、不會因為測試慢而算卡住。 */
export async function systemDelivery(admin) {
    await setSetting(admin, 'delivery.mode', 'system', 'system:dc');
    await setSetting(admin, 'delivery.retry_base_seconds', 0, `channel:${CHANNEL}`);
    await setSetting(admin, 'delivery.stuck_alert_seconds', 3600, `channel:${CHANNEL}`);
}

/** 只有銷售訂單（期間欄位 order_date）的 L3 內容：測試各用不重疊的年份，彼此不算重疊。 */
export function salesOrderContent(year, fields = ['amount', 'order_date', 'order_no'], regions = ['north']) {
    return {
        scope: [{ package: 'sales_order', fields, row_filters: [{ filter: 'region', op: 'in', values: regions }] }],
        data_period: { from: `${year}-01-01`, to: `${year}-12-31` },
        purpose_category: 'reporting',
        purpose_description: '交付測試',
        export_allowed: false,
    };
}

/**
 * 林怡君（p04）替自己負責的 sales-report-bot 申請（不加負責人確認），主管、資料擁有者、MIS 簽完，
 * 交付程式配模擬的外部系統送到自動驗證通過、等申請人確認（K-CONFIRM）。回傳 case_id。
 */
export async function confirmableSalesOrderCase(app, admin, applicant, year) {
    const signers = {};
    for (const uid of ['p03', 'p11', 'p17']) {
        signers[uid] = await login(app, uid);
        signers[uid].key = await registerPasskey(app, signers[uid]);
    }
    await systemDelivery(admin);
    const principal = (await call(app, 'principal_list', applicant.session)).find((p) => p.name === 'sales-report-bot');
    const t = { principal_id: principal.principal_id, valid_from: today(), valid_to: today(60) };
    const c = await call(app, 'case_submit_new', applicant.session, DA, salesOrderContent(year), t, null);
    await decide(app, signers.p03, c.case_id);
    await decide(app, signers.p11, c.case_id);
    await call(app, 'task_claim', signers.p17.session, c.case_id);
    await decide(app, signers.p17, c.case_id);
    const delivery = deliveryPool();
    try {
        await drain(delivery, await mockDc(admin));
    } finally {
        await delivery.end();
    }
    return c.case_id;
}

/** 申請人確認驗證結果（K-CONFIRM），授權才生效。回傳申請單詳情。 */
export const confirmVerification = (app, applicant, caseId) => call(app, 'case_confirm_verification', applicant.session, caseId);

/** 同 confirmableSalesOrderCase，再由申請人確認驗證結果，到生效。回傳 case_id。 */
export async function activeSalesOrderCase(app, admin, applicant, year) {
    const caseId = await confirmableSalesOrderCase(app, admin, applicant, year);
    await confirmVerification(app, applicant, caseId);
    return caseId;
}

/** 這張單的交付（依建立順序）。 */
export async function ops(admin, caseId) {
    const { rows } = await admin.query(
        `select id, channel, kind, version, status, attempts, body, signature, superseded_by, last_http_status
         from sgn.delivery_op where case_id = $1 order by id`,
        [caseId],
    );
    return rows;
}
