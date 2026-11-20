// 架構測試：以各程式自己的作業系統帳號實際探測「讀得到、連得到什麼」（裁決 D84 (1)；紅隊第五輪 高-1、中-5，redteam/exploits/20、33）。
// 95 檢查密鑰檔本身；這裡檢查的是整台主機上「別的地方」：管理者連線、模擬身分提供者的私鑰、LDAP 的密碼、整庫備份、log。
// 探測程式（lib/reach-probe.mjs）以 setpriv 成該帳號執行：掃 repo 與 sim/.run 底下每個讀得到的檔案找任何一個密鑰的值，
// 試連資料庫的管理者（本機 peer、環境原有帳號的已知密碼）與 LDAP（舊的已知密碼）。
// 「拿掉防法就失敗」：admin.env 換回 das_dev 的已知密碼或 pg_hba 不拒絕 superuser 的 TCP 登入（db 那一段）、sim/.run/idp 或 ldap 的目錄
// 放寬（Dex 私鑰、LDAP 密碼被掃到）、備份檔或 log 放寬（被掃到或讀得到），都會失敗。同樣的探測以 root 跑一次當對照組（證明掃得到、連得到）。
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { PROGRAMS, osUser } from '../../tools/lib/programs.mjs';
import { REPO_DIR, RUN_DIR, SECRETS_DIR, adminUrl, dcRunDir, readEnvFile, simRunDir } from '../../tools/lib/env.mjs';
import { closePools, config } from './lib/harness.mjs';

after(closePools);

const PROBE = join(REPO_DIR, 'db', 'tests', 'kernel', 'lib', 'reach-probe.mjs');

/** Dex 的 sqlite 檔裡的私鑰（有 d 的 RSA JWK）：任何程式的帳號都不得讀到它的 d。 */
function dexPrivateExponents() {
    const text = readFileSync(join(simRunDir('idp'), 'dex.db')).toString('latin1');
    const out = [];
    for (const m of text.matchAll(/\{"use":"sig","kty":"RSA"[^{}]*\}/g)) {
        try {
            const k = JSON.parse(m[0]);
            if (k.d) out.push(k.d);
        } catch {
            // 不完整的片段
        }
    }
    return out;
}

/** 每一個密鑰：{id, value, owners（可以有它的程式）}。 */
function secrets() {
    const list = [];
    const add = (id, value, owners = []) => value && list.push({ id, value, owners: new Set(owners) });
    for (const [key, value] of Object.entries(config.secrets)) {
        const roleKey = key.replace('SGN_ROLE_PASSWORD_', '');
        add(
            key,
            value,
            Object.entries(PROGRAMS)
                .filter(([, d]) => d.roleKey === roleKey)
                .map(([p]) => p),
        );
    }
    const main = readEnvFile(join(dcRunDir('main'), 'keys', 'secrets.env'));
    add('dc.platform', main.SIM_DC_KEY_PLATFORM, ['delivery']);
    add('dc.auditor', main.SIM_DC_KEY_AUDITOR, ['reconciler']);
    add('dc.admin', main.SIM_DC_KEY_ADMIN);
    add('dc.service', main.SIM_DC_SERVICE_PASSWORD);
    for (const [k, v] of Object.entries(readEnvFile(join(dcRunDir('unit'), 'keys', 'secrets.env')))) add(`dc-unit.${k}`, v);
    const pem = readFileSync(join(dcRunDir('main'), 'keys', 'response.private.pem'), 'utf8').split('\n')[1];
    add('dc.response_private_key', pem);
    add('idp.client_secret', config.idp.SIM_IDP_CLIENT_SECRET, ['api']);
    add('ldap.admin', config.ldap.SIM_LDAP_ADMIN_PASSWORD);
    add('ldap.reader', config.ldap.SIM_LDAP_READER_PASSWORD);
    add('ldap.user', config.ldap.SIM_LDAP_USER_PASSWORD);
    dexPrivateExponents().forEach((d, i) => add(`idp.dex_private_key_${i}`, d));
    add('anchor.write_key', readEnvFile(join(SECRETS_DIR, 'anchor.env')).SGN_ANCHOR_WRITE_KEY, ['anchor']);
    return list;
}

const pgHost = `${config.db.SGN_PG_HOST}:${config.db.SGN_PG_PORT}`;
const dbTargets = {
    admin_peer: adminUrl(config, config.db.SGN_DB_E2E),
    das_dev_known_password: `postgres://das_dev:das_dev@${pgHost}/${config.db.SGN_DB_E2E}`,
    postgres_no_password: `postgres://postgres@${pgHost}/postgres`,
    postgres_known_password: `postgres://postgres:postgres@${pgHost}/postgres`,
    postgres_peer: 'postgres://postgres@%2Fvar%2Frun%2Fpostgresql/postgres',
    das_dev_peer: 'postgres://das_dev@%2Fvar%2Frun%2Fpostgresql/postgres',
};
const ldapUrl = config.ldap.SIM_LDAP_URL;
// sim 第五輪之前寫在 repo 裡的密碼（git 的歷史裡仍查得到）：現在都不能用
const ldapTargets = {
    admin_old_known: { url: ldapUrl, dn: config.ldap.SIM_LDAP_ADMIN_DN, password: 'sim-admin-pass' },
    reader_old_known: { url: ldapUrl, dn: config.ldap.SIM_LDAP_READER_DN, password: 'sim-reader-pass' },
    user_old_known: { url: ldapUrl, dn: `uid=p04,${config.ldap.SIM_LDAP_PEOPLE_DN}`, password: 'sim-user-pass' },
};

function probeAs(user, list, extra = {}) {
    const args =
        user === 'root'
            ? [process.execPath, PROBE]
            : ['setpriv', '--reuid', user, '--regid', user, '--clear-groups', '--', process.execPath, PROBE];
    const input = JSON.stringify({
        repo: REPO_DIR,
        secrets: list.map(({ id, value }) => ({ id, value })),
        roots: [REPO_DIR],
        dbTargets,
        ldapTargets: { ...ldapTargets, ...extra },
    });
    const r = spawnSync(args[0], args.slice(1), { input, encoding: 'utf8', timeout: 300000, maxBuffer: 16 << 20 });
    assert.equal(r.status, 0, `探測失敗（${user}）：${r.stderr}`);
    return JSON.parse(r.stdout.trim().split('\n').pop());
}

test('架構（對照組）：同樣的探測以 root 跑：掃得到 Dex 私鑰與 LDAP 密碼、連得上本機 peer 的管理者；已知密碼與 superuser 的 TCP 登入連 root 也不行', () => {
    const list = secrets();
    const out = probeAs('root', list, {
        admin_current: { url: ldapUrl, dn: config.ldap.SIM_LDAP_ADMIN_DN, password: config.ldap.SIM_LDAP_ADMIN_PASSWORD },
    });
    for (const id of ['ldap.admin', 'idp.dex_private_key_0', 'SGN_ROLE_PASSWORD_APP', 'dc.platform'])
        assert.ok(out.found[id], `root 掃得到 ${id}`);
    assert.deepEqual([out.db.admin_peer.connected, out.db.admin_peer.super], [true, true], '管理者連線只限本機 peer：root 連得上');
    for (const name of ['das_dev_known_password', 'postgres_no_password', 'postgres_known_password']) {
        assert.equal(out.db[name].connected, false, `${name}：superuser 不得經 TCP 以密碼登入（root 也不行）`);
    }
    assert.equal(out.ldap.admin_current.bound, true, 'LDAP 管理者的密碼是執行期隨機產生的那一個');
    for (const name of Object.keys(ldapTargets)) assert.equal(out.ldap[name].bound, false, `${name}：舊的已知密碼不能用`);
});

for (const program of Object.keys(PROGRAMS)) {
    test(`架構（裁決 D84 (1)）：以 ${osUser(program)} 實際探測——讀得到的檔案裡沒有別人的密鑰（Dex 私鑰、LDAP 密碼、角色密碼…）；連不上資料庫管理者；LDAP 沒有可用的已知密碼`, () => {
        const list = secrets();
        const out = probeAs(osUser(program), list);
        assert.equal(out.uid, Number(execFileSync('id', ['-u', osUser(program)], { encoding: 'utf8' })), '探測確實以這個帳號執行');
        const leaks = Object.entries(out.found)
            .filter(([id]) => !list.find((s) => s.id === id).owners.has(program))
            .map(([id, files]) => `${id}：${files.join(', ')}`);
        assert.deepEqual(leaks, [], `${program} 讀得到不屬於它的密鑰`);
        for (const [name, result] of Object.entries(out.db))
            assert.equal(result.connected, false, `${program} 連得上 ${name}：${JSON.stringify(result)}`);
        for (const [name, result] of Object.entries(out.ldap)) assert.equal(result.bound, false, `${program} 能以 ${name} bind LDAP`);
    });
}

test('架構（裁決 D84 (1)）：整庫備份、各程式的 log、管理者連線設定、sim 的執行期目錄，只有 root 讀得到', () => {
    const files = [
        join(REPO_DIR, 'db', 'admin.env'),
        join(simRunDir('idp'), 'dex.db'),
        join(simRunDir('idp'), 'secrets.env'),
        join(simRunDir('idp'), 'config.yaml'),
        join(simRunDir('ldap'), 'secrets.env'),
        join(simRunDir('ldap'), 'seed.ldif'),
        ...readdirSync(RUN_DIR)
            .filter((f) => f.endsWith('.dump') || f.endsWith('.log'))
            .map((f) => join(RUN_DIR, f)),
    ];
    assert.ok(
        files.some((f) => f.endsWith('.dump')),
        '資料庫測試留下了整庫備份（60-chain）',
    );
    for (const program of Object.keys(PROGRAMS)) {
        const user = osUser(program);
        for (const file of files) {
            const r = spawnSync('setpriv', ['--reuid', user, '--regid', user, '--clear-groups', '--', 'cat', file], { stdio: 'ignore' });
            assert.notEqual(r.status, 0, `${user} 讀得到 ${file}`);
        }
    }
});
