/**
 * 所有端點函式與「依賴後端契約」的值都集中在這個檔案。
 * 其他檔案一律從這裡引用，不得自己寫路徑、標頭或代碼。
 *
 * 來源分兩種，各自標在下面：
 * - 【後端已實作】照 api/src/http/authRoutes.ts、security.ts、routing/register.ts 寫的。
 * - 【契約假設】契約（docs/contract/、packages/contract）還沒定案，先照 00-spine.md 推定。
 *   契約定案後，把假設的型別換成產生器輸出的型別，並照路由表補齊端點函式。
 */
import { createClient } from "./client";

const AUTH = "/api/auth";

/** 【後端已實作】非 GET 要帶 X-Requested-With；MFA 用 step-up：驗證通過後重送原請求。 */
export const api = createClient({
  unsafeMethodHeader: { name: "X-Requested-With", value: "sgn-web" },
  mfa: {
    requiredCodes: ["mfa_required"],
    invalidCodes: ["mfa_invalid"],
    verifyRequest: (code) => ({ path: `${AUTH}/mfa/verify`, body: { code } }),
  },
});

/** 【契約假設】申請單狀態，照 00-spine.md 第 4 節。 */
export type CaseStatus =
  | "draft"
  | "in_approval"
  | "returned"
  | "pending_fulfilment"
  | "verifying"
  | "active"
  | "completed"
  | "expired"
  | "revoked"
  | "cancelled";

/** 【契約假設】被授權者的類型，照 00-spine.md 第 2 節。 */
export type PrincipalType = "team" | "project" | "agent";

/**
 * 【契約假設】登入者可以使用的工作區，由後端依角色算好再回傳。
 * 前端不認任何角色代碼（角色是資料，而且有些屬於流程包），導覽列只看這份清單。
 */
export type Area = "requests" | "approvals" | "grants" | "fulfilment" | "audit";

/** 【契約假設】角色的代碼與名稱都由後端給；前端只拿名稱來顯示。 */
export interface RoleRef {
  code: string;
  name: string;
}

/** 【契約假設】api.auth_me 回傳的內容。 */
interface Profile {
  name: string;
  org_unit: string | null;
  title: string | null;
  roles: RoleRef[];
  areas: Area[];
}

/** 【後端已實作】GET /auth/me 與 POST /auth/dev-login 的回應（只列前端用到的欄位）。 */
interface SessionResponse {
  actor_id: string;
  profile: Profile | null;
}

export interface CurrentUser {
  actorId: string;
  name: string;
  orgUnit: string | null;
  roles: RoleRef[];
  areas: Area[];
}

/** 契約還沒提供個人資料（profile 為 null）時，先用 actor id 當名字、沒有任何工作區。 */
function toCurrentUser(session: SessionResponse): CurrentUser {
  const profile = session.profile;
  return {
    actorId: session.actor_id,
    name: profile?.name ?? session.actor_id,
    orgUnit: profile?.org_unit ?? null,
    roles: profile?.roles ?? [],
    areas: profile?.areas ?? [],
  };
}

/** 【後端已實作】GET /auth/config：登入頁依它決定顯示哪一種登入方式。 */
export interface AuthConfig {
  auth_mode: "dev" | "oidc";
  oidc_enabled: boolean;
  oidc_login_url: string | null;
}

export function fetchAuthConfig(signal: AbortSignal): Promise<AuthConfig> {
  return api.get(`${AUTH}/config`, { signal });
}

export async function fetchMe(signal: AbortSignal): Promise<CurrentUser> {
  return toCurrentUser(await api.get<SessionResponse>(`${AUTH}/me`, { signal }));
}

/** 【後端已實作】單一登入的起點；登入後導回 returnTo（後端只接受站內路徑）。 */
export function ssoLoginUrl(config: AuthConfig, returnTo: string): string | null {
  if (!config.oidc_enabled || config.oidc_login_url === null) return null;
  return `${config.oidc_login_url}?${new URLSearchParams({ return_to: returnTo })}`;
}

/** 【後端已實作】單一登入失敗時，後端導回 /?login_error=<代碼>。 */
export const LOGIN_ERROR_PARAM = "login_error";

/** 【契約假設】開發模式可以扮演的人員；後端目前還沒有這個端點。 */
export interface DevLoginOption {
  actor_id: string;
  name: string;
  org_unit: string | null;
  title: string | null;
  roles: RoleRef[];
}

export function fetchDevLoginOptions(signal: AbortSignal): Promise<DevLoginOption[]> {
  return api.get(`${AUTH}/dev-users`, { signal });
}

/** 【後端已實作】只在後端 AUTH_MODE=dev 時存在。 */
export async function loginAsDevUser(actorId: string): Promise<CurrentUser> {
  const session = await api.post<SessionResponse>(`${AUTH}/dev-login`, { actor_id: actorId });
  return toCurrentUser(session);
}

export function logout(): Promise<void> {
  return api.post(`${AUTH}/logout`);
}
