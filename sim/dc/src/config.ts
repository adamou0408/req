// 設定只從環境變數讀：start.sh 載入 service.env（非機密）、instances/<實例>.env（實例自己的埠、資料庫、角色）
// 與這個實例的密鑰檔（執行期產生，見 lib.sh 的 sim_dc_init_secrets）；測試則自己給一組（另外的資料庫、角色前綴與 unix socket）。

export type Scope =
    | 'rules.write'
    | 'rules.read'
    | 'test_query'
    | 'reconcile.read'
    | 'usage.read'
    | 'data.use'
    | 'sandbox.run'
    | 'admin.backdoor';

export interface ClientConfig {
    readonly name: string;
    readonly key: string;
    readonly scopes: readonly Scope[];
}

export interface EnvConfig {
    readonly name: 'live' | 'masked';
    readonly basePath: string;
    readonly database: string;
    readonly rolePrefix: string;
    readonly masked: boolean;
    // 這個環境信任的平台簽章公鑰（每個環境各自一份；裁決 D81 (2)：同一份已簽章的規則不能送到另一個環境）
    readonly trustedKeysFile: string;
}

export interface Config {
    readonly host: string;
    readonly port: number;
    // 設定時改聽 unix socket（測試用，不占用 TCP 埠）
    readonly socketPath: string | null;
    readonly pgHost: string;
    readonly pgPort: number;
    readonly pgAdminUrl: string;
    readonly serviceRole: string;
    readonly servicePassword: string;
    readonly sandboxRole: string;
    readonly envs: readonly EnvConfig[];
    readonly systems: readonly string[];
    readonly timezone: string;
    // 平台的交付通道代碼：被簽的請求必須指名這個通道
    readonly channel: string;
    // 回應證明（attestation）的簽章私鑰（ES256，PKCS#8 PEM）
    readonly responseKeyFile: string;
    readonly backdoor: boolean;
    // 使用紀錄的時段長度（秒）與批次摘要涵蓋的天數（D92 (4)）
    readonly usagePeriodSeconds: number;
    readonly usageWindowDays: number;
    readonly clients: readonly ClientConfig[];
}

function required(name: string): string {
    const value = process.env[name];
    if (value === undefined || value === '') {
        throw new Error(`缺少環境變數 ${name}`);
    }
    return value;
}

// 角色與資料庫名稱只允許固定前綴，避免設定錯誤時動到共用 PostgreSQL 上別人的東西。
function checked(value: string, pattern: RegExp, name: string): string {
    if (!pattern.test(value)) {
        throw new Error(`${name}=${value} 不符合 ${String(pattern)}`);
    }
    return value;
}

const DB_NAME = /^sim_dc[a-z0-9_]{0,40}$/;
const ROLE_NAME = /^simdc_[a-z0-9_]{1,30}$/;

export function loadConfig(): Config {
    const socketPath = process.env['SIM_DC_SOCKET'];
    return {
        host: required('SIM_DC_HOST'),
        port: Number(required('SIM_DC_PORT')),
        socketPath: socketPath === undefined || socketPath === '' ? null : socketPath,
        pgHost: required('SIM_DC_PG_HOST'),
        pgPort: Number(required('SIM_DC_PG_PORT')),
        pgAdminUrl: required('SIM_DC_PG_ADMIN_URL'),
        serviceRole: checked(required('SIM_DC_SERVICE_ROLE'), ROLE_NAME, 'SIM_DC_SERVICE_ROLE'),
        servicePassword: required('SIM_DC_SERVICE_PASSWORD'),
        sandboxRole: checked(required('SIM_DC_SANDBOX_ROLE'), ROLE_NAME, 'SIM_DC_SANDBOX_ROLE'),
        envs: [
            {
                name: 'live',
                basePath: '/v1',
                database: checked(required('SIM_DC_DB'), DB_NAME, 'SIM_DC_DB'),
                rolePrefix: checked(required('SIM_DC_ROLE_PREFIX'), ROLE_NAME, 'SIM_DC_ROLE_PREFIX'),
                masked: false,
                trustedKeysFile: required('SIM_DC_TRUSTED_KEYS_FILE'),
            },
            {
                name: 'masked',
                basePath: '/masked/v1',
                database: checked(required('SIM_DC_DB_MASKED'), DB_NAME, 'SIM_DC_DB_MASKED'),
                rolePrefix: checked(required('SIM_DC_MASKED_ROLE_PREFIX'), ROLE_NAME, 'SIM_DC_MASKED_ROLE_PREFIX'),
                masked: true,
                trustedKeysFile: required('SIM_DC_TRUSTED_KEYS_FILE_MASKED'),
            },
        ],
        systems: required('SIM_DC_SYSTEMS')
            .split(/\s+/)
            .filter((s) => s !== ''),
        timezone: required('SIM_DC_TIMEZONE'),
        channel: required('SIM_DC_CHANNEL'),
        responseKeyFile: required('SIM_DC_RESPONSE_KEY_FILE'),
        backdoor: process.env['SIM_DC_ENABLE_BACKDOOR'] === '1',
        usagePeriodSeconds: Number(required('SIM_DC_USAGE_PERIOD_SECONDS')),
        usageWindowDays: Number(required('SIM_DC_USAGE_WINDOW_DAYS')),
        clients: [
            {
                name: 'platform',
                key: required('SIM_DC_KEY_PLATFORM'),
                scopes: ['rules.write', 'rules.read', 'test_query', 'reconcile.read', 'sandbox.run'],
            },
            { name: 'auditor', key: required('SIM_DC_KEY_AUDITOR'), scopes: ['rules.read', 'reconcile.read', 'usage.read'] },
            {
                name: 'admin',
                key: required('SIM_DC_KEY_ADMIN'),
                // data.use：代替實際操作的人查資料（使用方系統自己的前端；模擬器以 admin 金鑰扮演）
                scopes: ['rules.read', 'test_query', 'reconcile.read', 'usage.read', 'data.use', 'admin.backdoor'],
            },
        ],
    };
}
