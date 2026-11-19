// 後端設定。值的唯一來源是 db/sgn.env 與 sim/idp 的 service.env、test-credentials.env；這裡只讀，不另寫一份。
// 連哪個資料庫由環境變數 SGN_DATABASE 決定（tools/run-all.sh 給端對端用的那一個）。
import { join } from 'node:path';
import { anchorFile, loadConfig, roleUrl } from '../../db/tools/lib/env.mjs';

type EnvFiles = { db: Record<string, string>; idp: Record<string, string>; database: string };

const env = loadConfig() as EnvFiles;
const origin = new URL(env.db.SGN_RP_ORIGIN);
const redirectUri = new URL('/auth/oidc/callback', origin).toString();

if (!env.idp.SIM_IDP_CLIENT_REDIRECT_URIS.split(' ').includes(redirectUri)) {
    throw new Error(`redirect URI ${redirectUri} 沒有登記在身分提供者`);
}

export const config = {
    dbUrl: roleUrl(env, 'APP') as string,
    origin,
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
    webDir: join(import.meta.dirname, '..', '..', 'web'),
};
