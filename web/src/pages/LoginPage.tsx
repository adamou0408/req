import { useState } from "react";
import type { FormEvent } from "react";
import { Navigate, useLocation, useSearchParams } from "react-router";
import { PATHS } from "../app/paths";
import { useAuth } from "../auth/AuthContext";
import type { LoginRedirectState } from "../auth/RequireAuth";
import {
  LOGIN_ERROR_PARAM,
  fetchAuthConfig,
  fetchDevLoginOptions,
  ssoLoginUrl,
} from "../api/endpoints";
import type { AuthConfig, DevLoginOption } from "../api/endpoints";
import { useMutation, useQuery } from "../api/hooks";
import {
  Alert,
  Button,
  ButtonLink,
  Card,
  ErrorState,
  Field,
  Skeleton,
  Tag,
} from "../components";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { t } from "../i18n/zh-Hant";
import "./LoginPage.css";

/** 名單超過這個數量才顯示搜尋欄。 */
const FILTER_THRESHOLD = 8;
const copy = t.auth.dev;

function matches(option: DevLoginOption, keyword: string): boolean {
  const text = [option.name, option.org_unit, option.title].join(" ").toLowerCase();
  return text.includes(keyword.trim().toLowerCase());
}

interface PickProps {
  busy: boolean;
  onPick: (actorId: string) => void;
}

function DevPersonButton({ option, busy, onPick }: PickProps & { option: DevLoginOption }) {
  return (
    <li>
      <button
        type="button"
        className="login__person"
        disabled={busy}
        onClick={() => onPick(option.actor_id)}
      >
        <span className="login__person-name">{option.name}</span>
        <span className="muted">
          {[option.org_unit, option.title].filter(Boolean).join(" ")}
        </span>
        <span className="cluster">
          {option.roles.map((role) => (
            <Tag key={role.code}>{role.name}</Tag>
          ))}
        </span>
      </button>
    </li>
  );
}

function DevPersonList({ options, ...pick }: PickProps & { options: readonly DevLoginOption[] }) {
  const [keyword, setKeyword] = useState("");
  const visible = options.filter((option) => matches(option, keyword));
  if (options.length === 0) return <p className="muted">{copy.listEmpty}</p>;
  return (
    <>
      {options.length > FILTER_THRESHOLD && (
        <Field
          type="search"
          label={copy.filterLabel}
          placeholder={copy.filterPlaceholder}
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
        />
      )}
      {visible.length === 0 && <p className="muted">{copy.noMatch}</p>}
      <ul className="login__people" aria-label={copy.listLabel}>
        {visible.map((option) => (
          <DevPersonButton key={option.actor_id} option={option} {...pick} />
        ))}
      </ul>
    </>
  );
}

/** 名單上沒有的人（或後端沒有提供名單）可以直接輸入代號。 */
function DevActorForm({ busy, onPick }: PickProps) {
  const [actorId, setActorId] = useState("");
  function submit(event: FormEvent) {
    event.preventDefault();
    if (actorId.trim() !== "") onPick(actorId.trim());
  }
  return (
    <form className="login__manual" onSubmit={submit}>
      <Field
        label={copy.actorLabel}
        hint={copy.actorHint}
        value={actorId}
        autoCapitalize="none"
        autoComplete="off"
        onChange={(event) => setActorId(event.target.value)}
      />
      <Button type="submit" loading={busy}>
        {copy.submit}
      </Button>
    </form>
  );
}

function DevLogin() {
  const auth = useAuth();
  const options = useQuery("dev-login-options", fetchDevLoginOptions);
  const login = useMutation((actorId: string) => auth.loginAsDevUser(actorId));
  const pick: PickProps = {
    busy: login.loading,
    onPick: (actorId) => void login.mutate(actorId),
  };
  return (
    <Card title={copy.title}>
      <p className="muted">{copy.hint}</p>
      {login.error && (
        <Alert tone="danger" live>
          {login.error.message}
        </Alert>
      )}
      {options.loading && <Skeleton variant="card" count={3} />}
      {options.error && <Alert tone="info">{copy.listUnavailable}</Alert>}
      {options.data && <DevPersonList options={options.data} {...pick} />}
      <DevActorForm {...pick} />
    </Card>
  );
}

function SsoLogin({ config, returnTo }: { config: AuthConfig; returnTo: string }) {
  const url = ssoLoginUrl(config, returnTo);
  if (url === null) return <Alert tone="warn">{t.auth.ssoUnavailable}</Alert>;
  return (
    <Card>
      <ButtonLink to={url} reloadDocument variant="primary" block>
        {t.auth.ssoButton}
      </ButtonLink>
    </Card>
  );
}

function LoginError() {
  const [params] = useSearchParams();
  const code = params.get(LOGIN_ERROR_PARAM);
  if (code === null) return null;
  return (
    <Alert tone="danger" live>
      {t.auth.loginErrors[code] ?? t.auth.loginErrorFallback}
    </Alert>
  );
}

function redirectTarget(state: unknown): string {
  const from = (state as Partial<LoginRedirectState> | null)?.from;
  return typeof from === "string" && from.startsWith("/") ? from : PATHS.home;
}

export default function LoginPage() {
  const auth = useAuth();
  const returnTo = redirectTarget(useLocation().state);
  const config = useQuery("auth-config", fetchAuthConfig);
  useDocumentTitle(t.auth.loginTitle);
  if (auth.status === "authenticated") return <Navigate to={returnTo} replace />;
  return (
    <main className="login">
      <header className="login__head">
        <h1 className="login__title">{t.app.name}</h1>
        <p className="muted">{t.auth.intro}</p>
      </header>
      <LoginError />
      {config.loading && <Skeleton count={3} />}
      {config.error && (
        <ErrorState
          title={t.auth.configFailed}
          error={config.error}
          onRetry={config.reload}
        />
      )}
      {config.data?.auth_mode === "oidc" && (
        <SsoLogin config={config.data} returnTo={returnTo} />
      )}
      {config.data?.auth_mode === "dev" && <DevLogin />}
    </main>
  );
}
