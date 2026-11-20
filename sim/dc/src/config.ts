// 設定只從環境變數讀：start.sh 載入 service.env（非機密）與 test-credentials.env（測試憑證），
// 測試則自己給一組（另外的資料庫、角色前綴與 unix socket），兩者不互相干擾。

export type Scope = 'rules.write' | 'rules.read' | 'test_query' | 'reconcile.read' | 'sandbox.run' | 'admin.backdoor';

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
    readonly trustedKeysFile: string;
    readonly backdoor: boolean;
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
            },
            {
                name: 'masked',
                basePath: '/masked/v1',
                database: checked(required('SIM_DC_DB_MASKED'), DB_NAME, 'SIM_DC_DB_MASKED'),
                rolePrefix: checked(required('SIM_DC_MASKED_ROLE_PREFIX'), ROLE_NAME, 'SIM_DC_MASKED_ROLE_PREFIX'),
                masked: true,
            },
        ],
        systems: required('SIM_DC_SYSTEMS').split(/\s+/).filter((s) => s !== ''),
        timezone: required('SIM_DC_TIMEZONE'),
        trustedKeysFile: required('SIM_DC_TRUSTED_KEYS_FILE'),
        backdoor: process.env['SIM_DC_ENABLE_BACKDOOR'] === '1',
        clients: [
            {
                name: 'platform',
                key: required('SIM_DC_KEY_PLATFORM'),
                scopes: ['rules.write', 'rules.read', 'test_query', 'reconcile.read', 'sandbox.run'],
            },
            { name: 'auditor', key: required('SIM_DC_KEY_AUDITOR'), scopes: ['rules.read', 'reconcile.read'] },
            {
                name: 'admin',
                key: required('SIM_DC_KEY_ADMIN'),
                scopes: ['rules.read', 'test_query', 'reconcile.read', 'admin.backdoor'],
            },
        ],
    };
}
