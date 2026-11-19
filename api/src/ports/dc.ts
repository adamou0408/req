/**
 * DC port：把核准的規則交給 DataCentric，並以被授權者的身分做測試查詢。
 * 規則與測試案例的欄位是暫定的（見 docs/open-questions.md M2、M3），契約定案後照改。
 */
export type DcGranteeType = 'team' | 'project' | 'agent';

export interface DcRowFilter {
  column: string;
  op: 'eq' | 'ne' | 'in' | 'not_in' | 'gt' | 'gte' | 'lt' | 'lte' | 'between';
  /** eq／ne／gt…：一個值；in／not_in：多個值；between：兩個值（含頭尾）。 */
  values: (string | number)[];
}

export interface DcRule {
  grantee: { type: DcGranteeType; id: string };
  /** 可以看的欄位（例：orders.amount）。 */
  columns: string[];
  /** 列條件，全部都要成立。資料期間也是列條件的一種。 */
  row_filters: DcRowFilter[];
  /** 授權起迄（YYYY-MM-DD，含頭尾）。 */
  valid_from: string;
  valid_to: string;
  can_export: boolean;
}

export interface DcTestCase {
  id: string;
  /** 預期結果：allow＝查得到該查的；deny＝查不到不該查的。 */
  expect: 'allow' | 'deny';
  /** 用誰的身分查；不給＝規則上的被授權者。 */
  grantee?: { type: DcGranteeType; id: string };
  columns: string[];
  /** 一列測試資料：欄位 → 值。 */
  row: Record<string, string | number | null>;
  action: 'query' | 'export';
  /** 查詢日期（YYYY-MM-DD）。 */
  on: string;
}

export interface DcTestResult {
  id: string;
  expect: 'allow' | 'deny';
  actual: 'allow' | 'deny';
  passed: boolean;
  /** 被拒絕的原因；allow 時為 null。 */
  reason: string | null;
}

export interface DcPort {
  readonly mode: 'mock' | 'manual';
  /** 把規則交給 DC。delivered=false 代表要由 MIS 手動到 DC 套用。 */
  deliverRule(rule: DcRule): Promise<{ delivered: boolean; ref: string | null }>;
  /** 執行測試查詢。回 null 代表這個模式不做自動測試（由 MIS 上傳驗證證據）。 */
  runTests(rule: DcRule, cases: DcTestCase[]): Promise<DcTestResult[] | null>;
}
