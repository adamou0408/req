// 設定的唯一來源：sim 的 service.env 與 test-credentials.env（KEY=VALUE，支援 ${VAR} 展開），
// 加上少數本探針自己的環境變數。不在這裡另抄一份位址或密碼。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/** 讀 sim/<服務>/ 底下的 env 檔，回傳展開後的鍵值。 */
export function readSimEnv(service: string): Record<string, string> {
    const values: Record<string, string> = {};
    for (const file of ['service.env', 'test-credentials.env']) {
        let text: string;
        try {
            text = readFileSync(path.join(repoRoot, 'sim', service, file), 'utf8');
        } catch {
            continue;
        }
        for (const line of text.split('\n')) {
            const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
            if (!match) continue;
            const raw = match[2].replace(/^"(.*)"$/, '$1');
            values[match[1]] = raw.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => values[name] ?? '');
        }
    }
    return values;
}

function required(values: Record<string, string>, key: string): string {
    const value = values[key];
    if (!value) throw new Error(`sim 設定缺少 ${key}`);
    return value;
}

export interface OidcConfig {
    issuer: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    scopes: string;
}

export interface LdapConfig {
    url: string;
    bindDn: string;
    bindPassword: string;
    peopleDn: string;
    groupsDn: string;
}

export interface AppConfig {
    port: number;
    /** 瀏覽器看到的來源。WebAuthn 的 rpId 不能是 IP，所以用 localhost。 */
    origin: string;
    rpId: string;
    rpName: string;
    webDir: string;
    oidc: OidcConfig;
}

export function loadLdapConfig(): LdapConfig {
    const env = readSimEnv('ldap');
    return {
        url: required(env, 'SIM_LDAP_URL'),
        bindDn: required(env, 'SIM_LDAP_READER_DN'),
        bindPassword: required(env, 'SIM_LDAP_READER_PASSWORD'),
        peopleDn: required(env, 'SIM_LDAP_PEOPLE_DN'),
        groupsDn: required(env, 'SIM_LDAP_GROUPS_DN'),
    };
}

export function loadConfig(): AppConfig {
    const idp = readSimEnv('idp');
    const port = Number(process.env.PROBE_PORT ?? 3000);
    const origin = process.env.PROBE_ORIGIN ?? `http://localhost:${port}`;
    const redirectUri = `${origin}/auth/oidc/callback`;
    const registered = required(idp, 'SIM_IDP_CLIENT_REDIRECT_URIS').split(/\s+/);
    if (!registered.includes(redirectUri)) {
        throw new Error(`redirect URI ${redirectUri} 沒有在 sim/idp 登記（已登記：${registered.join(', ')}）`);
    }
    return {
        port,
        origin,
        rpId: new URL(origin).hostname,
        rpName: 'sgn probe',
        webDir: path.join(repoRoot, 'probe', 'web'),
        oidc: {
            issuer: required(idp, 'SIM_IDP_ISSUER'),
            clientId: required(idp, 'SIM_IDP_CLIENT_ID'),
            clientSecret: required(idp, 'SIM_IDP_CLIENT_SECRET'),
            redirectUri,
            scopes: required(idp, 'SIM_IDP_SCOPES'),
        },
    };
}
