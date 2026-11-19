import { Suspense, lazy } from "react";
import { Navigate, Route, Routes, useParams } from "react-router";
import { AppLayout } from "./app/AppLayout";
import { navItemsFor } from "./app/nav";
import { ID_PARAM, ID_PATTERN, PATHS } from "./app/paths";
import { useAuth } from "./auth/AuthContext";
import { RequireAuth } from "./auth/RequireAuth";
import { Skeleton } from "./components";
import LoginPage from "./pages/LoginPage";
import MyRequestsPage from "./pages/MyRequestsPage";

const RequestNewPage = lazy(() => import("./pages/RequestNewPage"));
const RequestDetailPage = lazy(() => import("./pages/RequestDetailPage"));
const ApprovalsPage = lazy(() => import("./pages/ApprovalsPage"));
const ApprovalDetailPage = lazy(() => import("./pages/ApprovalDetailPage"));
const GrantsPage = lazy(() => import("./pages/GrantsPage"));
const FulfilmentQueuePage = lazy(() => import("./pages/FulfilmentQueuePage"));
const FulfilmentDetailPage = lazy(() => import("./pages/FulfilmentDetailPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const AuditSearchPage = lazy(() => import("./pages/AuditSearchPage"));
const AuditEvidencePage = lazy(() => import("./pages/AuditEvidencePage"));
const NotFoundPage = lazy(() => import("./pages/NotFoundPage"));

// 元件展示頁只在開發模式存在。這裡必須直接寫 import.meta.env.DEV，
// 打包工具才能在正式建置時把整個 import（連同展示用的範例內容）移除。
const DevComponentsPage = import.meta.env.DEV
  ? lazy(() => import("./pages/dev/ComponentsPage"))
  : null;

/**
 * 首頁是「我的申請」。沒有這個工作區的人（例如只做稽核）
 * 改送到他導覽列的第一個去處，避免一登入就看到跟自己無關的頁面。
 */
function HomeRoute() {
  const { user } = useAuth();
  const items = user ? navItemsFor(user) : [];
  const first = items[0];
  if (first && !items.some((item) => item.to === PATHS.home)) {
    return <Navigate to={first.to} replace />;
  }
  return <MyRequestsPage />;
}

/** wireframe 時期的網址（MIS 佇列）；執行佇列改名後保留轉址，舊連結不會失效。 */
const LEGACY_FULFILMENT = "/mis";

function LegacyFulfilmentRedirect() {
  const id = useParams()[ID_PARAM];
  const to = id === undefined ? PATHS.fulfilment : PATHS.fulfilmentCase(id);
  return <Navigate to={to} replace />;
}

export function App() {
  return (
    <Suspense fallback={<Skeleton count={4} />}>
      <Routes>
        <Route path={PATHS.login} element={<LoginPage />} />
        {DevComponentsPage && (
          <Route path={PATHS.devComponents} element={<DevComponentsPage />} />
        )}
        <Route element={<RequireAuth />}>
          <Route element={<AppLayout />}>
            <Route index element={<HomeRoute />} />
            <Route path={PATHS.requestNew} element={<RequestNewPage />} />
            <Route
              path={PATHS.request(ID_PATTERN)}
              element={<RequestDetailPage />}
            />
            <Route path={PATHS.approvals} element={<ApprovalsPage />} />
            <Route
              path={PATHS.approval(ID_PATTERN)}
              element={<ApprovalDetailPage />}
            />
            <Route path={PATHS.grants} element={<GrantsPage />} />
            <Route path={PATHS.fulfilment} element={<FulfilmentQueuePage />} />
            <Route
              path={PATHS.fulfilmentCase(ID_PATTERN)}
              element={<FulfilmentDetailPage />}
            />
            <Route path={PATHS.settings} element={<SettingsPage />} />
            <Route path={PATHS.audit} element={<AuditSearchPage />} />
            <Route
              path={PATHS.auditEvidence(ID_PATTERN)}
              element={<AuditEvidencePage />}
            />
            <Route
              path={LEGACY_FULFILMENT}
              element={<LegacyFulfilmentRedirect />}
            />
            <Route
              path={`${LEGACY_FULFILMENT}/${ID_PATTERN}`}
              element={<LegacyFulfilmentRedirect />}
            />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Route>
      </Routes>
    </Suspense>
  );
}
