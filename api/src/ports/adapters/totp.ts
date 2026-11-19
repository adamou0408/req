/**
 * TOTP（RFC 6238）＝ HOTP（RFC 4226）套上時間步進。自己實作，只用 node:crypto。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export type TotpAlgorithm = 'sha1' | 'sha256' | 'sha512';

export interface TotpOptions {
  digits?: number;
  stepSec?: number;
  algorithm?: TotpAlgorithm;
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 解碼；容許小寫、空白、連字號與結尾的 =。格式不對回 null。 */
export function base32Decode(input: string): Buffer | null {
  const clean = input.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  if (clean === '') return null;
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

export function hotp(key: Buffer, counter: number, digits = 6, algorithm: TotpAlgorithm = 'sha1'): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac(algorithm, key).update(msg).digest();
  const offset = (digest[digest.length - 1] as number) & 0x0f;
  const bin = digest.readUInt32BE(offset) & 0x7fffffff;
  return (bin % 10 ** digits).toString().padStart(digits, '0');
}

export function totpStep(nowMs: number, stepSec = 30): number {
  return Math.floor(nowMs / 1000 / stepSec);
}

export function totp(key: Buffer, nowMs: number, opts: TotpOptions = {}): string {
  return hotp(key, totpStep(nowMs, opts.stepSec), opts.digits, opts.algorithm);
}

/**
 * 檢查驗證碼；容許前後各 window 個步進的時鐘誤差。
 * 對得上就回那個步進的編號（給呼叫端擋重放用），否則回 null。
 */
export function totpVerify(
  key: Buffer,
  code: string,
  nowMs: number,
  opts: TotpOptions & { window?: number } = {},
): number | null {
  const digits = opts.digits ?? 6;
  if (!new RegExp(`^\\d{${digits}}$`).test(code)) return null;
  const given = Buffer.from(code);
  const current = totpStep(nowMs, opts.stepSec);
  const window = opts.window ?? 1;
  let matched: number | null = null;
  // 每個步進都比完，不提早結束。
  for (let step = current - window; step <= current + window; step++) {
    if (step < 0) continue;
    const expected = Buffer.from(hotp(key, step, digits, opts.algorithm));
    if (timingSafeEqual(expected, given) && matched === null) matched = step;
  }
  return matched;
}
