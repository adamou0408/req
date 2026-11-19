// 內容雜湊的標準化 JSON（PRB-CONTENT-HASH）：跨語言對照。同一份資料，資料庫（sgn_internal.jcs，PL/pgSQL）
// 算一次、Node（web/lib/jcs.js，稽核人員的瀏覽器用的同一份）算一次，位元組必須完全相同。
// 資料：RFC 8785 本文的範例、附錄 B 的 IEEE 754 數字、以及固定種子產生的大量亂數資料。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';
import { canonicalize } from '../../../web/lib/jcs.js';
import { call, closePools, login, pool, rejectsWith } from './lib/harness.mjs';

const admin = pool('ADMIN');
const app = pool('APP');
let applicant;

before(async () => {
    applicant = await login(app, 'p04');
});
after(closePools);

/** 一次把很多值交給資料庫標準化；回傳的順序與輸入相同。 */
async function dbCanonical(values) {
    const { rows } = await admin.query(
        `select sgn_internal.jcs(e.value) as text
         from jsonb_array_elements($1::jsonb) with ordinality as e (value, ord) order by e.ord`,
        [JSON.stringify(values)],
    );
    return rows.map((r) => r.text);
}

function assertSame(values) {
    return dbCanonical(values).then((fromDb) => {
        const mismatches = values
            .map((v, i) => ({ input: JSON.stringify(v), node: canonicalize(v), db: fromDb[i] }))
            .filter((m) => m.node !== m.db);
        assert.deepEqual(mismatches.slice(0, 5), [], `${mismatches.length} 筆不一致`);
    });
}

// 可重現的亂數（mulberry32），失敗時能重跑同一組資料
function random(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function doubleFromBits(rand) {
    const view = new DataView(new ArrayBuffer(8));
    view.setUint32(0, Math.floor(rand() * 2 ** 32));
    view.setUint32(4, Math.floor(rand() * 2 ** 32));
    return view.getFloat64(0);
}

function finiteDouble(rand) {
    for (;;) {
        const d = doubleFromBits(rand);
        if (Number.isFinite(d)) return d;
    }
}

// 字元池：ASCII、要跳脫的控制字元、"、\、拉丁、CJK、U+E000–U+FFFF（私用區與相容字）、補充平面（表情符號）。
// 不含 U+0000 與單獨的代理字元：jsonb 不接受。
const CHARS = [
    'a',
    'Z',
    '1',
    ' ',
    '"',
    '\\',
    '/',
    '\b',
    '\t',
    '\n',
    '\f',
    '\r',
    '\u0001',
    '\u001f',
    '\u007f',
    'é',
    'ö',
    '€',
    '中',
    '文',
    '\ue000',
    '\ufb33',
    '\uffee',
    '😀',
    '𝄞',
    '\u2028',
];

function randomString(rand) {
    const length = Math.floor(rand() * 6);
    return Array.from({ length }, () => CHARS[Math.floor(rand() * CHARS.length)]).join('');
}

function randomValue(rand, depth = 0) {
    const kind = Math.floor(rand() * (depth > 3 ? 4 : 6));
    if (kind === 0) return null;
    if (kind === 1) return rand() < 0.5;
    if (kind === 2)
        return rand() < 0.5
            ? finiteDouble(rand)
            : Math.round((rand() - 0.5) * 10 ** Math.floor(rand() * 25)) / 10 ** Math.floor(rand() * 8);
    if (kind === 3) return randomString(rand);
    if (kind === 4) return Array.from({ length: Math.floor(rand() * 4) }, () => randomValue(rand, depth + 1));
    return Object.fromEntries(Array.from({ length: Math.floor(rand() * 5) }, () => [randomString(rand), randomValue(rand, depth + 1)]));
}

test('PRB-CONTENT-HASH RFC 8785 本文的範例：資料庫的輸出與 RFC 列出的結果一字不差', async () => {
    const input =
        '{"numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],' +
        ' "string": "\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/", "literals": [null, true, false]}';
    const expected =
        '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}';
    const [fromDb] = await dbCanonical([JSON.parse(input)]);
    assert.equal(fromDb, expected);
    assert.equal(canonicalize(JSON.parse(input)), expected);
});

test('PRB-CONTENT-HASH 鍵依 UTF-16 code unit 排序（RFC 8785 3.2.3 的例子：表情符號排在 U+FB33 之前）', async () => {
    const value = {
        '€': 'Euro Sign',
        '\r': 'Carriage Return',
        '\ufb33': 'Hebrew Letter Dalet With Dagesh',
        1: 'One',
        '😀': 'Emoji: Grinning Face',
        '\u0080': 'Control',
        ö: 'Latin Small Letter O With Diaeresis',
    };
    const [fromDb] = await dbCanonical([value]);
    // 從文字取鍵的順序（JSON.parse 會把整數鍵搬到最前面，不能用）
    const keys = [...fromDb.matchAll(/"((?:[^"\\]|\\.)*)":"/g)].map((m) => JSON.parse(`"${m[1]}"`));
    assert.deepEqual(keys, ['\r', '1', '\u0080', 'ö', '€', '😀', '\ufb33']);
    assert.equal(fromDb, canonicalize(value));
});

test('PRB-CONTENT-HASH RFC 8785 附錄 B 的 IEEE 754 數字與 2000 個隨機 double：資料庫與 Node 的數字表示相同', async () => {
    const ieee = [
        '0000000000000000',
        '8000000000000000',
        '0000000000000001',
        '8000000000000001',
        '7fefffffffffffff',
        'ffefffffffffffff',
        '4340000000000000',
        'c340000000000000',
        '4430000000000000',
        '44b52d02c7e14af5',
        '44b52d02c7e14af6',
        '44b52d02c7e14af7',
        '444b1ae4d6e2ef4e',
        '444b1ae4d6e2ef4f',
        '444b1ae4d6e2ef50',
        '3eb0c6f7a0b5ed8c',
        '3eb0c6f7a0b5ed8d',
        '41b3de4355555553',
        '41b3de4355555554',
        '41b3de4355555555',
        '41b3de4355555556',
        '41b3de4355555557',
        'becbf647612f3696',
        '43143ff3c1cb0959',
    ].map((hex) => Buffer.from(hex, 'hex').readDoubleBE(0));
    const rand = random(8785);
    const randomDoubles = Array.from({ length: 2000 }, () => finiteDouble(rand));
    // 排版的邊界：10^20、10^21、10^-6、10^-7 附近
    const boundaries = [1e20, 1e21, 123456789012345680000, 1e-6, 1e-7, 0.000001234, 1.5e-7, 2 ** 53, 2 ** 53 + 2, -1e21, 100, 0.1, 0.5];
    await assertSame([...ieee, ...boundaries, ...randomDoubles]);
});

test('PRB-CONTENT-HASH 3000 份隨機的巢狀 JSON（跳脫字元、補充平面字元、空物件與空陣列）：資料庫與 Node 逐位元組相同', async () => {
    const rand = random(20261119);
    const values = Array.from({ length: 3000 }, () => randomValue(rand));
    values.push({}, [], { '': '' }, { a: {}, b: [] }, [[[]]]);
    await assertSame(values);
});

test('PRB-CONTENT-HASH 申請單的內容雜湊＝sha256(標準化 JSON)：資料庫以外的程式從回傳的內容就算得出相同的值', async () => {
    const content = { 目的: '流失分析', z: [1, 2.5, 1e21], a: { '😀': true, é: null }, rows: 100000 };
    const submitted = await call(app, 'case_submit_new', applicant.session, content);
    const expected = createHash('sha256').update(canonicalize(submitted.content), 'utf8').digest('hex');
    assert.equal(submitted.content_sha256, expected);
    // jsonb 的文字輸出（舊做法）不是標準化的結果：鍵依長度排序、有空白
    const { rows } = await admin.query('select $1::jsonb::text as t', [JSON.stringify(content)]);
    assert.notEqual(rows[0].t, canonicalize(content));
});

test('PRB-CONTENT-HASH 超出 IEEE 754 double 範圍的數字無法標準化 → CONTENT_NOT_CANONICAL，單不會建立', async () => {
    const before = (await call(app, 'case_list_mine', applicant.session)).length;
    await rejectsWith(app.query(`select api.case_submit_new($1, '{"n": 1e400}'::jsonb)`, [applicant.session]), 'CONTENT_NOT_CANONICAL');
    await rejectsWith(app.query(`select api.case_submit_new($1, '{"n": 1e-400}'::jsonb)`, [applicant.session]), 'CONTENT_NOT_CANONICAL');
    assert.equal((await call(app, 'case_list_mine', applicant.session)).length, before);
});
