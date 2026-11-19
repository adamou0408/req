/**
 * Catalog port：資料目錄來源（主題包、欄位、分級、資料擁有者；以 DC 為準，見 docs/open-questions.md M1）。
 * 欄位是暫定的；整份快照會原封不動交給 SQL function 匯入，後端不解讀內容。
 */
export interface CatalogColumn {
  id: string;
  name: string;
  level: 'L1' | 'L2' | 'L3' | 'L4';
  [extra: string]: unknown;
}

export interface CatalogPackage {
  id: string;
  name: string;
  /** 資料擁有者（人員 id）。 */
  owner_id: string;
  columns: CatalogColumn[];
  [extra: string]: unknown;
}

export interface CatalogSnapshot {
  packages: CatalogPackage[];
  [extra: string]: unknown;
}

export interface CatalogPort {
  fetch(): Promise<CatalogSnapshot>;
}
