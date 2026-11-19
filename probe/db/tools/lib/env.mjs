// 讀 KEY=VALUE 設定檔（probe.env、sim 的 service.env），支援 "${OTHER}" 展開。
// 探針的所有連線設定都從這裡取得，不在程式裡寫死。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROBE_DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const REPO_DIR = join(PROBE_DB_DIR, '..', '..');

export function readEnvFile(path, base = {}) {
    const result = { ...base };
    for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        const key = line.slice(0, eq);
        let value = line.slice(eq + 1);
        if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
        result[key] = value.replace(/\$\{(\w+)\}/g, (_, name) => result[name] ?? '');
    }
    return result;
}

export function loadConfig() {
    const probe = readEnvFile(join(PROBE_DB_DIR, 'probe.env'));
    const ldap = readEnvFile(join(REPO_DIR, 'sim/ldap/test-credentials.env'), readEnvFile(join(REPO_DIR, 'sim/ldap/service.env')));
    const idp = readEnvFile(join(REPO_DIR, 'sim/idp/test-credentials.env'), readEnvFile(join(REPO_DIR, 'sim/idp/service.env')));
    return { probe, ldap, idp };
}

/** 以指定角色連線的 URL。role 是 probe.env 的鍵名後綴：APP、VERIFIER、SYNC、ANCHOR。 */
export function roleUrl(config, roleKey, database = config.probe.PROBE_DB) {
    const p = config.probe;
    const role = p[`PROBE_ROLE_${roleKey}`];
    const password = `${p.PROBE_ROLE_PASSWORD_PREFIX}${role}`;
    return `postgres://${role}:${encodeURIComponent(password)}@${p.PROBE_PG_HOST}:${p.PROBE_PG_PORT}/${database}`;
}

/** 最高權限連線（模擬資料庫管理者，用於建置與攻擊測試）。 */
export function adminUrl(config, database = config.probe.PROBE_DB) {
    const url = new URL(config.probe.PROBE_PG_ADMIN_URL);
    url.pathname = `/${database}`;
    return url.toString();
}
