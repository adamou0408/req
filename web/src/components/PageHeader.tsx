import type { ReactNode } from "react";
import { Link } from "react-router";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import "./PageHeader.css";

export interface PageHeaderProps {
  /** 頁面標題；同時會設成瀏覽器分頁的標題。 */
  title: string;
  /** 回上一層的連結，例如「← 我的申請」。 */
  back?: { to: string; label: string };
  /** 標題旁邊的標籤（級別、狀態）。 */
  tags?: ReactNode;
  /** 標題下面的補充資訊。 */
  meta?: ReactNode;
  /** 這一頁的主要動作。 */
  actions?: ReactNode;
}

export function PageHeader({
  title,
  back,
  tags,
  meta,
  actions,
}: PageHeaderProps) {
  useDocumentTitle(title);
  return (
    <header className="pagehead">
      {back && (
        <Link className="pagehead__back" to={back.to}>
          <span aria-hidden="true">←</span>
          {back.label}
        </Link>
      )}
      <div className="pagehead__row">
        <div className="pagehead__heading">
          <h1 className="pagehead__title">{title}</h1>
          {tags}
        </div>
        {actions && <div className="pagehead__actions">{actions}</div>}
      </div>
      {meta && <div className="pagehead__meta">{meta}</div>}
    </header>
  );
}
