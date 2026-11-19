import { t } from "../i18n/zh-Hant";
import { Tag } from "./Tag";
import type { TagTone } from "./Tag";
import "./DiffList.css";

/** 差異的種類由後端判定（擴大就要重簽是業務規則），元件只負責標示。 */
export type DiffKind = "added" | "expanded" | "narrowed" | "removed" | "changed" | "same";

export interface DiffItem {
  key: string;
  kind: DiffKind;
  /** 哪一項，例如「資料期間」「客戶主檔」。 */
  label: string;
  before?: string;
  after?: string;
  /** 沒有前後值可以比（例如新增的欄位清單）時的內容。 */
  text?: string;
}

export interface DiffListProps {
  label: string;
  items: readonly DiffItem[];
}

/** 會讓權限變大的差異用警示色，簽核人一眼看得到。 */
const TONE: Record<DiffKind, TagTone> = {
  added: "warn",
  expanded: "warn",
  narrowed: "ok",
  removed: "ok",
  changed: "info",
  same: "neutral",
};

function DiffValue({ item }: { item: DiffItem }) {
  if (item.before !== undefined && item.after !== undefined) {
    return (
      <>
        <del className="difflist__before">{item.before}</del>
        <span aria-hidden="true"> → </span>
        <span className="visually-hidden">{t.diff.becomes}</span>
        <ins className="difflist__after">{item.after}</ins>
      </>
    );
  }
  return <>{item.text ?? item.after ?? item.before}</>;
}

export function DiffList({ label, items }: DiffListProps) {
  if (items.length === 0) {
    return (
      <p className="difflist__none">
        <Tag tone="ok">{t.diff.none}</Tag>
      </p>
    );
  }
  return (
    <ul className="difflist" aria-label={label}>
      {items.map((item) => (
        <li key={item.key} className="difflist__item">
          <Tag tone={TONE[item.kind]}>{t.diff.kind[item.kind]}</Tag>
          <span className="difflist__text">
            <strong>{item.label}</strong>
            {t.common.colon}
            <DiffValue item={item} />
          </span>
        </li>
      ))}
    </ul>
  );
}
