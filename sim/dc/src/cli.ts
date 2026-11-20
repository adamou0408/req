// 指令列入口：
//   serve [--reset]                     準備資料庫後啟動 HTTP 服務（start.sh 使用）
//   bootstrap [--reset]                 只準備資料庫：建立角色、資料庫、結構與示範資料
//   init-secrets <目錄>                  第一次啟動時產生這個實例的密鑰（已存在就不動）：secrets.env（服務的資料庫密碼、
//                                       三個呼叫方的金鑰，皆為隨機值）與回應證明的 ES256 金鑰對（response.private.pem、response.public.pem）
//   keygen <目錄> <金鑰代號>             產生一組 Ed25519 金鑰對（測試用：<代號>.private.pem 與 <代號>.public.pem）
//   trust <信任清單檔> <金鑰代號> <公鑰 PEM 檔>  寫一份只有這一把的信任清單（測試用；正式由平台的建置寫）
//   sign <私鑰 PEM 檔> <金鑰代號> <檔案>  印出這個檔案內容作為本文時的 Sgn-Signature 標頭值
// 沒有開發用的平台金鑰：信任清單（SIM_DC_TRUSTED_KEYS_FILE、…_MASKED）由平台的建置寫入（裁決 D81 (2)）。
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootstrap } from './bootstrap.ts';
import { loadConfig } from './config.ts';
import { createDcServer } from './server.ts';
import { generateKeyPair, generateResponseKey, loadResponseKey, loadTrustedKeys, signRequest } from './signature.ts';

async function serve(reset: boolean): Promise<void> {
    const config = loadConfig();
    const trusted = new Map(config.envs.map((e) => [e.name, loadTrustedKeys(e.trustedKeysFile)] as const));
    const responseKey = loadResponseKey(config.responseKeyFile);
    const envs = await bootstrap(config, { reset });
    const server = createDcServer(config, envs, trusted, responseKey);
    const shutdown = (): void => {
        server.close(() => {
            void Promise.all(envs.map((e) => e.pool.end())).then(() => process.exit(0));
        });
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    if (config.socketPath !== null) {
        server.listen(config.socketPath, () => console.log(`sim-dc 監聽 ${config.socketPath ?? ''}`));
    } else {
        server.listen(config.port, config.host, () => console.log(`sim-dc 監聽 http://${config.host}:${config.port}`));
    }
}

function writeSecret(file: string, text: string): void {
    writeFileSync(file, text, { mode: 0o600 });
    chmodSync(file, 0o600);
}

function keygen(dir: string, keyId: string): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const privateFile = join(dir, `${keyId}.private.pem`);
    if (existsSync(privateFile)) return;
    const { privatePem, publicPem } = generateKeyPair();
    writeSecret(privateFile, privatePem);
    writeFileSync(join(dir, `${keyId}.public.pem`), publicPem);
}

function initSecrets(dir: string): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const secrets = join(dir, 'secrets.env');
    if (!existsSync(secrets)) {
        const random = (): string => randomBytes(24).toString('base64url');
        const lines = [
            '# 自動產生（sim/dc/src/cli.ts init-secrets），請勿手動修改。只有這個實例與平台的建置（以 root）讀得到。',
            `SIM_DC_SERVICE_PASSWORD=${random()}`,
            `SIM_DC_KEY_PLATFORM=${random()}`,
            `SIM_DC_KEY_AUDITOR=${random()}`,
            `SIM_DC_KEY_ADMIN=${random()}`,
        ];
        writeSecret(secrets, `${lines.join('\n')}\n`);
    }
    const responsePrivate = join(dir, 'response.private.pem');
    if (!existsSync(responsePrivate)) {
        const { privatePem, publicPem } = generateResponseKey();
        writeSecret(responsePrivate, privatePem);
        writeFileSync(join(dir, 'response.public.pem'), publicPem);
    }
    // 金鑰代號由公鑰決定；平台的建置讀這個檔登記 DC 的回應金鑰
    writeFileSync(join(dir, 'response.key-id'), `${loadResponseKey(responsePrivate).keyId}\n`);
}

function trust(file: string, keyId: string, publicPemFile: string): void {
    writeFileSync(file, `${JSON.stringify({ keys: [{ key_id: keyId, public_key_pem: readFileSync(publicPemFile, 'utf8') }] })}\n`);
}

async function main(argv: string[]): Promise<void> {
    const [cmd, ...args] = argv;
    if (cmd === 'serve') return serve(args.includes('--reset'));
    if (cmd === 'bootstrap') {
        const envs = await bootstrap(loadConfig(), { reset: args.includes('--reset') });
        await Promise.all(envs.map((e) => e.pool.end()));
        return;
    }
    if (cmd === 'init-secrets' && args[0] !== undefined) return initSecrets(args[0]);
    if (cmd === 'keygen' && args[0] !== undefined && args[1] !== undefined) return keygen(args[0], args[1]);
    if (cmd === 'trust' && args[0] !== undefined && args[1] !== undefined && args[2] !== undefined) return trust(args[0], args[1], args[2]);
    if (cmd === 'sign' && args[0] !== undefined && args[1] !== undefined && args[2] !== undefined) {
        console.log(signRequest(readFileSync(args[0], 'utf8'), args[1], readFileSync(args[2])));
        return;
    }
    throw new Error(
        '用法：cli.ts serve|bootstrap [--reset] | init-secrets <目錄> | keygen <目錄> <金鑰代號> | trust <清單> <代號> <公鑰> | sign <私鑰> <金鑰代號> <檔案>',
    );
}

main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
});
