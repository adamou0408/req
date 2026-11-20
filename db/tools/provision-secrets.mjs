#!/usr/bin/env node
// 發給每個執行期程式它自己的密鑰（裁決 D81 (1)；紅隊第四輪 高-1）。db/build.sh 在角色密碼與外部系統的金鑰都產生之後以 root 執行。
//   - 每個程式一個作業系統帳號（sgn-<程式>，沒有登入殼、沒有家目錄），tools/run-all.sh 以它啟動程式
//   - .run/secrets/<程式>.env：只有 programs.mjs 列的鍵，擁有者是該帳號、權限 0400；目錄 0711（列不出檔名）
//   - 錨點寫入金鑰每次重新產生：錨定程式拿金鑰本身，錨點存放處只拿它的 SHA-256
//   - 錨點存放處的資料檔 .run/anchors-<端對端資料庫>.jsonl 由存放處的帳號擁有（後端、錨定程式的帳號都寫不了）
// 對象是端對端用的資料庫（SGN_DB_E2E）與它的外部系統實例（main）。需要 root：建立帳號、設定檔案擁有者。
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, chownSync, closeSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROGRAMS, osUser, secretKeys } from './lib/programs.mjs';
import { RUN_DIR, SECRETS_DIR, anchorFile, dcRunDir, loadConfig, readEnvFile } from './lib/env.mjs';

if (process.getuid?.() !== 0) throw new Error('provision-secrets 需要 root（建立作業系統帳號、設定檔案擁有者）');

const config = loadConfig();
const dc = readEnvFile(join(dcRunDir('main'), 'keys', 'secrets.env'));

function ensureUser(name) {
    try {
        execFileSync('id', ['-u', name], { stdio: 'ignore' });
    } catch {
        execFileSync('useradd', ['--system', '--no-create-home', '--user-group', '--shell', '/usr/sbin/nologin', name]);
    }
    const id = (flag) => Number(execFileSync('id', [flag, name], { encoding: 'utf8' }).trim());
    return { uid: id('-u'), gid: id('-g') };
}

const anchorKey = randomBytes(32).toString('base64url');
const values = {
    SGN_IDP_CLIENT_SECRET: config.idp.SIM_IDP_CLIENT_SECRET,
    SGN_ANCHOR_WRITE_KEY: anchorKey,
    SGN_ANCHOR_WRITE_KEY_SHA256: createHash('sha256').update(anchorKey).digest('hex'),
};
const dcKey = { delivery: dc.SIM_DC_KEY_PLATFORM, reconciler: dc.SIM_DC_KEY_AUDITOR };

mkdirSync(SECRETS_DIR, { recursive: true });
chmodSync(SECRETS_DIR, 0o711);
const written = {};
for (const [program, def] of Object.entries(PROGRAMS)) {
    const owner = ensureUser(osUser(program));
    const entries = secretKeys(program).map((key) => {
        const value =
            key === 'SGN_DB_PASSWORD'
                ? config.secrets[`SGN_ROLE_PASSWORD_${def.roleKey}`]
                : key === 'SGN_DC_KEY'
                  ? dcKey[program]
                  : values[key];
        if (!value) throw new Error(`${program} 的 ${key} 沒有值`);
        return `${key}=${value}`;
    });
    const file = join(SECRETS_DIR, `${program}.env`);
    writeFileSync(
        file,
        `# 自動產生（db/tools/provision-secrets.mjs），請勿手動修改。只有 ${osUser(program)} 讀得到。\n${entries.join('\n')}\n`,
        {
            mode: 0o400,
        },
    );
    chmodSync(file, 0o400);
    chownSync(file, owner.uid, owner.gid);
    written[program] = secretKeys(program);
}

// 錨點存放處的資料檔：清空並交給存放處的帳號（.run 本身屬於 root，別的帳號不能在裡面建立或替換檔案）
const store = ensureUser(osUser('anchor-store'));
const file = anchorFile(config, config.db.SGN_DB_E2E);
closeSync(openSync(file, 'w', 0o644));
chmodSync(file, 0o644);
chownSync(file, store.uid, store.gid);
chmodSync(RUN_DIR, 0o755);

console.log(JSON.stringify({ secrets: written, anchor_store_file: file }));
