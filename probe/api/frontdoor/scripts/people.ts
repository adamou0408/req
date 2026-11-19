// 命令列：讀 sim 的 LDAP，印出人員、主管關係與群組（JSON）。
// 用法：node scripts/people.ts [--summary]
import { loadLdapConfig } from '../src/config.ts';
import { readDirectory } from '../src/people.ts';

const directory = await readDirectory(loadLdapConfig());
if (process.argv.includes('--summary')) {
    for (const person of directory.people) {
        const manager = person.managerUid ?? '—';
        console.log(`${person.uid}\t${person.name}\t${person.unit}\t${person.title}\t主管=${manager}\t${person.status}\t${person.groups.join(',')}`);
    }
    console.log(`共 ${directory.people.length} 人、${directory.groups.length} 個群組`);
} else {
    console.log(JSON.stringify(directory, null, 2));
}
