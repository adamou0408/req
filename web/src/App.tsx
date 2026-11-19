import { Suspense, lazy } from "react";
import { Navigate, Route, Routes } from "react-router";
import { AppLayout } from "./app/AppLayout";
import { navItemsFor } from "./app/nav";
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
const MisQueuePage = lazy(() => import("./pages/MisQueuePage"));
const MisCheckPage = lazy(() => import("./pages/MisCheckPage"));
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
 * 首頁是「我的申請」。沒有申請人導覽的人（例如只有稽核角色）
 * 改送到他導覽列的第一個去處，避免一登入就看到跟自己無關的頁面。
 */
function HomeRoute() {
  const { user } = useAuth();
  const items = user ? navItemsFor(user) : [];
  const first = items[0];
  if (first && !items.some((item) => item.to === "/")) {
    return <Navigate to={first.to} replace />;
  }
  return <MyRequestsPage />;
}

export function App() {
  return (
    <Suspense fallback={<Skeleton count={4} />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        {DevComponentsPage && <Route path="/dev/components" element={<DevComponentsPage />} />}
        <Route element={<RequireAuth />}>
          <Route element={<AppLayout />}>
            <Route index element={<HomeRoute />} />
            <Route path="requests/new" element={<RequestNewPage />} />
            <Route path="requests/:id" element={<RequestDetailPage />} />
            <Route path="approvals" element={<ApprovalsPage />} />
            <Route path="approvals/:id" element={<ApprovalDetailPage />} />
            <Route path="grants" element={<GrantsPage />} />
            <Route path="mis" element={<MisQueuePage />} />
            <Route path="mis/:id" element={<MisCheckPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="audit" element={<AuditSearchPage />} />
            <Route path="audit/:id" element={<AuditEvidencePage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Route>
      </Routes>
    </Suspense>
  );
}
