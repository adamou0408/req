/**
 * Directory port：人員與組織資料來源（之後接 AD＋HR，見 docs/open-questions.md M6）。
 * 欄位是暫定的；整份快照會原封不動交給 SQL function 匯入，後端不解讀內容。
 */
export interface DirectoryPerson {
  id: string;
  name: string;
  email: string;
  /** 直屬主管；最上層為 null。 */
  manager_id: string | null;
  /** 所屬團隊。 */
  team_ids: string[];
  /** 是否在職。 */
  active: boolean;
  [extra: string]: unknown;
}

export interface DirectoryTeam {
  id: string;
  name: string;
  parent_id: string | null;
  [extra: string]: unknown;
}

export interface DirectorySnapshot {
  people: DirectoryPerson[];
  teams: DirectoryTeam[];
  [extra: string]: unknown;
}

export interface DirectoryPort {
  fetch(): Promise<DirectorySnapshot>;
}
