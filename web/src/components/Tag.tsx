import type { ReactNode } from "react";
import type { CaseStatus } from "../api/endpoints";
import { formatStatus, formatTier } from "../lib/format";
import type { TagTone } from "../lib/tone";
import "./Tag.css";

export type { TagTone };

export interface TagProps {
  tone?: TagTone;
  children: ReactNode;
}

export function Tag({ tone = "neutral", children }: TagProps) {
  return <span className={`tag tag--${tone}`}>{children}</span>;
}

export interface TierTagProps {
  /** 級別的名稱（後端給的）；null 代表內容還不足以判定級別。 */
  name: string | null;
  /** 需要特別留意的級別（由後端決定），用醒目的顏色。 */
  elevated?: boolean;
}

export function TierTag({ name, elevated }: TierTagProps) {
  const { label, tone } = formatTier(name, elevated);
  return <Tag tone={tone}>{label}</Tag>;
}

export interface StatusTagProps {
  status: CaseStatus;
  /** 接在狀態後面的補充，例如目前停在哪一關。 */
  detail?: string;
}

export function StatusTag({ status, detail }: StatusTagProps) {
  const { label, tone } = formatStatus(status);
  return <Tag tone={tone}>{detail ? `${label}・${detail}` : label}</Tag>;
}
