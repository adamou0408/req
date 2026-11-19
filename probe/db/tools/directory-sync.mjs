#!/usr/bin/env node
// 從 sim 的 LDAP 讀人員、主管與群組（真的連線），以 sgn_probe_sync 角色交給 api_sync.directory_apply。
// 這支工具只能執行 api_sync 的 function，碰不到任何資料表或決定類 function。
import { Client as LdapClient } from 'ldapts';
import pg from 'pg';
import { loadConfig, roleUrl } from './lib/env.mjs';

const uidFromDn = (dn) => /^uid=([^,]+),/i.exec(dn)?.[1] ?? null;
const SOURCE = 'sim-ldap';

export async function readDirectory(config) {
    const { ldap } = config;
    const client = new LdapClient({ url: ldap.SIM_LDAP_URL });
    try {
        await client.bind(ldap.SIM_LDAP_READER_DN, ldap.SIM_LDAP_READER_PASSWORD);
        const { searchEntries: people } = await client.search(ldap.SIM_LDAP_PEOPLE_DN, {
            scope: 'one',
            filter: '(objectClass=inetOrgPerson)',
            attributes: ['uid', 'displayName', 'cn', 'mail', 'employeeType', 'manager'],
        });
        const { searchEntries: groups } = await client.search(ldap.SIM_LDAP_GROUPS_DN, {
            scope: 'one',
            filter: '(objectClass=groupOfNames)',
            attributes: ['cn', 'member'],
        });
        const rolesByUid = new Map();
        for (const group of groups) {
            for (const member of [group.member].flat()) {
                const uid = uidFromDn(String(member));
                if (!uid) continue;
                rolesByUid.set(uid, [...(rolesByUid.get(uid) ?? []), String(group.cn)]);
            }
        }
        return people.map((entry) => ({
            external_id: String(entry.uid),
            display_name: String(entry.displayName || entry.cn),
            email: String(entry.mail),
            active: String(entry.employeeType) === 'active',
            manager_external_id: entry.manager ? uidFromDn(String(entry.manager)) : null,
            roles: (rolesByUid.get(String(entry.uid)) ?? []).sort(),
        }));
    } finally {
        await client.unbind();
    }
}

export async function syncDirectory(config = loadConfig()) {
    const entries = await readDirectory(config);
    const db = new pg.Client({ connectionString: roleUrl(config, 'SYNC') });
    await db.connect();
    try {
        const { rows } = await db.query('select api_sync.directory_apply($1, $2) as result', [
            SOURCE,
            JSON.stringify(entries),
        ]);
        return rows[0].result;
    } finally {
        await db.end();
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const result = await syncDirectory();
    console.log(JSON.stringify(result));
}
