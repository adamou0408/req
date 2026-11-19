import type { ReactNode } from "react";
import "./ActionBar.css";

export interface ActionBarProps {
  /** 這組動作的名稱，例如「你的決定」。 */
  label: string;
  children: ReactNode;
}

/**
 * 一頁的決定性動作（核准、退回）。
 * 手機上固定貼在畫面底部（底部導覽上方），內容再長也按得到；桌面上就是一排按鈕。
 */
export function ActionBar({ label, children }: ActionBarProps) {
  return (
    <div className="actionbar" role="group" aria-label={label}>
      {children}
    </div>
  );
}
