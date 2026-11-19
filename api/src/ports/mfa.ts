/** MFA port：step-up 驗證碼的檢查。 */
export type MfaResult = 'ok' | 'invalid' | 'not_enrolled';

export interface MfaPort {
  readonly mode: 'dev' | 'totp';
  verify(actorId: string, code: string): Promise<MfaResult>;
}
