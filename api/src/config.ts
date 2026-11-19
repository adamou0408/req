// 後端設定。值的唯一來源是 probe/db/probe.env 與 sim/idp 的 service.env、test-credentials.env；這裡只讀，不另寫一份。
import { join } from 'node:path';
import { loadConfig, roleUrl } from '../../db/tools/lib/env.mjs';

type EnvFiles = { probe: Record<string, string>; idp: Record<string, string> };

const env = loadConfig() as EnvFiles;
const origin = new URL(env.probe.PROBE_RP_ORIGIN);
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
    anchorFile: env.probe.PROBE_ANCHOR_FILE,
    webDir: join(import.meta.dirname, '..', '..', 'web'),
};
