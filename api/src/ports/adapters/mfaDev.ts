import { timingSafeEqual } from 'node:crypto';
import type { MfaPort, MfaResult } from '../mfa.ts';

/** 固定驗證碼。只給開發與測試用；設定檢查會擋掉 NODE_ENV=production。 */
export class DevMfa implements MfaPort {
  readonly mode = 'dev' as const;
  private readonly code: Buffer;

  constructor(code: string) {
    this.code = Buffer.from(code);
  }

  async verify(_actorId: string, code: string): Promise<MfaResult> {
    const given = Buffer.from(code.trim());
    return given.length === this.code.length && timingSafeEqual(given, this.code) ? 'ok' : 'invalid';
  }
}
