import type { ReactNode } from "react";
import { formatDateTime } from "../lib/format";
import { t } from "../i18n/zh-Hant";
import "./Timeline.css";

export interface TimelineItem {
  key: string;
  /** 事件時間（ISO 字串），由元件統一格式化。 */
  at: string;
  /** 誰做的；系統自動做的動作由後端給「系統」。 */
  actor: string;
  /** 當時的角色，例如「主管」「資料擁有者」。 */
  role?: string;
  action: string;
  /** 改了什麼。 */
  detail?: ReactNode;
  /** 依據哪條規則（系統自動做的動作一定要有）。 */
  rule?: string;
}

export interface TimelineProps {
  label: string;
  items: readonly TimelineItem[];
}

export function Timeline({ label, items }: TimelineProps) {
  return (
    <ol className="timeline" aria-label={label}>
      {items.map((item) => (
        <li key={item.key} className="timeline__item">
          <time className="timeline__time" dateTime={item.at}>
            {formatDateTime(item.at)}
          </time>
          <p className="timeline__main">
            <strong>
              {item.role
                ? t.timeline.actorWithRole(item.actor, item.role)
                : item.actor}
            </strong>
            {t.common.colon}
            {item.action}
          </p>
          {item.detail && <div className="timeline__detail">{item.detail}</div>}
          {item.rule && (
            <p className="timeline__rule">{t.timeline.rule(item.rule)}</p>
          )}
        </li>
      ))}
    </ol>
  );
}
