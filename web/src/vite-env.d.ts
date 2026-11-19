/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 設成 "1" 時，正式建置也顯示開發用登入（給 e2e 與測試環境用）。 */
  readonly VITE_DEV_LOGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
