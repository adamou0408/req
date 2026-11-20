// QR 碼（ISO/IEC 18004）的產生器，只做通行金鑰登記要用的那一種：第 4 版（33×33）、錯誤更正 M、英數模式。
// 新裝置的畫面用它顯示完整指紋，背書人的手機相機掃描（裁決 D76）。只有一種用途、固定版本，所以自己寫，
// 不加套件（docs/handoff/leftovers-1.md 說明為什麼超過 30 行還是自己寫）。
// 正確性：db/tests/kernel/89-qr.test.mjs 與參考實作（segno）產生的矩陣逐格比對。

const VERSION = 4;
const SIZE = VERSION * 4 + 17;
const DATA_CODEWORDS = 64; // 第 4 版 M：2 個區塊，各 32 個資料碼字、18 個更正碼字
const BLOCKS = 2;
const EC_PER_BLOCK = 18;
const ALIGNMENT = [6, 26];
const ALPHANUMERIC = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
const EC_LEVEL_M = 0;

/** 通行金鑰指紋放進 QR 碼的文字（英數模式只有大寫）。 */
export const fingerprintPayload = (fingerprint) => `SGN:${fingerprint.toUpperCase()}`;

/** 掃到的文字還原成指紋；不是這個格式就回傳 null。 */
export function fingerprintFromPayload(text) {
    const m = /^SGN:([0-9A-F]{64})$/.exec(String(text ?? '').trim());
    return m ? m[1].toLowerCase() : null;
}

function gfMultiply(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
        z = (z << 1) ^ ((z >>> 7) * 0x11d);
        z ^= ((y >>> i) & 1) * x;
    }
    return z;
}

function rsDivisor(degree) {
    const result = new Array(degree).fill(0);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
        for (let j = 0; j < degree; j++) {
            result[j] = gfMultiply(result[j], root);
            if (j + 1 < degree) result[j] ^= result[j + 1];
        }
        root = gfMultiply(root, 0x02);
    }
    return result;
}

function rsRemainder(data, divisor) {
    const result = new Array(divisor.length).fill(0);
    for (const b of data) {
        const factor = b ^ result.shift();
        result.push(0);
        divisor.forEach((coef, i) => (result[i] ^= gfMultiply(coef, factor)));
    }
    return result;
}

/** 英數模式的資料碼字（含結尾、補位）。 */
function dataCodewords(text) {
    const bits = [];
    const put = (value, length) => {
        for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
    };
    const codes = [...text].map((c) => {
        const v = ALPHANUMERIC.indexOf(c);
        if (v < 0) throw new RangeError(`QR 英數模式不能放「${c}」`);
        return v;
    });
    put(0b0010, 4);
    put(codes.length, 9);
    for (let i = 0; i + 1 < codes.length; i += 2) put(codes[i] * 45 + codes[i + 1], 11);
    if (codes.length % 2) put(codes.at(-1), 6);
    const capacity = DATA_CODEWORDS * 8;
    if (bits.length > capacity) throw new RangeError('內容太長，第 4 版放不下');
    put(0, Math.min(4, capacity - bits.length));
    while (bits.length % 8) bits.push(0);
    const bytes = [];
    for (let i = 0; i < bits.length; i += 8) bytes.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
    for (let pad = 0xec; bytes.length < DATA_CODEWORDS; pad ^= 0xec ^ 0x11) bytes.push(pad);
    return bytes;
}

/** 資料碼字分區塊、加上更正碼字、交錯排列。 */
function finalCodewords(data) {
    const divisor = rsDivisor(EC_PER_BLOCK);
    const size = DATA_CODEWORDS / BLOCKS;
    const blocks = Array.from({ length: BLOCKS }, (_, b) => data.slice(b * size, (b + 1) * size));
    const ecc = blocks.map((block) => rsRemainder(block, divisor));
    const out = [];
    for (let i = 0; i < size; i++) blocks.forEach((block) => out.push(block[i]));
    for (let i = 0; i < EC_PER_BLOCK; i++) ecc.forEach((block) => out.push(block[i]));
    return out;
}

/** 功能圖形（定位、對齊、時序、格式資訊的位置）：回傳 { dark, fixed } 兩個 SIZE×SIZE 的布林矩陣（[列][行]）。 */
export function functionPatterns() {
    const dark = Array.from({ length: SIZE }, () => new Array(SIZE).fill(false));
    const fixed = Array.from({ length: SIZE }, () => new Array(SIZE).fill(false));
    const set = (x, y, on) => {
        dark[y][x] = on;
        fixed[y][x] = true;
    };
    for (let i = 0; i < SIZE; i++) {
        set(6, i, i % 2 === 0);
        set(i, 6, i % 2 === 0);
    }
    for (const [cx, cy] of [
        [3, 3],
        [SIZE - 4, 3],
        [3, SIZE - 4],
    ])
        for (let dy = -4; dy <= 4; dy++)
            for (let dx = -4; dx <= 4; dx++) {
                const x = cx + dx;
                const y = cy + dy;
                const dist = Math.max(Math.abs(dx), Math.abs(dy));
                if (x >= 0 && x < SIZE && y >= 0 && y < SIZE) set(x, y, dist !== 2 && dist !== 4);
            }
    for (const cy of ALIGNMENT)
        for (const cx of ALIGNMENT) {
            if ((cx === 6 && cy === 6) || (cx === 6 && cy === SIZE - 7) || (cx === SIZE - 7 && cy === 6)) continue;
            for (let dy = -2; dy <= 2; dy++)
                for (let dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
    drawFormat(set, 0);
    return { dark, fixed };
}

/** 格式資訊（錯誤更正等級與遮罩，BCH(15,5)）畫在兩個位置。 */
function drawFormat(set, mask) {
    const data = (EC_LEVEL_M << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i) => ((bits >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(SIZE - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, SIZE - 15 + i, bit(i));
    set(8, SIZE - 8, true);
}

const MASKS = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** 資料模組的位置，依標準的之字形順序（由右下往上，兩欄一組，跳過第 6 欄的時序線）。 */
export function dataPositions(fixed) {
    const out = [];
    for (let right = SIZE - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5;
        const upward = ((right + 1) & 2) === 0;
        for (let vert = 0; vert < SIZE; vert++)
            for (let j = 0; j < 2; j++) {
                const x = right - j;
                const y = upward ? SIZE - 1 - vert : vert;
                if (!fixed[y][x]) out.push([x, y]);
            }
    }
    return out;
}

/** 遮罩的扣分（ISO 18004 的四條規則），選扣分最少的遮罩。 */
function penalty(m) {
    let score = 0;
    const lines = [...m, ...m[0].map((_, x) => m.map((row) => row[x]))];
    for (const line of lines) {
        let run = 1;
        for (let i = 1; i <= line.length; i++) {
            if (i < line.length && line[i] === line[i - 1]) run++;
            else {
                if (run >= 5) score += run - 2;
                run = 1;
            }
        }
        const text = line.map((v) => (v ? '1' : '0')).join('');
        score += 40 * (text.match(/(?=10111010000|00001011101)/g)?.length ?? 0);
    }
    for (let y = 0; y + 1 < SIZE; y++)
        for (let x = 0; x + 1 < SIZE; x++)
            if (m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) score += 3;
    const darkCount = m.flat().filter(Boolean).length;
    const total = SIZE * SIZE;
    score += 10 * (Math.ceil(Math.abs(darkCount * 20 - total * 10) / total) - 1);
    return score;
}

/** 產生 QR 碼的矩陣（[列][行]，true＝深色）。mask 不給就選扣分最少的。 */
export function qrMatrix(text, mask = null) {
    const { dark, fixed } = functionPatterns();
    const codewords = finalCodewords(dataCodewords(text));
    const positions = dataPositions(fixed);
    const build = (k) => {
        const m = dark.map((row) => [...row]);
        positions.forEach(([x, y], i) => {
            const bit = i < codewords.length * 8 ? ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1 : false;
            m[y][x] = bit !== MASKS[k](x, y);
        });
        drawFormat((x, y, on) => (m[y][x] = on), k);
        return m;
    };
    if (mask !== null) return build(mask);
    return [0, 1, 2, 3, 4, 5, 6, 7].map(build).reduce((best, m) => (penalty(m) < penalty(best) ? m : best));
}

/** 矩陣轉成 SVG 的 path（每個深色模組一個 1×1 方塊），四周留 4 格空白。 */
export function qrPath(matrix) {
    const parts = [];
    matrix.forEach((row, y) => row.forEach((on, x) => on && parts.push(`M${x + 4} ${y + 4}h1v1h-1z`)));
    return { path: parts.join(''), size: matrix.length + 8 };
}
