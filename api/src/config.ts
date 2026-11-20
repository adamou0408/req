// 後端（api/src/server.ts）的設定。只有後端自己的：資料庫的 sgn_app 與身分提供者的 client secret（裁決 D81 (1)）。
// 交付、對帳、寄信各自在自己的程式裡讀自己的設定（delivery.ts、reconciler.ts、mailer.ts），後端的程序裡沒有它們的密鑰，
// 也沒有資料庫管理者連線。值的唯一來源是 db/sgn.env、sim/idp/service.env（非機密）與 .run/secrets/api.env（見 db/tools/lib/programs.mjs）。
// 連哪個資料庫由環境變數 SGN_DATABASE 決定（tools/run-all.sh 給端對端用的那一個）。
import { loadProgramConfig, programDbUrl, simServiceEnv } from '../../db/tools/lib/env.mjs';
import { PROGRAMS } from '../../db/tools/lib/programs.mjs';

type ProgramConfig = { db: Record<string, string>; secret: Record<string, string>; database: string };

const env = loadProgramConfig('api') as ProgramConfig;
const idp = simServiceEnv('idp') as Record<string, string>;
const origin = new URL(env.db.SGN_RP_ORIGIN);
// 頁面在另一個來源（裁決 D68：拿到後端不等於能改畫面）；後端只回 JSON，CORS 只開給它
const webOrigin = new URL(env.db.SGN_WEB_ORIGIN);
const redirectUri = new URL('/auth/oidc/callback', origin).toString();

if (!idp.SIM_IDP_CLIENT_REDIRECT_URIS.split(' ').includes(redirectUri)) {
    throw new Error(`redirect URI ${redirectUri} 沒有登記在身分提供者`);
}

export const config = {
    dbUrl: programDbUrl(env, PROGRAMS.api.roleKey) as string,
    origin,
    webOrigin: webOrigin.origin,
    listenHost: origin.hostname,
    listenPort: Number(origin.port),
    oidc: {
        issuer: idp.SIM_IDP_ISSUER,
        clientId: idp.SIM_IDP_CLIENT_ID,
        clientSecret: env.secret.SGN_IDP_CLIENT_SECRET,
        scopes: idp.SIM_IDP_SCOPES,
        redirectUri,
    },
};
