/** 從 JSON 檔讀人員組織資料與資料目錄（第一版用匯入檔案代替真實系統）。 */
import { readFile } from 'node:fs/promises';
import type { CatalogPort, CatalogSnapshot } from '../catalog.ts';
import type { DirectoryPort, DirectorySnapshot } from '../directory.ts';

async function readJsonObject(file: string, label: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    throw new Error(`讀不到${label}檔案 ${file}：${(err as Error).message}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`${label}檔案 ${file} 不是合法的 JSON：${(err as Error).message}`);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error(`${label}檔案 ${file} 的最外層必須是物件`);
  }
  return data as Record<string, unknown>;
}

function requireArray(data: Record<string, unknown>, key: string, file: string, label: string): void {
  if (!Array.isArray(data[key])) throw new Error(`${label}檔案 ${file} 缺少陣列欄位「${key}」`);
}

/** 只檢查「最外層有該有的陣列」；每一筆的內容由 SQL function 驗證。 */
export class JsonFileDirectory implements DirectoryPort {
  private readonly file: string;
  constructor(file: string) {
    this.file = file;
  }
  async fetch(): Promise<DirectorySnapshot> {
    const data = await readJsonObject(this.file, '人員組織');
    requireArray(data, 'people', this.file, '人員組織');
    requireArray(data, 'teams', this.file, '人員組織');
    return data as DirectorySnapshot;
  }
}

export class JsonFileCatalog implements CatalogPort {
  private readonly file: string;
  constructor(file: string) {
    this.file = file;
  }
  async fetch(): Promise<CatalogSnapshot> {
    const data = await readJsonObject(this.file, '資料目錄');
    requireArray(data, 'packages', this.file, '資料目錄');
    return data as CatalogSnapshot;
  }
}
