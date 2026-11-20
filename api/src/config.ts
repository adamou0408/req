// 後端、通知寄送、交付與對帳程式的設定。值的唯一來源是 db/sgn.env 與 sim/idp、sim/mail、sim/dc 的 service.env、test-credentials.env；這裡只讀，不另寫一份。
// 連哪個資料庫由環境變數 SGN_DATABASE 決定（tools/run-all.sh 給端對端用的那一個）。
import { anchorFile, loadConfig, roleUrl } from '../../db/tools/lib/env.mjs';

type EnvFiles = {
    db: Record<string, string>;
    idp: Record<string, string>;
    mail: Record<string, string>;
    dc: Record<string, string>;
    database: string;
};

const env = loadConfig() as EnvFiles;
const origin = new URL(env.db.SGN_RP_ORIGIN);
// 頁面在另一個來源（裁決 D68：拿到後端不等於能改畫面）；後端只回 JSON，CORS 只開給它
const webOrigin = new URL(env.db.SGN_WEB_ORIGIN);
const redirectUri = new URL('/auth/oidc/callback', origin).toString();

if (!env.idp.SIM_IDP_CLIENT_REDIRECT_URIS.split(' ').includes(redirectUri)) {
    throw new Error(`redirect URI ${redirectUri} 沒有登記在身分提供者`);
}

export const config = {
    dbUrl: roleUrl(env, 'APP') as string,
    origin,
    webOrigin: webOrigin.origin,
    listenHost: origin.hostname,
    listenPort: Number(origin.port),
    oidc: {
        issuer: env.idp.SIM_IDP_ISSUER,
        clientId: env.idp.SIM_IDP_CLIENT_ID,
        clientSecret: env.idp.SIM_IDP_CLIENT_SECRET,
        scopes: env.idp.SIM_IDP_SCOPES,
        redirectUri,
    },
    anchorFile: anchorFile(env) as string,
};

/** 通知寄送程式（api/src/mailer.ts）：以排程帳號連線，經 SMTP 寄出（開發環境是 sim/mail 的 Mailpit）。 */
export const mailerConfig = {
    dbUrl: roleUrl(env, 'JOB') as string,
    smtp: { host: env.mail.SIM_MAIL_SMTP_HOST, port: Number(env.mail.SIM_MAIL_SMTP_PORT) },
    from: env.db.SGN_MAIL_FROM,
};

const dc = env.dc;
const dcBase = `http://${dc.SIM_DC_HOST}:${dc.SIM_DC_PORT}/v1`;

/**
 * 交付通道 → adapter（docs/contract/02-pack-data-access.md §8.5：選用哪個 adapter 由後端設定決定）。
 * 哪個受管系統走哪個通道是資料庫的參數（delivery.channel）；這裡只決定通道怎麼連。開發環境的通道 dc 連 sim/dc。
 */
export const deliveryConfig = {
    /** 交付程式（api/src/delivery.ts）以 sgn_delivery 連線，只能執行 api_delivery */
    dbUrl: roleUrl(env, 'DELIVERY') as string,
    channels: { dc: { kind: 'http' as const, base: dcBase, key: dc.SIM_DC_KEY_PLATFORM, timeoutMs: 10000 } },
};

/** 對帳程式（api/src/reconciler.ts）：排程帳號 sgn_job，外部系統的唯讀稽核金鑰（和交付程式不同帳號、不同金鑰） */
export const reconcilerConfig = {
    dbUrl: roleUrl(env, 'JOB') as string,
    channels: { dc: { base: dcBase, key: dc.SIM_DC_KEY_AUDITOR, timeoutMs: 10000 } },
};
