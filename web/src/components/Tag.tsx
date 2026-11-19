import type { ReactNode } from "react";
import type { Level, RequestStatus } from "../api/endpoints";
import { formatLevel, formatStatus } from "../lib/format";
import "./Tag.css";

export type TagTone = "neutral" | "info" | "ok" | "warn" | "danger" | "l3" | "l4";

export interface TagProps {
  tone?: TagTone;
  children: ReactNode;
}

export function Tag({ tone = "neutral", children }: TagProps) {
  return <span className={`tag tag--${tone}`}>{children}</span>;
}

export interface LevelTagProps {
  /** null 代表還沒選欄位、級別未判定。 */
  level: Level | null;
}

export function LevelTag({ level }: LevelTagProps) {
  const { label, tone } = formatLevel(level);
  return <Tag tone={tone}>{label}</Tag>;
}

export interface StatusTagProps {
  status: RequestStatus;
  /** 接在狀態後面的補充，例如目前停在哪一關。 */
  detail?: string;
}

export function StatusTag({ status, detail }: StatusTagProps) {
  const { label, tone } = formatStatus(status);
  return <Tag tone={tone}>{detail ? `${label}・${detail}` : label}</Tag>;
}
