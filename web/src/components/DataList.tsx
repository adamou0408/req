import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { useIsMobile } from "../lib/useMediaQuery";
import { t } from "../i18n/zh-Hant";
import { EmptyState, Skeleton } from "./States";
import "./DataList.css";

export interface DataListColumn<T> {
  key: string;
  /** 桌面是表頭；手機是卡片裡每一項的名稱。 */
  header: string;
  cell: (row: T) => ReactNode;
  /** 手機卡片的標題列（不顯示欄位名稱）。沒有任何一欄標記時取第一欄。 */
  primary?: boolean;
  /** 手機卡片上不顯示這一欄。 */
  hideOnMobile?: boolean;
  align?: "start" | "end";
}

export interface DataListSelection<T> {
  selected: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  /** 核取方塊的名稱，例如「選取 DA-2026-0139」；不能選時請把原因寫進來。 */
  rowLabel: (row: T) => string;
  /** 能不能選由後端回傳的可執行動作決定，這裡只負責呈現。 */
  isDisabled?: (row: T) => boolean;
  /** 批次操作只在桌面提供時，手機卡片不顯示核取方塊。 */
  desktopOnly?: boolean;
}

export interface DataListProps<T> {
  /** 清單的名稱，給螢幕閱讀器用。 */
  label: string;
  columns: readonly DataListColumn<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  /** 每一列連到哪裡：桌面是標題欄的連結，手機是整張卡片都能點。 */
  rowHref?: (row: T) => string;
  rowActions?: (row: T) => ReactNode;
  selection?: DataListSelection<T>;
  loading?: boolean;
  /** 沒有資料時顯示的內容；不給就用預設的空狀態。 */
  empty?: ReactNode;
  /** 預設依螢幕寬度切換：桌面是表格，手機是卡片清單。 */
  mode?: "auto" | "table" | "cards";
}

function primaryKeys<T>(columns: readonly DataListColumn<T>[]): Set<string> {
  const marked = columns
    .filter((column) => column.primary)
    .map((column) => column.key);
  const first = columns[0]?.key;
  return new Set(marked.length > 0 || first === undefined ? marked : [first]);
}

function selectableKeys<T>(props: DataListProps<T>): string[] {
  const { rows, rowKey, selection } = props;
  return rows.filter((row) => !selection?.isDisabled?.(row)).map(rowKey);
}

function toggleKey<T>(selection: DataListSelection<T>, key: string) {
  const next = new Set(selection.selected);
  if (!next.delete(key)) next.add(key);
  selection.onChange(next);
}

function RowCheckbox<T>({ row, props }: { row: T; props: DataListProps<T> }) {
  const selection = props.selection;
  if (!selection) return null;
  const key = props.rowKey(row);
  return (
    <label className="datalist__check">
      <input
        type="checkbox"
        checked={selection.selected.has(key)}
        disabled={selection.isDisabled?.(row) ?? false}
        aria-label={selection.rowLabel(row)}
        onChange={() => toggleKey(selection, key)}
      />
    </label>
  );
}

function SelectAllCheckbox<T>({ props }: { props: DataListProps<T> }) {
  const ref = useRef<HTMLInputElement>(null);
  const keys = selectableKeys(props);
  const selection = props.selection;
  const count = keys.filter((key) => selection?.selected.has(key)).length;
  const all = keys.length > 0 && count === keys.length;
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = count > 0 && !all;
  }, [count, all]);
  if (!selection) return null;
  return (
    <label className="datalist__check">
      <input
        ref={ref}
        type="checkbox"
        checked={all}
        disabled={keys.length === 0}
        aria-label={t.datalist.selectAll}
        onChange={() => selection.onChange(new Set(all ? [] : keys))}
      />
    </label>
  );
}

function RowTitle<T>({
  row,
  props,
  children,
}: {
  row: T;
  props: DataListProps<T>;
  children: ReactNode;
}) {
  if (!props.rowHref) return <>{children}</>;
  return (
    <Link className="datalist__link" to={props.rowHref(row)}>
      {children}
    </Link>
  );
}

function cellClass<T>(column: DataListColumn<T>): string | undefined {
  return column.align === "end" ? "datalist__cell--end" : undefined;
}

function TableHead<T>({ props }: { props: DataListProps<T> }) {
  return (
    <thead>
      <tr>
        {props.selection && (
          <th scope="col" className="datalist__cell--check">
            <SelectAllCheckbox props={props} />
          </th>
        )}
        {props.columns.map((column) => (
          <th key={column.key} scope="col" className={cellClass(column)}>
            {column.header}
          </th>
        ))}
        {props.rowActions && (
          <th scope="col">
            <span className="visually-hidden">{t.datalist.actions}</span>
          </th>
        )}
      </tr>
    </thead>
  );
}

function TableRow<T>({ row, props }: { row: T; props: DataListProps<T> }) {
  const linkKey = [...primaryKeys(props.columns)][0];
  return (
    <tr>
      {props.selection && (
        <td className="datalist__cell--check">
          <RowCheckbox row={row} props={props} />
        </td>
      )}
      {props.columns.map((column) => (
        <td key={column.key} className={cellClass(column)}>
          {column.key === linkKey ? (
            <RowTitle row={row} props={props}>
              {column.cell(row)}
            </RowTitle>
          ) : (
            column.cell(row)
          )}
        </td>
      ))}
      {props.rowActions && (
        <td className="datalist__cell--actions">{props.rowActions(row)}</td>
      )}
    </tr>
  );
}

function TableView<T>({ props }: { props: DataListProps<T> }) {
  return (
    <div className="datalist datalist--table">
      <table aria-label={props.label}>
        <TableHead props={props} />
        <tbody>
          {props.rows.map((row) => (
            <TableRow key={props.rowKey(row)} row={row} props={props} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CardItem<T>({ row, props }: { row: T; props: DataListProps<T> }) {
  const { columns, rowActions, selection } = props;
  const primary = primaryKeys(columns);
  const titles = columns.filter((column) => primary.has(column.key));
  const details = columns.filter(
    (column) => !primary.has(column.key) && !column.hideOnMobile,
  );
  const actions = rowActions?.(row);
  return (
    <li className="datalist__card">
      <div className="datalist__card-head">
        {selection && !selection.desktopOnly && (
          <RowCheckbox row={row} props={props} />
        )}
        <div className="datalist__card-title">
          {titles.map((column, index) =>
            index === 0 ? (
              <RowTitle key={column.key} row={row} props={props}>
                {column.cell(row)}
              </RowTitle>
            ) : (
              <span key={column.key}>{column.cell(row)}</span>
            ),
          )}
        </div>
      </div>
      {details.length > 0 && (
        <dl className="datalist__card-body">
          {details.map((column) => (
            <div key={column.key} className="datalist__pair">
              <dt>{column.header}</dt>
              <dd>{column.cell(row)}</dd>
            </div>
          ))}
        </dl>
      )}
      {actions && <div className="datalist__card-actions">{actions}</div>}
    </li>
  );
}

function CardsView<T>({ props }: { props: DataListProps<T> }) {
  return (
    <ul className="datalist datalist--cards" aria-label={props.label}>
      {props.rows.map((row) => (
        <CardItem key={props.rowKey(row)} row={row} props={props} />
      ))}
    </ul>
  );
}

export function DataList<T>(props: DataListProps<T>) {
  const isMobile = useIsMobile();
  const mode = props.mode ?? "auto";
  const asCards = mode === "cards" || (mode === "auto" && isMobile);
  if (props.rows.length === 0) {
    if (props.loading) return <Skeleton variant="card" count={3} />;
    return <>{props.empty ?? <EmptyState title={t.datalist.empty} />}</>;
  }
  return asCards ? <CardsView props={props} /> : <TableView props={props} />;
}
