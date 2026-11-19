import type { ReactNode } from "react";
import { t } from "../i18n/zh-Hant";
import { Button } from "./Button";
import { IconAlert, IconInbox } from "./icons";
import "./States.css";

export interface EmptyStateProps {
  title: string;
  description?: ReactNode;
  /** 下一步可以做什麼（按鈕或連結）。 */
  action?: ReactNode;
}

export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div className="state">
      <span className="state__icon">
        <IconInbox size={28} />
      </span>
      <p className="state__title">{title}</p>
      {description && <div className="state__desc">{description}</div>}
      {action && <div className="state__action">{action}</div>}
    </div>
  );
}

export interface ErrorStateProps {
  title?: string;
  /** 直接顯示後端回傳的訊息。錯誤代碼是系統內部用語，不顯示給使用者。 */
  error?: { message: string } | null;
  onRetry?: () => void;
}

export function ErrorState({
  title = t.state.errorTitle,
  error,
  onRetry,
}: ErrorStateProps) {
  return (
    <div className="state state--error" role="alert">
      <span className="state__icon">
        <IconAlert size={28} />
      </span>
      <p className="state__title">{title}</p>
      {error && <p className="state__desc">{error.message}</p>}
      {onRetry && (
        <div className="state__action">
          <Button onClick={onRetry}>{t.common.retry}</Button>
        </div>
      )}
    </div>
  );
}

export interface SkeletonProps {
  /** text：幾行文字；card：幾張卡片（清單載入中用）。 */
  variant?: "text" | "card";
  count?: number;
}

export function Skeleton({ variant = "text", count = 3 }: SkeletonProps) {
  const items = Array.from({ length: count }, (_, index) => index);
  return (
    <div className={`skeleton skeleton--${variant}`} role="status">
      <span className="visually-hidden">{t.common.loading}</span>
      {items.map((index) => (
        <span key={index} className="skeleton__bar" aria-hidden="true" />
      ))}
    </div>
  );
}
