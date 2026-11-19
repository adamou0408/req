import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ReactNode } from "react";
import {
  ApiError,
  CLIENT_ERROR,
  isAbortError,
  isApiError,
} from "../api/client";
import {
  api,
  fetchMe,
  loginAsDevUser,
  logout as requestLogout,
} from "../api/endpoints";
import type { CurrentUser } from "../api/endpoints";
import { t } from "../i18n/zh-Hant";

type AuthState =
  | { status: "loading" }
  | { status: "anonymous" }
  | { status: "authenticated"; user: CurrentUser }
  | { status: "error"; error: ApiError };

export interface AuthContextValue {
  status: AuthState["status"];
  user: CurrentUser | null;
  /** 確認登入狀態失敗（例如後端沒開）時的錯誤。 */
  error: ApiError | null;
  /** 重新向後端確認目前是誰。 */
  reload: () => void;
  /** 開發模式：直接扮演名單上的人。 */
  loginAsDevUser: (userId: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth 必須用在 AuthProvider 裡面");
  return value;
}

function toErrorState(error: unknown): AuthState {
  if (isApiError(error) && error.status === 401) return { status: "anonymous" };
  const apiError = isApiError(error)
    ? error
    : new ApiError(CLIENT_ERROR.unexpected, t.errors.unknown, 0, error);
  return { status: "error", error: apiError };
}

/** 向後端確認目前是誰；version 改變就重新確認一次。 */
function useSession() {
  const [state, setState] = useState<AuthState>({ status: "loading" });
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    fetchMe(controller.signal).then(
      (user) => setState({ status: "authenticated", user }),
      (error: unknown) => {
        if (!isAbortError(error)) setState(toErrorState(error));
      },
    );
    return () => controller.abort();
  }, [version]);

  // 任何請求收到 401（登入過期）都回到未登入狀態，由路由守衛導向登入頁。
  useEffect(() => {
    api.setUnauthorizedHandler(() => setState({ status: "anonymous" }));
    return () => api.setUnauthorizedHandler(null);
  }, []);

  const reload = useCallback(() => setVersion((value) => value + 1), []);
  return { state, setState, reload };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const { state, setState, reload } = useSession();

  const loginDev = useCallback(
    async (userId: string) => {
      const user = await loginAsDevUser(userId);
      setState({ status: "authenticated", user });
    },
    [setState],
  );

  const logout = useCallback(async () => {
    await requestLogout();
    setState({ status: "anonymous" });
  }, [setState]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status: state.status,
      user: state.status === "authenticated" ? state.user : null,
      error: state.status === "error" ? state.error : null,
      reload,
      loginAsDevUser: loginDev,
      logout,
    }),
    [state, reload, loginDev, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
