// 讀 KEY=VALUE 設定檔（db/sgn.env、sim 的 service.env：ldap、idp、mail），支援 "${OTHER}" 展開。
// 所有連線設定都從這裡取得，不在程式裡寫死。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const REPO_DIR = join(DB_DIR, '..');
/** 執行期檔案（錨點檔、log、量測結果）。已列入 .gitignore。 */
export const RUN_DIR = join(REPO_DIR, '.run');

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

/**
 * 讀設定。database 是這個行程要連的資料庫：環境變數 SGN_DATABASE（run-all.sh 給端對端用），否則是資料庫測試的那一個。
 */
export function loadConfig() {
    const db = readEnvFile(join(DB_DIR, 'sgn.env'));
    const ldap = readEnvFile(join(REPO_DIR, 'sim/ldap/test-credentials.env'), readEnvFile(join(REPO_DIR, 'sim/ldap/service.env')));
    const idp = readEnvFile(join(REPO_DIR, 'sim/idp/test-credentials.env'), readEnvFile(join(REPO_DIR, 'sim/idp/service.env')));
    const mail = readEnvFile(join(REPO_DIR, 'sim/mail/service.env'));
    const database = process.env.SGN_DATABASE || db.SGN_DB_TEST;
    return { db, ldap, idp, mail, database };
}

/** 外部錨點檔（資料庫以外）。每個資料庫一個。 */
export function anchorFile(config, database = config.database) {
    return join(RUN_DIR, `anchors-${database}.jsonl`);
}

/** 以指定角色連線的 URL。roleKey 是 sgn.env 的鍵名後綴：APP、SYNC、JOB、TEST_VERIFIER。 */
export function roleUrl(config, roleKey, database = config.database) {
    const d = config.db;
    const role = d[`SGN_ROLE_${roleKey}`];
    const password = `${d.SGN_ROLE_PASSWORD_PREFIX}${role}`;
    return `postgres://${role}:${encodeURIComponent(password)}@${d.SGN_PG_HOST}:${d.SGN_PG_PORT}/${database}`;
}

/** 最高權限連線（模擬資料庫管理者，用於建置與攻擊測試）。 */
export function adminUrl(config, database = config.database) {
    const url = new URL(config.db.SGN_PG_ADMIN_URL);
    url.pathname = `/${database}`;
    return url.toString();
}
