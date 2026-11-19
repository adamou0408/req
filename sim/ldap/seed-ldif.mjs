#!/usr/bin/env node
// 從 docs/contract/seed-directory.md 產生 LDAP 的種子資料（LDIF）。
// 人員、單位、角色只從那份文件的表格讀出，這裡不寫任何名單。
//
// 用法：node seed-ldif.mjs ldif          輸出完整 LDIF 到標準輸出
//       node seed-ldif.mjs people-count  輸出文件裡的人數（健康檢查用）
// 設定由環境變數帶入（start.sh 會載入 service.env 與 test-credentials.env）。

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SECTION_PEOPLE = '組織與人員';
const SECTION_ROLES = '角色指派';
const NO_MANAGER = '—';
const TYPE_SINGLE_HOLDER = '單一持有人';
const TYPE_SCOPED = '依範圍';
// 目錄裡由角色衍生出來的群組，用這兩個分類與角色本身的類型區分。
const CATEGORY_DEPUTY = '代理人';
const CATEGORY_SCOPE = '範圍';
const DEFAULT_SEED_FILE = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../docs/contract/seed-directory.md',
);

function fail(message) {
    process.stderr.write(`seed-ldif: ${message}\n`);
    process.exit(1);
}

function requireEnv(name) {
    const value = process.env[name];
    if (!value) fail(`缺少環境變數 ${name}`);
    return value;
}

/** 把 Markdown 依「## 標題」切段，回傳 標題 → 該段第一張表格的列（以表頭為鍵的物件）。 */
function parseTables(markdown) {
    const tables = new Map();
    let heading = null;
    let header = null;
    for (const line of markdown.split('\n')) {
        const headingMatch = /^##\s+(.+?)\s*$/.exec(line);
        if (headingMatch) {
            heading = headingMatch[1];
            header = null;
            continue;
        }
        if (heading === null || !line.trim().startsWith('|')) continue;
        const cells = line
            .trim()
            .replace(/^\||\|$/g, '')
            .split('|')
            .map((cell) => cell.trim().replace(/^`(.*)`$/, '$1'));
        if (cells.every((cell) => /^:?-+:?$/.test(cell))) continue;
        if (header === null) {
            header = cells;
            tables.set(heading, []);
            continue;
        }
        tables.get(heading).push(Object.fromEntries(header.map((key, i) => [key, cells[i] ?? ''])));
    }
    return tables;
}

function requireTable(tables, heading, columns) {
    const rows = tables.get(heading);
    if (!rows || rows.length === 0) fail(`種子文件缺少「${heading}」的表格`);
    for (const column of columns) {
        if (!(column in rows[0])) fail(`「${heading}」缺少欄位「${column}」`);
    }
    return rows;
}

function readPeople(tables) {
    const rows = requireTable(tables, SECTION_PEOPLE, ['代號', '姓名', '單位', '職稱', '直屬主管']);
    const people = rows.map((row) => {
        const number = /^p(\d+)$/.exec(row['代號']);
        if (!number) fail(`人員代號格式不符：${row['代號']}`);
        return {
            uid: row['代號'],
            employeeNumber: `E${number[1].padStart(4, '0')}`,
            name: row['姓名'],
            unit: row['單位'],
            title: row['職稱'],
            managerName: row['直屬主管'] === NO_MANAGER ? null : row['直屬主管'],
        };
    });
    const byName = new Map();
    for (const person of people) {
        if (byName.has(person.name)) fail(`姓名重複，無法用姓名對應：${person.name}`);
        byName.set(person.name, person);
    }
    for (const person of people) {
        if (person.managerName === null) continue;
        person.manager = byName.get(person.managerName) ?? fail(`找不到主管：${person.managerName}`);
    }
    return { people, byName };
}

/**
 * 種子文件沒有另外列組織樹，所以由主管關係推出：
 * 單位裡向外單位主管報告的人，其主管所在的單位就是上層單位；沒有這種人的是最上層。
 */
function readUnits(people) {
    const units = new Map();
    for (const person of people) {
        if (!units.has(person.unit)) units.set(person.unit, { name: person.unit, parents: new Set() });
        if (person.manager && person.manager.unit !== person.unit) {
            units.get(person.unit).parents.add(person.manager.unit);
        }
    }
    for (const unit of units.values()) {
        if (unit.parents.size > 1) {
            fail(`單位「${unit.name}」推得多個上層單位：${[...unit.parents].join('、')}`);
        }
        unit.parent = unit.parents.size === 1 ? units.get([...unit.parents][0]) : null;
    }
    const depth = (unit, seen = new Set()) => {
        if (seen.has(unit)) fail(`單位的上下層關係形成循環：${unit.name}`);
        return unit.parent ? 1 + depth(unit.parent, seen.add(unit)) : 0;
    };
    // 上層單位要先建立，LDAP 才能新增下層。
    return [...units.values()].sort((a, b) => depth(a) - depth(b));
}

function readRoleGroups(tables, byName) {
    const rows = requireTable(tables, SECTION_ROLES, ['角色', '代碼', '類型', '持有人']);
    const person = (name) => byName.get(name.trim()) ?? fail(`角色持有人不在人員名單：${name}`);
    const groups = [];
    for (const row of rows) {
        const role = { cn: row['代碼'], description: row['角色'], category: row['類型'] };
        if (row['類型'] === TYPE_SINGLE_HOLDER) {
            const match = /^(.+?)(?:（代理人：(.+)）)?$/.exec(row['持有人']);
            groups.push({ ...role, members: [person(match[1])] });
            if (match[2]) {
                groups.push({
                    cn: `${role.cn}_deputy`,
                    description: `${role.description}${CATEGORY_DEPUTY}`,
                    category: CATEGORY_DEPUTY,
                    parent: role.cn,
                    members: [person(match[2])],
                });
            }
        } else if (row['類型'] === TYPE_SCOPED) {
            const scopes = row['持有人'].split('；').map((part) => {
                const [scope, holder] = part.split('：');
                if (!scope || !holder) fail(`無法解析依範圍的持有人：${part}`);
                return { scope: scope.trim(), holder: person(holder) };
            });
            groups.push({ ...role, members: [...new Set(scopes.map((s) => s.holder))] });
            for (const { scope, holder } of scopes) {
                groups.push({
                    cn: `${role.cn}:${scope}`,
                    description: `${role.description}：${scope}`,
                    category: CATEGORY_SCOPE,
                    parent: role.cn,
                    scope,
                    members: [holder],
                });
            }
        } else {
            groups.push({ ...role, members: row['持有人'].split('、').map(person) });
        }
    }
    return groups;
}

function escapeRdnValue(value) {
    return value.replace(/[,+"\\<>;=]/g, '\\$&').replace(/^[ #]|[ ]$/g, '\\$&');
}

/** LDIF 的一行；值含非 ASCII 或不安全的開頭時用 base64（RFC 2849）。 */
function line(attribute, value) {
    const safe = /^[\x21-\x39\x3b\x3d-\x7e][\x20-\x7e]*$/.test(value) && !value.endsWith(' ');
    return safe
        ? `${attribute}: ${value}`
        : `${attribute}:: ${Buffer.from(value, 'utf8').toString('base64')}`;
}

function entry(dn, attributes) {
    const lines = [line('dn', dn)];
    for (const [attribute, value] of attributes) {
        if (value !== null && value !== undefined) lines.push(line(attribute, value));
    }
    return lines.join('\n');
}

function renderLdif({ people, units, groups }) {
    const baseDn = requireEnv('SIM_LDAP_BASE_DN');
    const peopleDn = requireEnv('SIM_LDAP_PEOPLE_DN');
    const groupsDn = requireEnv('SIM_LDAP_GROUPS_DN');
    const orgDn = requireEnv('SIM_LDAP_ORG_DN');
    const readerDn = requireEnv('SIM_LDAP_READER_DN');
    const mailDomain = requireEnv('SIM_LDAP_MAIL_DOMAIN');
    const userPassword = requireEnv('SIM_LDAP_USER_PASSWORD');
    const readerPassword = requireEnv('SIM_LDAP_READER_PASSWORD');

    const rdnValue = (dn) => /^[^=]+=([^,]+)/.exec(dn)[1];
    const container = (dn) => entry(dn, [['objectClass', 'organizationalUnit'], ['ou', rdnValue(dn)]]);
    const personDn = (person) => `uid=${person.uid},${peopleDn}`;
    const groupDn = (cn) => `cn=${escapeRdnValue(cn)},${groupsDn}`;
    const unitDn = (unit) =>
        `ou=${escapeRdnValue(unit.name)},${unit.parent ? unitDn(unit.parent) : orgDn}`;
    const servicesDn = readerDn.slice(readerDn.indexOf(',') + 1);
    const policiesDn = `ou=policies,${baseDn}`;

    const entries = [
        entry(baseDn, [
            ['objectClass', 'dcObject'],
            ['objectClass', 'organization'],
            ['dc', rdnValue(baseDn)],
            ['o', 'sgn sim directory'],
        ]),
        ...[peopleDn, groupsDn, orgDn, servicesDn, policiesDn].map(container),
        // 預設密碼政策：開啟鎖定功能才能用 pwdAccountLockedTime 停用帳號；
        // pwdMaxFailure 0 表示打錯密碼不會自動鎖定，測試錯誤密碼不會把人鎖住。
        entry(`cn=default,${policiesDn}`, [
            ['objectClass', 'organizationalRole'],
            ['objectClass', 'pwdPolicy'],
            ['cn', 'default'],
            ['pwdAttribute', 'userPassword'],
            ['pwdLockout', 'TRUE'],
            ['pwdMaxFailure', '0'],
        ]),
        entry(readerDn, [
            ['objectClass', 'organizationalRole'],
            ['objectClass', 'simpleSecurityObject'],
            ['cn', rdnValue(readerDn)],
            ['description', 'read-only bind account for the IdP and the platform directory adapter'],
            ['userPassword', readerPassword],
        ]),
        ...units.map((unit) =>
            entry(unitDn(unit), [['objectClass', 'organizationalUnit'], ['ou', unit.name]]),
        ),
        ...people.map((person) => {
            const mail = `${person.uid}@${mailDomain}`;
            return entry(personDn(person), [
                ['objectClass', 'inetOrgPerson'],
                ['objectClass', 'simAccount'],
                ['uid', person.uid],
                ['cn', person.name],
                // 種子名單都是單姓；姓名拆成 sn 與 givenName 只為了滿足 inetOrgPerson 的必填欄位。
                ['sn', person.name.slice(0, 1)],
                ['givenName', person.name.slice(1)],
                ['displayName', person.name],
                ['mail', mail],
                ['title', person.title],
                ['employeeNumber', person.employeeNumber],
                ['employeeType', 'active'],
                ['ou', person.unit],
                ['manager', person.manager ? personDn(person.manager) : null],
                ['simLoginName', person.uid],
                ['simLoginName', mail],
                ['userPassword', userPassword],
            ]);
        }),
        ...groups.map((group) =>
            entry(groupDn(group.cn), [
                ['objectClass', 'groupOfNames'],
                ['cn', group.cn],
                ['description', group.description],
                ['businessCategory', group.category],
                ['ou', group.scope],
                ['seeAlso', group.parent ? groupDn(group.parent) : null],
                ...group.members.map((member) => ['member', personDn(member)]),
            ]),
        ),
    ];
    return `${entries.join('\n\n')}\n`;
}

const mode = process.argv[2];
const seedFile = process.env.SIM_SEED_DIRECTORY_FILE || DEFAULT_SEED_FILE;
const tables = parseTables(readFileSync(seedFile, 'utf8'));
const { people, byName } = readPeople(tables);

if (mode === 'people-count') {
    process.stdout.write(`${people.length}\n`);
} else if (mode === 'ldif') {
    const units = readUnits(people);
    const groups = readRoleGroups(tables, byName);
    process.stdout.write(renderLdif({ people, units, groups }));
} else {
    fail('用法：node seed-ldif.mjs ldif|people-count');
}
