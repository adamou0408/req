import { useState } from "react";
import { Navigate, useLocation } from "react-router";
import { useAuth } from "../auth/AuthContext";
import type { LoginRedirectState } from "../auth/RequireAuth";
import { SSO_LOGIN_URL, fetchDevUsers } from "../api/endpoints";
import type { CurrentUser } from "../api/endpoints";
import { useMutation, useQuery } from "../api/hooks";
import { Alert, ButtonLink, Card, EmptyState, ErrorState, Field, Skeleton, Tag } from "../components";
import { DEV_LOGIN_ENABLED } from "../lib/env";
import { formatRole } from "../lib/format";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { t } from "../i18n/zh-Hant";
import "./LoginPage.css";

/** 名單超過這個數量才顯示搜尋欄。 */
const FILTER_THRESHOLD = 8;

function matches(user: CurrentUser, keyword: string): boolean {
  const text = `${user.name} ${user.dept} ${user.title ?? ""}`.toLowerCase();
  return text.includes(keyword.trim().toLowerCase());
}

function DevUserButton({ user, busy, onPick }: { user: CurrentUser; busy: boolean; onPick: () => void }) {
  return (
    <li>
      <button type="button" className="login__person" disabled={busy} onClick={onPick}>
        <span className="login__person-name">{user.name}</span>
        <span className="muted">{[user.dept, user.title].filter(Boolean).join(" ")}</span>
        <span className="cluster">
          {user.roles.map((role) => (
            <Tag key={role}>{formatRole(role)}</Tag>
          ))}
        </span>
      </button>
    </li>
  );
}

function DevUserList({ users }: { users: readonly CurrentUser[] }) {
  const auth = useAuth();
  const [keyword, setKeyword] = useState("");
  const login = useMutation((userId: string) => auth.loginAsDevUser(userId));
  const visible = users.filter((user) => matches(user, keyword));
  return (
    <>
      {users.length > FILTER_THRESHOLD && (
        <Field
          type="search"
          label={t.auth.devFilterLabel}
          placeholder={t.auth.devFilterPlaceholder}
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
        />
      )}
      {login.error && (
        <Alert tone="danger" live>
          {login.error.message}
        </Alert>
      )}
      {visible.length === 0 && <p className="muted">{t.auth.devNoMatch}</p>}
      <ul className="login__people" aria-label={t.auth.devListLabel}>
        {visible.map((user) => (
          <DevUserButton
            key={user.user_id}
            user={user}
            busy={login.loading}
            onPick={() => void login.mutate(user.user_id)}
          />
        ))}
      </ul>
    </>
  );
}

function DevLogin() {
  const users = useQuery("dev-users", fetchDevUsers);
  return (
    <Card title={t.auth.devTitle}>
      <p className="muted">{t.auth.devHint}</p>
      {users.loading && <Skeleton variant="card" count={3} />}
      {users.error && <ErrorState error={users.error} onRetry={users.reload} />}
      {users.data?.length === 0 && <EmptyState title={t.auth.devEmpty} />}
      {users.data && users.data.length > 0 && <DevUserList users={users.data} />}
    </Card>
  );
}

function redirectTarget(state: unknown): string {
  const from = (state as Partial<LoginRedirectState> | null)?.from;
  return typeof from === "string" && from.startsWith("/") ? from : "/";
}

export default function LoginPage() {
  const auth = useAuth();
  const location = useLocation();
  useDocumentTitle(t.auth.loginTitle);
  if (auth.status === "authenticated") {
    return <Navigate to={redirectTarget(location.state)} replace />;
  }
  return (
    <main className="login">
      <header className="login__head">
        <h1 className="login__title">{t.app.name}</h1>
        <p className="muted">{t.auth.intro}</p>
      </header>
      <Card>
        <ButtonLink to={SSO_LOGIN_URL} reloadDocument variant="primary" block>
          {t.auth.ssoButton}
        </ButtonLink>
      </Card>
      {DEV_LOGIN_ENABLED && <DevLogin />}
    </main>
  );
}
