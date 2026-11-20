// 讀 KEY=VALUE 設定檔（db/sgn.env、sim 的 service.env：ldap、idp、mail、dc），支援 "${OTHER}" 展開。
// 所有連線設定都從這裡取得，不在程式裡寫死。
//
// 兩種讀法（裁決 D81 (1)：每個程式只拿得到自己的密鑰）：
//   loadConfig()             建置、測試與攻擊腳本用（以 root 執行的「操作者」）：非機密設定＋管理者連線（db/admin.env）
//                            ＋各角色的密碼（.run/secrets/roles.env）＋外部系統實例的密鑰。執行期的程式不得呼叫它。
//   loadProgramConfig(名稱)   執行期的程式用：非機密設定＋自己的密鑰檔 .run/secrets/<名稱>.env（擁有者是那個程式的作業系統帳號，
//                            別的程式讀不到）。程式與它的密鑰清單在 programs.mjs。
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const REPO_DIR = join(DB_DIR, '..');
/** 執行期檔案（錨點檔、log、量測結果）。已列入 .gitignore。 */
export const RUN_DIR = join(REPO_DIR, '.run');
/** 各程式的密鑰檔與角色密碼（db/build.sh、db/tools/provision-secrets.mjs 寫入）。 */
export const SECRETS_DIR = join(RUN_DIR, 'secrets');

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

const readIfExists = (path, base = {}) => (existsSync(path) ? readEnvFile(path, base) : { ...base });

/** sim 服務的非機密設定（service.env）。 */
export function simServiceEnv(name) {
    return readEnvFile(join(REPO_DIR, 'sim', name, 'service.env'));
}

/** sim 服務的執行期目錄（只有 root 讀得到的密碼檔在這裡）。 */
export function simRunDir(name) {
    return join(REPO_DIR, 'sim', '.run', name);
}

/** 外部系統（sim/dc）的實例：平台的資料庫測試（SGN_DB_TEST）連 unit，其他連 main（sim/dc/instances/）。 */
export function dcInstance(db, database) {
    return database === db.SGN_DB_TEST ? 'unit' : 'main';
}

/** 實例的執行期目錄（密鑰在 keys/）。 */
export function dcRunDir(instance) {
    return join(REPO_DIR, 'sim', '.run', instance === 'main' ? 'dc' : `dc-${instance}`);
}

/** 實例的非機密設定：service.env 加上 instances/<實例>.env 的覆寫。 */
export function dcServiceEnv(instance) {
    const base = simServiceEnv('dc');
    return instance === 'main' ? base : readEnvFile(join(REPO_DIR, 'sim', 'dc', 'instances', `${instance}.env`), base);
}

/**
 * 操作者的設定（建置、測試、攻擊腳本）。database 是這個行程要連的資料庫：環境變數 SGN_DATABASE（run-all.sh 給端對端用），
 * 否則是資料庫測試的那一個。dc 是這個資料庫對應的外部系統實例（含它的呼叫方金鑰）。
 */
export function loadConfig() {
    const db = readEnvFile(join(DB_DIR, 'sgn.env'));
    const admin = readEnvFile(join(DB_DIR, 'admin.env'));
    const secrets = readIfExists(join(SECRETS_DIR, 'roles.env'));
    // sim 的密碼在第一次啟動時隨機產生，只有 root 讀得到（裁決 D84 (1)；sim/ldap/lib.sh、sim/idp/lib.sh）
    const ldap = readIfExists(join(simRunDir('ldap'), 'secrets.env'), simServiceEnv('ldap'));
    const idp = readIfExists(join(simRunDir('idp'), 'secrets.env'), simServiceEnv('idp'));
    const mail = simServiceEnv('mail');
    const database = process.env.SGN_DATABASE || db.SGN_DB_TEST;
    const instance = dcInstance(db, database);
    const dc = readIfExists(join(dcRunDir(instance), 'keys', 'secrets.env'), dcServiceEnv(instance));
    return { db, admin, secrets, ldap, idp, mail, dc, database };
}

/** 執行期程式的設定：非機密的 db/sgn.env 與自己的密鑰檔。讀不到別人的（檔案權限）。 */
export function loadProgramConfig(program) {
    const db = readEnvFile(join(DB_DIR, 'sgn.env'));
    const secret = readEnvFile(join(SECRETS_DIR, `${program}.env`));
    const database = process.env.SGN_DATABASE || db.SGN_DB_TEST;
    return { db, secret, database };
}

/** 外部錨點檔（資料庫以外；由錨點存放處 db/tools/anchor-store.mjs 寫入）。每個資料庫一個。 */
export function anchorFile(config, database = config.database) {
    return join(RUN_DIR, `anchors-${database}.jsonl`);
}

function pgUrl(d, role, password, database) {
    return `postgres://${role}:${encodeURIComponent(password)}@${d.SGN_PG_HOST}:${d.SGN_PG_PORT}/${database}`;
}

/** 以指定角色連線的 URL（操作者用）。roleKey 是 sgn.env 的鍵名後綴：APP、SYNC、JOB、DELIVERY、IDP_KEYS、TEST_VERIFIER。 */
export function roleUrl(config, roleKey, database = config.database) {
    const password = config.secrets[`SGN_ROLE_PASSWORD_${roleKey}`];
    if (!password) throw new Error(`沒有 ${roleKey} 的密碼（.run/secrets/roles.env）：先執行 db/build.sh`);
    return pgUrl(config.db, config.db[`SGN_ROLE_${roleKey}`], password, database);
}

/** 執行期程式自己的資料庫連線（角色見 programs.mjs，密碼在它的密鑰檔）。 */
export function programDbUrl(config, roleKey, database = config.database) {
    return pgUrl(config.db, config.db[`SGN_ROLE_${roleKey}`], config.secret.SGN_DB_PASSWORD, database);
}

/** 最高權限連線（模擬資料庫管理者，用於建置與攻擊測試）。 */
export function adminUrl(config, database = config.database) {
    const url = new URL(config.admin.SGN_PG_ADMIN_URL);
    url.pathname = `/${database}`;
    return url.toString();
}
