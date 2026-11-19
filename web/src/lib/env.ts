/** 正式建置預設不顯示開發登入；e2e 與測試環境用 VITE_DEV_LOGIN=1 打開。 */
export const DEV_LOGIN_ENABLED: boolean =
  import.meta.env.DEV || import.meta.env.VITE_DEV_LOGIN === "1";
