// 人員與組織 port 的 LDAP adapter：以唯讀帳號讀出人員、主管關係與群組，轉成簡單的 JSON。
// 不寫資料庫；之後由同步程式把結果交給資料庫。
import { Client, type Entry } from 'ldapts';
import type { LdapConfig } from './config.ts';

export interface Person {
    uid: string;
    name: string;
    email: string;
    title: string;
    employeeNumber: string;
    /** active／terminated（LDAP 的 employeeType）。 */
    status: string;
    unit: string;
    /** 直屬主管的 uid；沒有主管為 null。 */
    managerUid: string | null;
    groups: string[];
}

export interface Group {
    code: string;
    name: string;
    /** 持有方式（種子文件的「類型」）。 */
    kind: string;
    /** 依範圍的角色：範圍名稱；代理人群組：被代理的角色代碼。 */
    scope: string | null;
    refersTo: string | null;
    members: string[];
}

export interface Directory {
    readAt: string;
    people: Person[];
    groups: Group[];
}

function text(entry: Entry, attribute: string): string {
    const value = entry[attribute];
    const first = Array.isArray(value) ? value[0] : value;
    return first === undefined ? '' : first.toString();
}

function list(entry: Entry, attribute: string): string[] {
    const value = entry[attribute];
    if (value === undefined) return [];
    return (Array.isArray(value) ? value : [value]).map((item) => item.toString());
}

/** 從 DN 取第一個 RDN 的值，例如 uid=p03,ou=people,... → p03。 */
function rdnValue(dn: string): string {
    return dn.split(',')[0].split('=').slice(1).join('=');
}

function toPerson(entry: Entry): Person {
    const manager = text(entry, 'manager');
    return {
        uid: text(entry, 'uid'),
        name: text(entry, 'displayName') || text(entry, 'cn'),
        email: text(entry, 'mail'),
        title: text(entry, 'title'),
        employeeNumber: text(entry, 'employeeNumber'),
        status: text(entry, 'employeeType'),
        unit: text(entry, 'ou'),
        managerUid: manager ? rdnValue(manager) : null,
        groups: list(entry, 'memberOf').map(rdnValue).sort(),
    };
}

function toGroup(entry: Entry): Group {
    const seeAlso = text(entry, 'seeAlso');
    return {
        code: text(entry, 'cn'),
        name: text(entry, 'description'),
        kind: text(entry, 'businessCategory'),
        scope: text(entry, 'ou') || null,
        refersTo: seeAlso ? rdnValue(seeAlso) : null,
        members: list(entry, 'member').map(rdnValue).sort(),
    };
}

export async function readDirectory(config: LdapConfig): Promise<Directory> {
    const client = new Client({ url: config.url, timeout: 10_000, connectTimeout: 5_000 });
    try {
        await client.bind(config.bindDn, config.bindPassword);
        const people = await client.search(config.peopleDn, {
            scope: 'one',
            filter: '(objectClass=inetOrgPerson)',
            attributes: ['uid', 'cn', 'displayName', 'mail', 'title', 'employeeNumber', 'employeeType', 'ou', 'manager', 'memberOf'],
        });
        const groups = await client.search(config.groupsDn, {
            scope: 'one',
            filter: '(objectClass=groupOfNames)',
            attributes: ['cn', 'description', 'businessCategory', 'ou', 'seeAlso', 'member'],
        });
        const byKey = <T>(key: (item: T) => string) => (a: T, b: T) => key(a).localeCompare(key(b));
        return {
            readAt: new Date().toISOString(),
            people: people.searchEntries.map(toPerson).sort(byKey((p) => p.uid)),
            groups: groups.searchEntries.map(toGroup).sort(byKey((g) => g.code)),
        };
    } finally {
        await client.unbind();
    }
}
