/** 開發用功能（開發登入、元件展示頁）只在這個旗標為真時出現。 */
export const DEV_TOOLS_ENABLED: boolean = import.meta.env.DEV;

/** 正式建置預設不顯示開發登入；e2e 與測試環境用 VITE_DEV_LOGIN=1 打開。 */
export const DEV_LOGIN_ENABLED: boolean =
  import.meta.env.DEV || import.meta.env.VITE_DEV_LOGIN === "1";
