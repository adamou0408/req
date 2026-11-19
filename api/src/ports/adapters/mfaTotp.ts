import type { MfaPort, MfaResult } from '../mfa.ts';
import { base32Decode, totpVerify } from './totp.ts';

export interface TotpMfaDeps {
  /** 取得某人的 TOTP 密鑰（base32）；沒設定回 null。 */
  getSecret(actorId: string): Promise<string | null>;
  now(): number;
}

/**
 * TOTP（RFC 6238，SHA-1／6 碼／30 秒，容許前後一個步進）。
 * 同一組驗證碼不能用第二次：記住每個人最後用過的步進。
 * 這份紀錄放在記憶體裡，所以多個實例之間不共享（最多讓同一組碼在 30 秒內於另一個實例再用一次）。
 */
export class TotpMfa implements MfaPort {
  readonly mode = 'totp' as const;
  private readonly deps: TotpMfaDeps;
  private readonly lastStep = new Map<string, number>();

  constructor(deps: TotpMfaDeps) {
    this.deps = deps;
  }

  async verify(actorId: string, code: string): Promise<MfaResult> {
    const secret = await this.deps.getSecret(actorId);
    if (secret === null) return 'not_enrolled';
    const key = base32Decode(secret);
    if (key === null) return 'not_enrolled';
    const step = totpVerify(key, code.trim(), this.deps.now());
    if (step === null) return 'invalid';
    const last = this.lastStep.get(actorId);
    if (last !== undefined && step <= last) return 'invalid';
    this.lastStep.set(actorId, step);
    if (this.lastStep.size > 10_000) this.prune(step);
    return 'ok';
  }

  private prune(currentStep: number): void {
    for (const [actor, step] of this.lastStep) {
      if (step < currentStep - 2) this.lastStep.delete(actor);
    }
  }
}
