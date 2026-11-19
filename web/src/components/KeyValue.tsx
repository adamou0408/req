import type { ReactNode } from "react";
import "./KeyValue.css";

export interface KeyValueItem {
  label: string;
  value: ReactNode;
}

export interface KeyValueProps {
  items: readonly KeyValueItem[];
}

/** 一組「名稱：內容」（核准內容、申請內容）。手機上名稱在上、內容在下。 */
export function KeyValue({ items }: KeyValueProps) {
  return (
    <dl className="kv">
      {items.map((item) => (
        <div key={item.label} className="kv__row">
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
