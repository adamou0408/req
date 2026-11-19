import type { DcPort, DcRowFilter, DcRule, DcTestCase, DcTestResult } from '../dc.ts';

type Value = string | number | null;

function compare(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function same(a: string | number, b: string | number): boolean {
  return compare(a, b) === 0 && typeof a === typeof b;
}

/** 一個列條件對一個值成不成立。值是 null（或那一欄不在測試資料裡）一律不成立。 */
export function filterMatches(filter: DcRowFilter, value: Value | undefined): boolean {
  if (value === null || value === undefined) return false;
  const v = filter.values;
  const first = v[0];
  switch (filter.op) {
    case 'eq':
      return first !== undefined && same(value, first);
    case 'ne':
      return first !== undefined && !same(value, first);
    case 'in':
      return v.some((x) => same(value, x));
    case 'not_in':
      return !v.some((x) => same(value, x));
    case 'gt':
      return first !== undefined && compare(value, first) > 0;
    case 'gte':
      return first !== undefined && compare(value, first) >= 0;
    case 'lt':
      return first !== undefined && compare(value, first) < 0;
    case 'lte':
      return first !== undefined && compare(value, first) <= 0;
    case 'between': {
      const hi = v[1];
      return first !== undefined && hi !== undefined && compare(value, first) >= 0 && compare(value, hi) <= 0;
    }
    default:
      return false;
  }
}

/** 依規則 JSON 算出「這個查詢會不會被放行」。拒絕時回原因。 */
export function evaluate(rule: DcRule, test: DcTestCase): { actual: 'allow' | 'deny'; reason: string | null } {
  const deny = (reason: string) => ({ actual: 'deny' as const, reason });
  const who = test.grantee ?? rule.grantee;
  if (who.type !== rule.grantee.type || who.id !== rule.grantee.id) return deny('grantee_mismatch');
  if (test.on < rule.valid_from || test.on > rule.valid_to) return deny('outside_validity');
  if (test.action === 'export' && !rule.can_export) return deny('export_not_allowed');
  const allowed = new Set(rule.columns);
  const blocked = test.columns.find((c) => !allowed.has(c));
  if (blocked !== undefined) return deny(`column_not_granted:${blocked}`);
  for (const f of rule.row_filters) {
    if (!filterMatches(f, test.row[f.column])) return deny(`row_filter:${f.column}`);
  }
  return { actual: 'allow', reason: null };
}

/**
 * 模擬的 DC：不連任何外部系統，直接依規則 JSON 計算測試結果。
 * 交付規則一律視為成功。
 */
export class MockDc implements DcPort {
  readonly mode = 'mock' as const;
  private seq = 0;

  async deliverRule(_rule: DcRule): Promise<{ delivered: boolean; ref: string | null }> {
    this.seq += 1;
    return { delivered: true, ref: `mock-${this.seq}` };
  }

  async runTests(rule: DcRule, cases: DcTestCase[]): Promise<DcTestResult[]> {
    return cases.map((c) => {
      const { actual, reason } = evaluate(rule, c);
      return { id: c.id, expect: c.expect, actual, passed: actual === c.expect, reason };
    });
  }
}
