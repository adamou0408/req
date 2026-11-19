// 最小的 CBOR 解碼器（RFC 8949），只涵蓋 WebAuthn 會用到的型別：
// 整數、位元組字串、文字字串、陣列、map、true/false/null。不支援不定長度與浮點數。
export type CborValue = number | bigint | Uint8Array | string | CborValue[] | Map<CborValue, CborValue> | boolean | null;

export class CborError extends Error {}

/** 解碼 bytes[offset] 開始的一個值，回傳值與結束位置。 */
export function decodeCbor(bytes: Uint8Array, offset = 0): { value: CborValue; end: number } {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let position = offset;

    function need(count: number): void {
        if (position + count > bytes.length) throw new CborError('CBOR 資料不完整');
    }

    function readLength(info: number): number | bigint {
        if (info < 24) return info;
        const sizes: Record<number, number> = { 24: 1, 25: 2, 26: 4, 27: 8 };
        const size = sizes[info];
        if (!size) throw new CborError(`不支援的 CBOR 長度編碼 ${info}`);
        need(size);
        const start = position;
        position += size;
        if (size === 1) return view.getUint8(start);
        if (size === 2) return view.getUint16(start);
        if (size === 4) return view.getUint32(start);
        const big = view.getBigUint64(start);
        return big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big;
    }

    function readCount(info: number): number {
        const length = readLength(info);
        if (typeof length === 'bigint') throw new CborError('CBOR 長度過大');
        return length;
    }

    function readValue(): CborValue {
        need(1);
        const initial = bytes[position++];
        const major = initial >> 5;
        const info = initial & 0x1f;
        switch (major) {
            case 0:
                return readLength(info);
            case 1: {
                const length = readLength(info);
                return typeof length === 'bigint' ? -1n - length : -1 - length;
            }
            case 2:
            case 3: {
                const length = readCount(info);
                need(length);
                const slice = bytes.slice(position, position + length);
                position += length;
                return major === 2 ? slice : new TextDecoder('utf-8', { fatal: true }).decode(slice);
            }
            case 4:
                return Array.from({ length: readCount(info) }, () => readValue());
            case 5: {
                const map = new Map<CborValue, CborValue>();
                const count = readCount(info);
                for (let i = 0; i < count; i += 1) map.set(readValue(), readValue());
                return map;
            }
            case 7:
                if (info === 20) return false;
                if (info === 21) return true;
                if (info === 22) return null;
                throw new CborError(`不支援的 CBOR simple 值 ${info}`);
            default:
                throw new CborError(`不支援的 CBOR 型別 ${major}`);
        }
    }

    const value = readValue();
    return { value, end: position };
}
