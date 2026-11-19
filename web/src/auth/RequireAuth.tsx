import { Navigate, Outlet, useLocation } from "react-router";
import { LOGIN_ERROR_PARAM } from "../api/endpoints";
import { PATHS } from "../app/paths";
import { ErrorState, Skeleton } from "../components";
import { t } from "../i18n/zh-Hant";
import { useAuth } from "./AuthContext";

/** 登入後要回到的位置，放在路由 state 裡帶給登入頁。 */
export interface LoginRedirectState {
  from: string;
}

function stateFor(location: { pathname: string; search: string }): LoginRedirectState {
  const params = new URLSearchParams(location.search);
  params.delete(LOGIN_ERROR_PARAM);
  const search = params.toString();
  return { from: location.pathname + (search ? `?${search}` : "") };
}

/** 單一登入失敗時後端會導回 /?login_error=…；把這個代碼帶到登入頁顯示。 */
function loginPath(search: string): string {
  const code = new URLSearchParams(search).get(LOGIN_ERROR_PARAM);
  if (code === null) return PATHS.login;
  return `${PATHS.login}?${new URLSearchParams({ [LOGIN_ERROR_PARAM]: code })}`;
}

/** 路由守衛：沒登入就導向登入頁，並記住原本要去哪裡。 */
export function RequireAuth() {
  const auth = useAuth();
  const location = useLocation();
  if (auth.status === "loading") {
    return (
      <main className="app-gate">
        <Skeleton count={4} />
      </main>
    );
  }
  if (auth.status === "error") {
    return (
      <main className="app-gate">
        <ErrorState
          title={t.auth.sessionCheckFailed}
          error={auth.error}
          onRetry={auth.reload}
        />
      </main>
    );
  }
  if (auth.status === "anonymous") {
    return <Navigate to={loginPath(location.search)} replace state={stateFor(location)} />;
  }
  return <Outlet />;
}
