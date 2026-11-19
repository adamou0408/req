import type { ReactNode } from "react";
import "./Alert.css";

export type AlertTone = "info" | "ok" | "warn" | "danger";

export interface AlertProps {
  tone?: AlertTone;
  title?: string;
  /** 動作失敗後才出現的訊息設成 true，螢幕閱讀器會立刻讀出。 */
  live?: boolean;
  children?: ReactNode;
}

/** 頁面上的提示框（規則說明、重疊警示、時限提醒）。短暫的操作結果用 Toast。 */
export function Alert({
  tone = "info",
  title,
  live = false,
  children,
}: AlertProps) {
  return (
    <div className={`alert alert--${tone}`} role={live ? "alert" : "note"}>
      {title && <strong className="alert__title">{title}</strong>}
      {children && <div className="alert__body">{children}</div>}
    </div>
  );
}
