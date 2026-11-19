/**
 * 所有端點函式與「依賴後端契約」的值都集中在這個檔案。
 *
 * 契約（docs/api.md、packages/contract/src/routes.ts）定案前，這裡的路徑、
 * 標頭、錯誤代碼、列舉值都是「契約假設」。契約定案後只需要改這一個檔案：
 * 列舉型別改成引用產生器輸出的型別，端點函式照路由表補齊。
 * 其他檔案一律從這裡引用，不得自己寫路徑或代碼。
 */
import { createClient } from "./client";

export const api = createClient({
  unsafeMethodHeader: { name: "X-Requested-With", value: "das-web" },
  mfaRequiredCodes: ["MFA_REQUIRED"],
  mfaInvalidCodes: ["MFA_INVALID"],
  mfaHeaders: (code) => ({ "X-MFA-Code": code }),
});

/** SSO 登入的起點；正式環境的登入頁只有這個連結。 */
export const SSO_LOGIN_URL = "/auth/login";

export type Role =
  | "applicant"
  | "approver"
  | "owner"
  | "manager"
  | "ciso"
  | "mis"
  | "mis_admin"
  | "auditor";

/** L1、L2 不走申請，只會出現在「自動給」的提示上。 */
export type Level = "L1" | "L2" | "L3" | "L4";

export type RequestStatus =
  | "draft"
  | "in_review"
  | "returned"
  | "pending_apply"
  | "verifying"
  | "active"
  | "expired"
  | "revoked";

export type GranteeType = "team" | "project" | "agent";

export interface CurrentUser {
  user_id: string;
  name: string;
  dept: string;
  title: string | null;
  roles: Role[];
}

export function fetchMe(signal?: AbortSignal): Promise<CurrentUser> {
  return api.get("/auth/me", { ...(signal && { signal }) });
}

/** 只有後端在開發模式才提供；列出可以直接扮演的人員。 */
export function fetchDevUsers(signal?: AbortSignal): Promise<CurrentUser[]> {
  return api.get("/auth/dev/users", { ...(signal && { signal }) });
}

export function loginAsDevUser(userId: string): Promise<CurrentUser> {
  return api.post("/auth/dev/login", { user_id: userId });
}

export function logout(): Promise<void> {
  return api.post("/auth/logout");
}
