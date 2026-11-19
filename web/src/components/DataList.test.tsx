import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../test/render";
import { setViewportWidth } from "../test/viewport";
import { Button, DataList } from ".";
import type { DataListColumn } from ".";

interface Row {
  id: string;
  applicant: string;
  note: string;
  batchable: boolean;
}

const ROWS: Row[] = [
  { id: "DA-0142", applicant: "林怡君", note: "新申請不能批次", batchable: false },
  { id: "DA-0139", applicant: "王志明", note: "可批次", batchable: true },
  { id: "DA-0140", applicant: "蔡佩珊", note: "可批次", batchable: true },
];

const COLUMNS: DataListColumn<Row>[] = [
  { key: "id", header: "單號", primary: true, cell: (row) => row.id },
  { key: "applicant", header: "申請人", cell: (row) => row.applicant },
  { key: "note", header: "批次", hideOnMobile: true, cell: (row) => row.note },
];

function Demo({ onChange = () => undefined, desktopOnly = false }: { onChange?: (keys: string[]) => void; desktopOnly?: boolean }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  return (
    <DataList
      label="待簽清單"
      columns={COLUMNS}
      rows={ROWS}
      rowKey={(row) => row.id}
      rowHref={(row) => `/approvals/${row.id}`}
      rowActions={(row) => <Button>查看 {row.id}</Button>}
      selection={{
        selected,
        onChange: (next) => {
          setSelected(next);
          onChange([...next]);
        },
        isDisabled: (row) => !row.batchable,
        rowLabel: (row) => (row.batchable ? `選取 ${row.id}` : `${row.id} 不能批次`),
        desktopOnly,
      }}
    />
  );
}

describe("DataList 的手機／桌面切換", () => {
  it("桌面是表格：有表頭，每筆一列，標題欄是連結", () => {
    renderWithProviders(<Demo />);
    const table = screen.getByRole("table", { name: "待簽清單" });
    expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual([
      "", "單號", "申請人", "批次", "操作",
    ]);
    expect(within(table).getAllByRole("row")).toHaveLength(ROWS.length + 1);
    expect(within(table).getByRole("link", { name: "DA-0142" }).getAttribute("href")).toBe("/approvals/DA-0142");
    expect(within(table).getByText("新申請不能批次")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "待簽清單" })).toBeNull();
  });

  it("手機是卡片清單：沒有表格，欄位名稱變成每一項的標籤，hideOnMobile 的欄位不顯示", () => {
    setViewportWidth(390);
    renderWithProviders(<Demo />);
    expect(screen.queryByRole("table")).toBeNull();
    const cards = within(screen.getByRole("list", { name: "待簽清單" })).getAllByRole("listitem");
    expect(cards).toHaveLength(ROWS.length);
    const first = cards[0] as HTMLElement;
    expect(within(first).getByRole("link", { name: "DA-0142" }).getAttribute("href")).toBe("/approvals/DA-0142");
    expect(within(first).getByRole("term").textContent).toBe("申請人");
    expect(within(first).getByRole("definition").textContent).toBe("林怡君");
    expect(within(first).queryByText("新申請不能批次")).toBeNull();
    expect(within(first).getByRole("button", { name: "查看 DA-0142" })).toBeTruthy();
  });

  it("畫面寬度改變時即時切換（例如手機轉橫、視窗縮小）", () => {
    renderWithProviders(<Demo />);
    expect(screen.getByRole("table")).toBeTruthy();
    act(() => setViewportWidth(639));
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByRole("list", { name: "待簽清單" })).toBeTruthy();
    act(() => setViewportWidth(640));
    expect(screen.getByRole("table")).toBeTruthy();
  });

  it("mode 可以固定排版，不看畫面寬度", () => {
    renderWithProviders(<DataList label="清單" mode="cards" columns={COLUMNS} rows={ROWS} rowKey={(row) => row.id} />);
    expect(screen.getByRole("list", { name: "清單" })).toBeTruthy();
  });
});

describe("DataList 的選取", () => {
  it("不能選的列核取方塊停用，名稱說明原因", () => {
    renderWithProviders(<Demo />);
    const blocked = screen.getByRole("checkbox", { name: "DA-0142 不能批次" }) as HTMLInputElement;
    expect(blocked.disabled).toBe(true);
  });

  it("逐列選取與取消", async () => {
    const onChange = vi.fn();
    renderWithProviders(<Demo onChange={onChange} />);
    await userEvent.click(screen.getByRole("checkbox", { name: "選取 DA-0139" }));
    expect(onChange).toHaveBeenLastCalledWith(["DA-0139"]);
    await userEvent.click(screen.getByRole("checkbox", { name: "選取 DA-0139" }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("全選只選得到可以選的列；部分選取時是半選狀態", async () => {
    const onChange = vi.fn();
    renderWithProviders(<Demo onChange={onChange} />);
    const all = screen.getByRole("checkbox", { name: "全選" }) as HTMLInputElement;
    await userEvent.click(screen.getByRole("checkbox", { name: "選取 DA-0139" }));
    expect(all.indeterminate).toBe(true);
    await userEvent.click(all);
    expect(onChange).toHaveBeenLastCalledWith(["DA-0139", "DA-0140"]);
    expect(all.checked).toBe(true);
    expect(all.indeterminate).toBe(false);
    await userEvent.click(all);
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("手機卡片也能選；desktopOnly 時手機不顯示核取方塊", () => {
    setViewportWidth(390);
    const { unmount } = renderWithProviders(<Demo />);
    expect(screen.getAllByRole("checkbox")).toHaveLength(ROWS.length);
    unmount();
    renderWithProviders(<Demo desktopOnly />);
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});

describe("DataList 沒有資料時", () => {
  it("載入中顯示骨架", () => {
    renderWithProviders(<DataList label="清單" columns={COLUMNS} rows={[]} rowKey={(row) => row.id} loading />);
    expect(screen.getByRole("status").textContent).toBe("載入中");
  });

  it("空的時候顯示空狀態，可以自訂", () => {
    const { unmount } = renderWithProviders(<DataList label="清單" columns={COLUMNS} rows={[]} rowKey={(row) => row.id} />);
    expect(screen.getByText("沒有資料")).toBeTruthy();
    unmount();
    renderWithProviders(
      <DataList label="清單" columns={COLUMNS} rows={[]} rowKey={(row) => row.id} empty={<p>目前沒有待簽的單</p>} />,
    );
    expect(screen.getByText("目前沒有待簽的單")).toBeTruthy();
  });
});
