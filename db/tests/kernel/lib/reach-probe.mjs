// 架構測試 97 的探測程式：由測試以某個程式的作業系統帳號（setpriv）執行，回報「這個帳號實際讀得到、連得到什麼」。
// 只用 Node 內建模組與 repo 的 pg 套件。輸入（stdin，JSON）：{ repo, secrets: [{ id, value }], roots, dbTargets, ldapTargets }。
// 輸出（stdout 最後一行，JSON）：{ uid, found: { 秘密 id: [檔案…] }, db: { 名稱: 結果 }, ldap: { 名稱: 結果 } }。
// 秘密的值只在記憶體裡比對，輸出只帶 id。
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const MAX_FILE = 8 * 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules', '.git']);

const input = JSON.parse(readFileSync(0, 'utf8'));
const pg = createRequire(join(input.repo, 'package.json'))('pg');
const needles = input.secrets.filter((s) => s.value).map((s) => ({ id: s.id, bytes: Buffer.from(s.value) }));

/** 走過一個目錄樹：讀得到的檔案逐一找秘密的值（讀不到的目錄與檔案略過——那正是要證明的）。 */
function scan(dir, found) {
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const e of entries) {
        const path = join(dir, e.name);
        if (e.isDirectory()) {
            if (!SKIP_DIRS.has(e.name)) scan(path, found);
            continue;
        }
        if (!e.isFile()) continue;
        let data;
        try {
            if (lstatSync(path).size > MAX_FILE) continue;
            data = readFileSync(path);
        } catch {
            continue;
        }
        for (const n of needles) if (data.includes(n.bytes)) (found[n.id] ??= []).push(path);
    }
}

async function tryDb(url) {
    const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
    try {
        await c.connect();
        const r = await c.query('select current_user as who, (select rolsuper from pg_roles where rolname = current_user) as super');
        return { connected: true, ...r.rows[0] };
    } catch (err) {
        return { connected: false, code: err.code ?? err.message };
    } finally {
        await c.end().catch(() => {});
    }
}

function tryLdap({ url, dn, password }) {
    try {
        execFileSync('ldapwhoami', ['-x', '-H', url, '-o', 'nettimeout=5', '-D', dn, '-w', password], { stdio: 'ignore' });
        return { bound: true };
    } catch {
        return { bound: false };
    }
}

const found = {};
for (const root of input.roots) scan(root, found);
const db = {};
for (const [name, url] of Object.entries(input.dbTargets)) db[name] = await tryDb(url);
const ldap = {};
for (const [name, target] of Object.entries(input.ldapTargets)) ldap[name] = tryLdap(target);
console.log(JSON.stringify({ uid: process.getuid(), found, db, ldap }));
