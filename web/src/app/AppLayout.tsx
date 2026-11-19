import { Suspense, useEffect } from "react";
import { Link, Outlet, useLocation } from "react-router";
import { useAuth } from "../auth/AuthContext";
import { useMutation } from "../api/hooks";
import type { CurrentUser } from "../api/endpoints";
import { Skeleton, useToast } from "../components";
import { IconLogout } from "../components/icons";
import { cx } from "../lib/cx";
import { useIsMobile } from "../lib/useMediaQuery";
import { t } from "../i18n/zh-Hant";
import { isNavItemActive, navItemsFor } from "./nav";
import type { NavItem } from "./nav";
import "./AppLayout.css";

function NavLinks({ items, className }: { items: readonly NavItem[]; className: string }) {
  const { pathname } = useLocation();
  return (
    <nav className={className} aria-label={t.nav.label}>
      {items.map((item) => {
        const active = isNavItemActive(item, pathname);
        return (
          <Link
            key={item.key}
            to={item.to}
            className={cx(`${className}__item`, active && `${className}__item--on`)}
            aria-current={active ? "page" : undefined}
          >
            {item.icon}
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

function UserMenu({ user }: { user: CurrentUser }) {
  const auth = useAuth();
  const toast = useToast();
  const logout = useMutation<void, void>(() => auth.logout(), {
    onError: (error) => toast.error(error.message),
  });
  return (
    <div className="topbar__user">
      <span className="topbar__name">{t.auth.userLine(user.name, user.dept)}</span>
      <button
        type="button"
        className="topbar__logout"
        aria-label={t.common.logout}
        aria-busy={logout.loading || undefined}
        onClick={() => void logout.mutate()}
      >
        <IconLogout size={20} />
        <span className="topbar__logout-text">{t.common.logout}</span>
      </button>
    </div>
  );
}

/** 底部導覽的高度要讓 Toast、ActionBar 與主內容知道，才不會被蓋住。 */
function useBottomNavSpace(visible: boolean) {
  useEffect(() => {
    document.documentElement.classList.toggle("has-bottomnav", visible);
    return () => document.documentElement.classList.remove("has-bottomnav");
  }, [visible]);
}

/**
 * 登入後所有頁面共用的外框。
 * 桌面：上方導覽列。手機：精簡頂欄＋底部導覽（項目依角色，最多 5 項）。
 */
export function AppLayout() {
  const { user } = useAuth();
  const isMobile = useIsMobile();
  const items = user ? navItemsFor(user) : [];
  // 只有一個去處時不需要底部導覽，品牌名稱就能回首頁。
  const showBottomNav = isMobile && items.length > 1;
  useBottomNavSpace(showBottomNav);
  if (!user) return null;
  return (
    <div className="app">
      <a className="app__skip" href="#main">
        {t.app.skipToContent}
      </a>
      <header className="topbar">
        <Link className="topbar__brand" to="/">
          {t.app.name}
        </Link>
        {!isMobile && <NavLinks items={items} className="topnav" />}
        <UserMenu user={user} />
      </header>
      <main id="main" className="app__main" tabIndex={-1}>
        <Suspense fallback={<Skeleton count={4} />}>
          <Outlet />
        </Suspense>
      </main>
      {showBottomNav && <NavLinks items={items} className="bottomnav" />}
    </div>
  );
}
