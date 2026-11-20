#!/usr/bin/env node
// 平台與外部系統互相登記金鑰（裁決 D81 (2)；紅隊第四輪 高-3）。每個平台資料庫對應自己的外部系統實例（env.mjs 的 dcInstance）：
//   - 外部系統的信任清單＝這個資料庫目前那一把交付簽章公鑰，只有它（取代整份清單，不併入；沒有開發用金鑰，也不信任別的資料庫）。
//     遮罩環境的信任清單是空的：平台只交付到正式環境，同一份已簽章的規則送到遮罩環境一律不收。
//   - 資料庫信任外部系統實例目前的回應證明金鑰（只有這一把），並記下交付通道對應的外部系統環境（delivery.target_environment）。
// 私鑰在資料庫裡產生（sgn_internal.signing_key_create，db/build.sh），不離開資料庫；這裡只讀公鑰。
// 用法：node db/tools/delivery-keys.mjs <資料庫...>（以資料庫擁有者執行；之後要重新啟動外部系統實例，讓它讀新的信任清單）
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { adminUrl, dcInstance, dcRunDir, dcServiceEnv, loadConfig } from './lib/env.mjs';

const databases = process.argv.slice(2);
if (databases.length === 0) throw new Error('用法：delivery-keys.mjs <資料庫...>');

const config = loadConfig();
for (const database of databases) {
    const instance = dcInstance(config.db, database);
    const dc = dcServiceEnv(instance);
    const keysDir = join(dcRunDir(instance), 'keys');
    const db = new pg.Client({ connectionString: adminUrl(config, database) });
    await db.connect();
    try {
        await db.query(`set role "${config.db.SGN_ROLE_OWNER}"`);
        const { rows } = await db.query('select sgn_internal.signing_keys_current() as k');
        const trusted = rows[0].k.map((k) => ({ key_id: k.key_id, public_key_pem: k.public_key_pem }));
        // 外部系統的金鑰目錄只留實例自己的密鑰與信任清單：以前的版本在這裡產生過開發用的平台金鑰（platform-dev），清掉（紅隊第四輪 高-3）
        const own = new Set([
            'secrets.env',
            'response.private.pem',
            'response.public.pem',
            'response.key-id',
            'trusted-keys.json',
            'trusted-keys-masked.json',
        ]);
        for (const f of readdirSync(keysDir).filter((name) => !own.has(name))) rmSync(join(keysDir, f));
        writeFileSync(join(keysDir, 'trusted-keys.json'), `${JSON.stringify({ keys: trusted }, null, 2)}\n`, { mode: 0o600 });
        writeFileSync(join(keysDir, 'trusted-keys-masked.json'), `${JSON.stringify({ keys: [] }, null, 2)}\n`, { mode: 0o600 });
        const keyId = readFileSync(join(keysDir, 'response.key-id'), 'utf8').trim();
        const pem = readFileSync(join(keysDir, 'response.public.pem'), 'utf8');
        await db.query('select sgn_internal.channel_key_register($1, $2, $3, true)', [dc.SIM_DC_CHANNEL, keyId, pem]);
        await db.query(`select sgn_internal.register_setting_value('delivery.target_environment', $1, to_jsonb($2::text), $3)`, [
            `channel:${dc.SIM_DC_CHANNEL}`,
            dc.SIM_DC_DB,
            `db/tools/delivery-keys.mjs：外部系統實例 ${instance}`,
        ]);
        console.log(
            `${database} ↔ sim/dc ${instance}（${dc.SIM_DC_DB}）：外部系統信任 ${trusted.map((k) => k.key_id).join('、')}；資料庫信任回應金鑰 ${keyId}`,
        );
    } finally {
        await db.end();
    }
}
