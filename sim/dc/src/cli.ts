// 指令列入口：
//   serve [--reset]                     準備資料庫後啟動 HTTP 服務（start.sh 使用）
//   bootstrap [--reset]                 只準備資料庫：建立角色、資料庫、結構與示範資料
//   keygen <目錄> <金鑰代號>             產生 Ed25519 金鑰對：<代號>.private.pem 與 trusted-keys.json
//   sign <私鑰 PEM 檔> <金鑰代號> <檔案>  印出這個檔案內容作為本文時的 Sgn-Signature 標頭值
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootstrap } from './bootstrap.ts';
import { loadConfig } from './config.ts';
import { createDcServer } from './server.ts';
import { generateKeyPair, loadTrustedKeys, signRequest } from './signature.ts';

async function serve(reset: boolean): Promise<void> {
    const config = loadConfig();
    const keys = loadTrustedKeys(config.trustedKeysFile);
    const envs = await bootstrap(config, { reset });
    const server = createDcServer(config, envs, keys);
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

function keygen(dir: string, keyId: string): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const privateFile = join(dir, `${keyId}.private.pem`);
    const trustedFile = join(dir, 'trusted-keys.json');
    if (existsSync(privateFile) && existsSync(trustedFile)) return;
    const { privatePem, publicPem } = generateKeyPair();
    writeFileSync(privateFile, privatePem, { mode: 0o600 });
    chmodSync(privateFile, 0o600);
    writeFileSync(trustedFile, `${JSON.stringify({ keys: [{ key_id: keyId, public_key_pem: publicPem }] }, null, 2)}\n`);
}

async function main(argv: string[]): Promise<void> {
    const [cmd, ...args] = argv;
    if (cmd === 'serve') return serve(args.includes('--reset'));
    if (cmd === 'bootstrap') {
        const envs = await bootstrap(loadConfig(), { reset: args.includes('--reset') });
        await Promise.all(envs.map((e) => e.pool.end()));
        return;
    }
    if (cmd === 'keygen' && args[0] !== undefined && args[1] !== undefined) return keygen(args[0], args[1]);
    if (cmd === 'sign' && args[0] !== undefined && args[1] !== undefined && args[2] !== undefined) {
        console.log(signRequest(readFileSync(args[0], 'utf8'), args[1], readFileSync(args[2])));
        return;
    }
    throw new Error('用法：cli.ts serve|bootstrap [--reset] | keygen <目錄> <金鑰代號> | sign <私鑰> <金鑰代號> <檔案>');
}

main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
});
