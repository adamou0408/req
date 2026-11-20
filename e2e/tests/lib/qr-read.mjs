// 測試用：讀回畫面上的 QR 碼矩陣（web/lib/qr.js 產生的第 4 版 M、英數模式）。端對端測試扮演背書人的相機：
// 從新裝置的畫面讀出矩陣、解成文字，交給背書人頁面的條碼偵測（瀏覽器在 Linux 上沒有內建的 BarcodeDetector）。
// 只讀格式資訊的遮罩與資料碼字，不做影像處理與錯誤更正（矩陣是從頁面的 SVG 直接取得的）。
import { dataPositions, functionPatterns } from '../../../web/lib/qr.js';

const ALPHANUMERIC = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
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

/** 矩陣（[列][行]，true＝深色）解成文字。 */
export function readQr(matrix) {
    const format = [0, 1, 2, 3, 4, 5, 7, 8].map((y) => matrix[y][8]).concat([7, 5, 4, 3, 2, 1, 0].map((x) => matrix[8][x]));
    const bits = format.reduce((acc, on, i) => acc | ((on ? 1 : 0) << i), 0) ^ 0x5412;
    const mask = (bits >>> 10) & 7;
    if (bits >>> 13 !== 0) throw new Error('不是錯誤更正 M');
    const stream = dataPositions(functionPatterns().fixed).map(([x, y]) => (matrix[y][x] !== MASKS[mask](x, y) ? 1 : 0));
    const bytes = [];
    for (let i = 0; i + 8 <= stream.length; i += 8) bytes.push(stream.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
    // 2 個區塊交錯：前 64 個是資料碼字
    const data = [...bytes.slice(0, 64).filter((_, i) => i % 2 === 0), ...bytes.slice(0, 64).filter((_, i) => i % 2 === 1)];
    const bitsOf = data.flatMap((b) => [7, 6, 5, 4, 3, 2, 1, 0].map((i) => (b >>> i) & 1));
    let at = 0;
    const take = (n) => bitsOf.slice(at, (at += n)).reduce((a, b) => (a << 1) | b, 0);
    if (take(4) !== 0b0010) throw new Error('不是英數模式');
    const count = take(9);
    let out = '';
    for (let i = 0; i + 1 < count; i += 2) {
        const v = take(11);
        out += ALPHANUMERIC[Math.floor(v / 45)] + ALPHANUMERIC[v % 45];
    }
    if (count % 2) out += ALPHANUMERIC[take(6)];
    return out;
}
