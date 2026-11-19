import { useRef } from "react";
import type { KeyboardEvent } from "react";
import { formatCount } from "../lib/format";
import { cx } from "../lib/cx";
import "./Tabs.css";

export interface TabItem<T extends string> {
  value: T;
  label: string;
  /** 分頁上的件數，例如「待我簽（6）」。 */
  count?: number;
}

export interface TabsProps<T extends string> {
  /** 這組分頁在分什麼，例如「清單分類」。 */
  label: string;
  items: readonly TabItem<T>[];
  value: T;
  onChange: (value: T) => void;
  /** 分頁內容區塊的 id（該區塊要設 role="tabpanel"）。 */
  panelId?: string;
}

const STEP: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1 };

/** 清單上方的分類分頁。左右鍵切換，Home／End 跳到頭尾。 */
export function Tabs<T extends string>({ label, items, value, onChange, panelId }: TabsProps<T>) {
  const listRef = useRef<HTMLDivElement>(null);

  function moveTo(index: number) {
    const target = items[(index + items.length) % items.length];
    if (!target) return;
    onChange(target.value);
    listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[items.indexOf(target)]?.focus();
  }

  function onKeyDown(event: KeyboardEvent, index: number) {
    const step = STEP[event.key];
    if (step !== undefined) moveTo(index + step);
    else if (event.key === "Home") moveTo(0);
    else if (event.key === "End") moveTo(items.length - 1);
    else return;
    event.preventDefault();
  }

  return (
    <div ref={listRef} className="tabs" role="tablist" aria-label={label}>
      {items.map((item, index) => (
        <button
          key={item.value}
          type="button"
          role="tab"
          className={cx("tabs__tab", item.value === value && "tabs__tab--on")}
          aria-selected={item.value === value}
          aria-controls={panelId}
          tabIndex={item.value === value ? 0 : -1}
          onClick={() => onChange(item.value)}
          onKeyDown={(event) => onKeyDown(event, index)}
        >
          {item.count === undefined ? item.label : formatCount(item.label, item.count)}
        </button>
      ))}
    </div>
  );
}
