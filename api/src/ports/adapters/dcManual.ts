import type { DcPort, DcRule, DcTestCase, DcTestResult } from '../dc.ts';

/** 手動模式：本站不碰 DC。規則由 MIS 手動套用後在本站按「已套用」，驗證由 MIS 上傳證據。 */
export class ManualDc implements DcPort {
  readonly mode = 'manual' as const;

  async deliverRule(_rule: DcRule): Promise<{ delivered: boolean; ref: string | null }> {
    return { delivered: false, ref: null };
  }

  async runTests(_rule: DcRule, _cases: DcTestCase[]): Promise<DcTestResult[] | null> {
    return null;
  }
}
