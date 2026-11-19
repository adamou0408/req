import { useId } from "react";
import type { ReactNode } from "react";
import { cx } from "../lib/cx";
import "./Card.css";

export interface CardProps {
  /** 有標題時卡片是一個具名區段（section），螢幕閱讀器可以直接跳到。 */
  title?: ReactNode;
  /** 標題右側的動作（按鈕、連結）。 */
  actions?: ReactNode;
  /** 內容自己貼齊邊框（例如放清單或表格）時關掉內距。 */
  flush?: boolean;
  className?: string;
  children: ReactNode;
}

export function Card({ title, actions, flush = false, className, children }: CardProps) {
  const titleId = useId();
  const classes = cx("card", flush && "card--flush", className);
  if (title === undefined) {
    return <div className={classes}>{children}</div>;
  }
  return (
    <section className={classes} aria-labelledby={titleId}>
      <div className="card__head">
        <h2 className="card__title" id={titleId}>
          {title}
        </h2>
        {actions && <div className="card__actions">{actions}</div>}
      </div>
      <div className="card__body">{children}</div>
    </section>
  );
}
