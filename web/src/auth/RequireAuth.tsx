import { Navigate, Outlet, useLocation } from "react-router";
import { ErrorState, Skeleton } from "../components";
import { t } from "../i18n/zh-Hant";
import { useAuth } from "./AuthContext";

/** 登入後要回到的位置，放在路由 state 裡帶給登入頁。 */
export interface LoginRedirectState {
  from: string;
}

/** 路由守衛：沒登入就導向登入頁，並記住原本要去哪裡。 */
export function RequireAuth() {
  const auth = useAuth();
  const location = useLocation();
  if (auth.status === "loading") {
    return (
      <div className="app-gate">
        <Skeleton count={4} />
      </div>
    );
  }
  if (auth.status === "error") {
    return (
      <div className="app-gate">
        <ErrorState title={t.auth.sessionCheckFailed} error={auth.error} onRetry={auth.reload} />
      </div>
    );
  }
  if (auth.status === "anonymous") {
    const state: LoginRedirectState = { from: location.pathname + location.search };
    return <Navigate to="/login" replace state={state} />;
  }
  return <Outlet />;
}
