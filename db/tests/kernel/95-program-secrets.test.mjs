// 架構測試：每個執行期程式只拿得到自己的密鑰（裁決 D81 (1)；紅隊第四輪 高-1、高-3，redteam/exploits/20、25）。
// 程式與密鑰清單的唯一來源是 db/tools/lib/programs.mjs；密鑰由 db/build.sh 與 db/tools/provision-secrets.mjs 產生與發放。
// 「拿掉防法就失敗」：任何程式改回讀操作者的設定（loadConfig），或密鑰檔多放別人的值、檔案權限放寬、角色密碼又變成可推的，
// 這裡就會失敗。程序的記憶體以 heap snapshot 實際檢查（不是只看設定檔）。
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { PROGRAMS, osUser, secretKeys } from '../../tools/lib/programs.mjs';
import { REPO_DIR, SECRETS_DIR, adminUrl, dcRunDir, readEnvFile } from '../../tools/lib/env.mjs';
import { closePools, config } from './lib/harness.mjs';
import pg from 'pg';

after(closePools);

const uidOf = (user) => Number(execFileSync('id', ['-u', user], { encoding: 'utf8' }).trim());
const secretFile = (program) => join(SECRETS_DIR, `${program}.env`);
const dcSecrets = (instance) => readEnvFile(join(dcRunDir(instance), 'keys', 'secrets.env'));

/** 每一個密鑰的值 → 誰可以有它（程式名稱的集合）。 */
function secretOwners() {
    const owners = new Map();
    const add = (value, programs) => owners.set(value, new Set(programs));
    for (const [key, value] of Object.entries(config.secrets)) {
        const roleKey = key.replace('SGN_ROLE_PASSWORD_', '');
        add(
            value,
            Object.entries(PROGRAMS)
                .filter(([, d]) => d.roleKey === roleKey)
                .map(([p]) => p),
        );
    }
    const main = dcSecrets('main');
    add(main.SIM_DC_KEY_PLATFORM, ['delivery']);
    add(main.SIM_DC_KEY_AUDITOR, ['reconciler']);
    add(main.SIM_DC_KEY_ADMIN, []);
    add(main.SIM_DC_SERVICE_PASSWORD, []);
    for (const v of Object.values(dcSecrets('unit'))) add(v, []);
    add(config.admin.SGN_PG_ADMIN_URL, []);
    add(config.idp.SIM_IDP_CLIENT_SECRET, ['api']);
    add(readEnvFile(secretFile('anchor')).SGN_ANCHOR_WRITE_KEY, ['anchor']);
    return owners;
}

test('架構：每個程式一個密鑰檔，只有 programs.mjs 列的鍵與自己的值；擁有者是自己的作業系統帳號、權限 0400', () => {
    const owners = secretOwners();
    assert.equal(statSync(SECRETS_DIR).mode & 0o777, 0o711, '目錄列不出檔名');
    assert.equal(statSync(join(SECRETS_DIR, 'roles.env')).mode & 0o777, 0o600, '角色密碼只有 root 讀得到');
    for (const program of Object.keys(PROGRAMS)) {
        const file = secretFile(program);
        const st = statSync(file);
        assert.equal(st.uid, uidOf(osUser(program)), `${program} 的檔案擁有者`);
        assert.equal(st.mode & 0o777, 0o400, `${program} 的檔案權限`);
        const values = readEnvFile(file);
        assert.deepEqual(Object.keys(values).sort(), secretKeys(program).sort(), `${program} 的鍵`);
        const text = readFileSync(file, 'utf8');
        for (const [value, allowed] of owners) {
            if (value && text.includes(value)) assert.ok(allowed.has(program), `${program} 的檔案裡有不屬於它的密鑰`);
        }
    }
    // 後端與頁面伺服器不連外部系統、不寫錨點；只有對帳程式有 auditor 金鑰、只有交付程式有 platform 金鑰
    assert.deepEqual(secretKeys('web'), []);
    assert.ok(!secretKeys('api').some((k) => k.startsWith('SGN_DC') || k.startsWith('SGN_ANCHOR')));
});

test('架構：各資料庫角色每次建置各自一組隨機密碼（不是前綴＋角色名）；作業系統帳號互相讀不到對方的密鑰檔，也讀不到角色密碼與外部系統的密鑰', () => {
    const passwords = Object.values(config.secrets);
    assert.ok(passwords.length >= 6);
    assert.equal(new Set(passwords).size, passwords.length, '每個角色不同');
    for (const p of passwords) assert.match(p, /^[0-9a-f]{48}$/);
    for (const [key, value] of Object.entries(config.secrets)) {
        const role = config.db[`SGN_ROLE_${key.replace('SGN_ROLE_PASSWORD_', '')}`];
        assert.ok(!value.includes(role), `${role} 的密碼和名稱無關`);
    }
    const forbidden = (program) => [
        ...Object.keys(PROGRAMS)
            .filter((q) => q !== program)
            .map(secretFile),
        join(SECRETS_DIR, 'roles.env'),
        join(dcRunDir('main'), 'keys', 'secrets.env'),
        join(dcRunDir('main'), 'keys', 'response.private.pem'),
        join(dcRunDir('unit'), 'keys', 'secrets.env'),
    ];
    for (const program of Object.keys(PROGRAMS)) {
        const user = osUser(program);
        execFileSync('setpriv', ['--reuid', user, '--regid', user, '--clear-groups', '--', 'cat', secretFile(program)], {
            stdio: 'ignore',
        });
        for (const file of forbidden(program)) {
            assert.throws(
                () => execFileSync('setpriv', ['--reuid', user, '--regid', user, '--clear-groups', '--', 'cat', file], { stdio: 'ignore' }),
                undefined,
                `${user} 讀得到 ${file}`,
            );
        }
    }
});

/** 以程式自己的帳號啟動它，等它跑起來，拍一張 heap snapshot 回來。 */
async function heapOf(program, args, ready, minMs) {
    const dir = mkdtempSync(join(tmpdir(), `sgn-heap-${program}-`));
    chmodSync(dir, 0o777);
    const user = osUser(program);
    const child = spawn(
        'setpriv',
        [
            '--reuid',
            user,
            '--regid',
            user,
            '--clear-groups',
            '--',
            'env',
            '-i',
            `PATH=${process.env.PATH}`,
            `SGN_DATABASE=${config.database}`,
            process.execPath,
            '--heapsnapshot-signal=SIGUSR2',
            join(REPO_DIR, PROGRAMS[program].entry),
            ...args,
        ],
        { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    try {
        await new Promise((r) => setTimeout(r, minMs));
        for (let i = 0; i < 100 && !ready(out); i += 1) await new Promise((r) => setTimeout(r, 100));
        assert.ok(ready(out) && child.exitCode === null, `${program} 沒有跑起來：${out}`);
        child.kill('SIGUSR2');
        let snapshot;
        for (let i = 0; i < 100 && !snapshot; i += 1) {
            await new Promise((r) => setTimeout(r, 100));
            snapshot = readdirSync(dir).find((f) => f.endsWith('.heapsnapshot') && statSync(join(dir, f)).size > 0);
            if (snapshot) await new Promise((r) => setTimeout(r, 300));
        }
        assert.ok(snapshot, `${program} 沒有寫出 heap snapshot`);
        return readFileSync(join(dir, snapshot));
    } finally {
        child.kill('SIGKILL');
        rmSync(dir, { recursive: true, force: true });
    }
}

// 交付程式在這裡連的是資料庫測試的資料庫，送的是 main 實例（它的設定）：沒有可送的交付，只確認程序起來了。
// 對帳程式會交一份 main 實例簽的回報給 sgn_test：資料庫不信任那把金鑰，回 rejected（這也是預期的）。
for (const [program, args, ready, minMs] of [
    ['api', [], (o) => o.includes('listening'), 0],
    ['delivery', ['--every', '3600'], () => true, 1500],
    ['reconciler', ['--every', '3600'], (o) => o.includes('"channel"'), 0],
]) {
    test(`架構：${program} 程序的記憶體裡沒有別的程式的密鑰、沒有資料庫管理者連線（heap snapshot）`, async () => {
        const heap = await heapOf(program, args, ready, minMs);
        let own = 0;
        for (const [value, allowed] of secretOwners()) {
            if (!value) continue;
            const present = heap.includes(Buffer.from(value));
            if (allowed.has(program)) own += present ? 1 : 0;
            else assert.ok(!present, `${program} 的記憶體裡有不屬於它的密鑰`);
        }
        assert.ok(own >= 1, '自己的密鑰在（確認快照真的涵蓋了設定）');
    });
}

test('架構：外部系統的信任清單只有對應資料庫目前那一把（沒有開發金鑰）；遮罩環境不信任任何平台金鑰；兩個平台資料庫各自一個外部系統實例', async () => {
    for (const [instance, database] of [
        ['main', config.db.SGN_DB_E2E],
        ['unit', config.db.SGN_DB_TEST],
    ]) {
        const dir = join(dcRunDir(instance), 'keys');
        const trusted = JSON.parse(readFileSync(join(dir, 'trusted-keys.json'), 'utf8')).keys.map((k) => k.key_id);
        const db = new pg.Client({ connectionString: adminUrl(config, database) });
        await db.connect();
        const current = (await db.query('select key_id from sgn.signing_key where retired_at is null')).rows.map((r) => r.key_id);
        await db.end();
        assert.deepEqual(trusted, current, `${instance} 只信任 ${database} 目前的金鑰`);
        assert.deepEqual(JSON.parse(readFileSync(join(dir, 'trusted-keys-masked.json'), 'utf8')).keys, []);
        assert.ok(!readdirSync(dir).some((f) => f.startsWith('platform-dev')), '沒有開發用的平台金鑰');
    }
    assert.ok(!existsSync(join(dcRunDir('main'), 'keys', 'platform-dev.private.pem')));
});

test('架構：sgn_e2e 簽的請求送到 sgn_test 的外部系統實例不收（反之亦然）：兩個資料庫的單號都從 1 編起，也不會互相覆蓋或撤回', async () => {
    const send = async (database, instance) => {
        const db = new pg.Client({ connectionString: adminUrl(config, database) });
        await db.connect();
        const body = (
            await db.query(
                `select sgn_internal.delivery_envelope('dc', 'DELETE', '/rule-sets/DA-2026-0001', '{"case_no": "DA-2026-0001", "request_id": "x"}', now() + interval '5 minutes') as t`,
            )
        ).rows[0].t;
        const sig = (await db.query(`select sgn_internal.delivery_sign('sgn-dc-sig/1', $1) as s`, [body])).rows[0].s;
        await db.end();
        const dc = {
            ...readEnvFile(join(REPO_DIR, 'sim/dc/service.env')),
            ...(instance === 'unit' ? readEnvFile(join(REPO_DIR, 'sim/dc/instances/unit.env')) : {}),
        };
        const res = await fetch(`http://${dc.SIM_DC_HOST}:${dc.SIM_DC_PORT}/v1/rule-sets/DA-2026-0001`, {
            method: 'DELETE',
            headers: {
                authorization: `Bearer ${dcSecrets(instance).SIM_DC_KEY_PLATFORM}`,
                'content-type': 'application/json',
                'sgn-signature': `keyid="${sig.key_id}", alg="ed25519", sig="${sig.sig}"`,
            },
            body,
        });
        return { status: res.status, body: await res.json() };
    };
    const crossA = await send(config.db.SGN_DB_E2E, 'unit');
    assert.equal(crossA.status, 401, 'unit 實例不信任 sgn_e2e 的金鑰');
    const crossB = await send(config.db.SGN_DB_TEST, 'main');
    assert.equal(crossB.status, 401, 'main 實例不信任 sgn_test 的金鑰');
});
