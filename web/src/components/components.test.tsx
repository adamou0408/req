import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../test/render";
import {
  ActionBar,
  Alert,
  Button,
  ButtonLink,
  Card,
  Checkbox,
  DiffList,
  EmptyState,
  ErrorState,
  Field,
  KeyValue,
  PageHeader,
  Segmented,
  Skeleton,
  StatusTag,
  Stepper,
  Tabs,
  Tag,
  TierTag,
  Timeline,
  useToast,
} from ".";
import { TOAST_DURATION_MS } from "./Toast";

describe("Button", () => {
  it("預設是 type=button，點了會觸發 onClick；可以用鍵盤操作", async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>核准</Button>);
    const button = screen.getByRole("button", { name: "核准" });
    expect(button.getAttribute("type")).toBe("button");
    await userEvent.click(button);
    button.focus();
    await userEvent.keyboard("{Enter}");
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it("loading 時擋住點擊並標示忙碌，但仍可聚焦", async () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        送出
      </Button>,
    );
    const button = screen.getByRole("button", { name: "送出" });
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(false);
  });

  it("ButtonLink 是站內連結", () => {
    renderWithProviders(<ButtonLink to="/requests/new">新申請</ButtonLink>);
    expect(
      screen.getByRole("link", { name: "新申請" }).getAttribute("href"),
    ).toBe("/requests/new");
  });
});

describe("Tag", () => {
  it("級別與狀態用集中的格式化結果", () => {
    render(
      <>
        <Tag tone="warn">部分重疊</Tag>
        <TierTag name="L4" elevated />
        <TierTag name={null} />
        <StatusTag status="in_approval" detail="資安長關" />
      </>,
    );
    expect(screen.getByText("部分重疊").className).toContain("tag--warn");
    expect(screen.getByText("L4").className).toContain("tag--tier-high");
    expect(screen.getByText("未判定")).toBeTruthy();
    expect(screen.getByText("簽核中・資安長關")).toBeTruthy();
  });
});

describe("Card", () => {
  it("有標題時是具名區段", () => {
    render(
      <Card title="重複檢查" actions={<Button>動作</Button>}>
        內容
      </Card>,
    );
    const region = screen.getByRole("region", { name: "重複檢查" });
    expect(within(region).getByText("內容")).toBeTruthy();
    expect(within(region).getByRole("button", { name: "動作" })).toBeTruthy();
  });
});

describe("Field", () => {
  it("label 連到 input、select、textarea", () => {
    render(
      <>
        <Field label="搜尋主題包" />
        <Field
          as="select"
          label="分類"
          options={[{ value: "a", label: "報表與分析" }]}
          placeholder="請選擇"
        />
        <Field as="textarea" label="說明" />
      </>,
    );
    expect(screen.getByLabelText("搜尋主題包").tagName).toBe("INPUT");
    const select = screen.getByLabelText("分類");
    expect(select.tagName).toBe("SELECT");
    expect(
      within(select)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["請選擇", "報表與分析"]);
    expect(screen.getByLabelText("說明").tagName).toBe("TEXTAREA");
  });

  it("錯誤訊息與說明都接到欄位上，並標成 invalid", () => {
    render(
      <Field
        label="原因"
        required
        hint="會寫進稽核紀錄"
        error="請填寫原因。"
      />,
    );
    const input = screen.getByRole("textbox", { name: /原因/ });
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const describedBy = (input.getAttribute("aria-describedby") ?? "").split(
      " ",
    );
    const texts = describedBy.map(
      (id) => document.getElementById(id)?.textContent,
    );
    expect(texts).toEqual(["會寫進稽核紀錄", "請填寫原因。"]);
    expect(screen.getByText("（必填）")).toBeTruthy();
  });

  it("可以輸入", async () => {
    const onChange = vi.fn();
    render(<Field label="說明" onChange={onChange} />);
    await userEvent.type(screen.getByLabelText("說明"), "abc");
    expect(onChange).toHaveBeenCalledTimes(3);
  });
});

describe("Checkbox／Segmented", () => {
  it("Checkbox 可以用空白鍵切換；說明接到欄位上", async () => {
    const onChange = vi.fn();
    render(<Checkbox label="客戶編號" hint="L3 欄位" onChange={onChange} />);
    const box = screen.getByRole("checkbox", { name: "客戶編號" });
    expect(
      document.getElementById(box.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toBe("L3 欄位");
    box.focus();
    await userEvent.keyboard(" ");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("Segmented 是一組具名的單選，選了會回報值", async () => {
    function Demo() {
      const [value, setValue] = useState<"team" | "project">("team");
      return (
        <Segmented
          legend="被授權者"
          value={value}
          onChange={setValue}
          options={[
            { value: "team", label: "團隊" },
            { value: "project", label: "專案" },
          ]}
        />
      );
    }
    render(<Demo />);
    const group = screen.getByRole("group", { name: "被授權者" });
    await userEvent.click(within(group).getByRole("radio", { name: "專案" }));
    expect(
      (within(group).getByRole("radio", { name: "專案" }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(
      (within(group).getByRole("radio", { name: "團隊" }) as HTMLInputElement)
        .checked,
    ).toBe(false);
  });
});

describe("Stepper", () => {
  it("目前的關卡標 aria-current，每一關都有狀態文字", () => {
    render(
      <Stepper
        label="簽核路徑"
        steps={[
          { key: "a", label: "主管", state: "done", detail: "陳建宏・11-11" },
          {
            key: "b",
            label: "資料擁有者",
            state: "current",
            people: [{ name: "張美玲", state: "done" }, { name: "周文傑" }],
          },
          { key: "c", label: "MIS", state: "todo" },
        ]}
      />,
    );
    const list = screen.getByRole("list", { name: "簽核路徑" });
    const steps = within(list)
      .getAllByRole("listitem")
      .filter((item) => item.className.includes("stepper__step"));
    expect(steps).toHaveLength(3);
    expect(steps.map((step) => step.getAttribute("aria-current"))).toEqual([
      null,
      "step",
      null,
    ]);
    expect(steps[0]?.textContent).toContain("（已完成）");
    expect(steps[1]?.textContent).toContain("張美玲已完成");
    expect(steps[2]?.textContent).toContain("（未開始）");
  });
});

describe("Timeline", () => {
  it("時間統一格式化成台北時間；系統動作帶出依據的規則", () => {
    render(
      <Timeline
        label="紀錄"
        items={[
          {
            key: "2",
            at: "2026-11-10T01:30:42Z",
            actor: "系統",
            action: "分派簽核人",
            rule: "L3 路徑；每關不同人",
          },
          {
            key: "1",
            at: "2026-11-10T01:30:41Z",
            actor: "林怡君",
            role: "申請人",
            action: "送審",
            detail: "狀態 草稿 → 送審",
          },
        ]}
      />,
    );
    const items = within(
      screen.getByRole("list", { name: "紀錄" }),
    ).getAllByRole("listitem");
    expect(items[0]?.textContent).toContain("2026-11-10 09:30");
    expect(items[0]?.textContent).toContain("系統：分派簽核人");
    expect(items[0]?.textContent).toContain("依據：L3 路徑；每關不同人");
    expect(items[1]?.textContent).toContain("林怡君（申請人）：送審");
    expect(items[1]?.querySelector("time")?.getAttribute("datetime")).toBe(
      "2026-11-10T01:30:41Z",
    );
  });
});

describe("DiffList", () => {
  it("每一項標出差異種類；有前後值時兩個都顯示", () => {
    render(
      <DiffList
        label="與前案的差異"
        items={[
          {
            key: "a",
            kind: "added",
            label: "客戶主檔",
            text: "客戶編號、客戶名稱",
          },
          {
            key: "b",
            kind: "expanded",
            label: "資料期間",
            before: "2024",
            after: "2024–2025",
          },
          { key: "c", kind: "same", label: "列條件", text: "區域 屬於 北區" },
        ]}
      />,
    );
    const items = within(
      screen.getByRole("list", { name: "與前案的差異" }),
    ).getAllByRole("listitem");
    expect(
      items.map((item) => item.querySelector(".tag")?.textContent),
    ).toEqual(["新增", "擴大", "相同"]);
    expect(items[1]?.querySelector("del")?.textContent).toBe("2024");
    expect(items[1]?.querySelector("ins")?.textContent).toBe("2024–2025");
    expect(items[0]?.querySelector(".tag")?.className).toContain("tag--warn");
  });

  it("沒有差異時直接說「與前案無差異」", () => {
    render(<DiffList label="與前案的差異" items={[]} />);
    expect(screen.getByText("與前案無差異")).toBeTruthy();
  });
});

describe("EmptyState／ErrorState／Skeleton", () => {
  it("EmptyState 顯示標題、說明與下一步", () => {
    render(
      <EmptyState
        title="目前沒有待簽的單"
        description="有新的單會通知你"
        action={<Button>重新整理</Button>}
      />,
    );
    expect(screen.getByText("目前沒有待簽的單")).toBeTruthy();
    expect(screen.getByText("有新的單會通知你")).toBeTruthy();
    expect(screen.getByRole("button", { name: "重新整理" })).toBeTruthy();
  });

  it("ErrorState 直接顯示後端的訊息（不顯示內部代碼），可以重試", async () => {
    const onRetry = vi.fn();
    render(<ErrorState error={{ message: "找不到這張單" }} onRetry={onRetry} />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("無法載入");
    expect(alert.textContent).toContain("找不到這張單");
    await userEvent.click(screen.getByRole("button", { name: "重試" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("Skeleton 對螢幕閱讀器說「載入中」", () => {
    render(<Skeleton count={2} />);
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("載入中");
    expect(status.querySelectorAll(".skeleton__bar")).toHaveLength(2);
  });
});

describe("PageHeader", () => {
  it("有 h1、返回連結、標籤、動作，並設定分頁標題", () => {
    renderWithProviders(
      <PageHeader
        title="DA-2026-0142"
        back={{ to: "/approvals", label: "待簽清單" }}
        tags={<TierTag name="L3" />}
        meta="申請人 林怡君"
        actions={<Button>撤銷申請</Button>}
      />,
    );
    expect(
      screen.getByRole("heading", { level: 1, name: "DA-2026-0142" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "待簽清單" }).getAttribute("href"),
    ).toBe("/approvals");
    expect(screen.getByText("L3")).toBeTruthy();
    expect(screen.getByText("申請人 林怡君")).toBeTruthy();
    expect(screen.getByRole("button", { name: "撤銷申請" })).toBeTruthy();
    expect(document.title).toBe("DA-2026-0142｜簽核平台");
  });
});

describe("Alert／KeyValue／ActionBar", () => {
  it("Alert 平常是 note，live 時是 alert", () => {
    render(
      <>
        <Alert tone="warn" title="部分重疊">
          已有生效中的前案
        </Alert>
        <Alert tone="danger" live>
          送出失敗
        </Alert>
      </>,
    );
    expect(screen.getByRole("note").textContent).toContain("部分重疊");
    expect(screen.getByRole("alert").textContent).toBe("送出失敗");
  });

  it("KeyValue 是名稱與內容成對的清單", () => {
    render(<KeyValue items={[{ label: "列條件", value: "區域 屬於 北區" }]} />);
    expect(screen.getByRole("term").textContent).toBe("列條件");
    expect(screen.getByRole("definition").textContent).toBe("區域 屬於 北區");
  });

  it("ActionBar 是具名的一組動作", () => {
    render(
      <ActionBar label="你的決定">
        <Button>退回</Button>
        <Button variant="primary">核准</Button>
      </ActionBar>,
    );
    expect(
      within(screen.getByRole("group", { name: "你的決定" })).getAllByRole(
        "button",
      ),
    ).toHaveLength(2);
  });
});

describe("Tabs", () => {
  function Demo({ onChange }: { onChange: (value: string) => void }) {
    const [value, setValue] = useState("todo");
    return (
      <Tabs
        label="清單分類"
        value={value}
        onChange={(next) => {
          setValue(next);
          onChange(next);
        }}
        items={[
          { value: "todo", label: "待我簽", count: 6 },
          { value: "done", label: "我已簽" },
          { value: "deputy", label: "職務代理" },
        ]}
      />
    );
  }

  it("件數接在名稱後面；只有選中的分頁在 Tab 順序裡", () => {
    render(<Demo onChange={() => undefined} />);
    const tabs = within(
      screen.getByRole("tablist", { name: "清單分類" }),
    ).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "待我簽（6）",
      "我已簽",
      "職務代理",
    ]);
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual([
      "true",
      "false",
      "false",
    ]);
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);
  });

  it("左右鍵切換並移動焦點，會繞回頭尾；Home／End 跳到頭尾", async () => {
    const onChange = vi.fn();
    render(<Demo onChange={onChange} />);
    screen.getByRole("tab", { name: "待我簽（6）" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(document.activeElement?.textContent).toBe("我已簽");
    await userEvent.keyboard("{End}");
    expect(document.activeElement?.textContent).toBe("職務代理");
    await userEvent.keyboard("{ArrowRight}");
    expect(document.activeElement?.textContent).toBe("待我簽（6）");
    await userEvent.keyboard("{ArrowLeft}");
    expect(document.activeElement?.textContent).toBe("職務代理");
    await userEvent.keyboard("{Home}");
    expect(onChange.mock.calls.map(([value]) => value as string)).toEqual([
      "done",
      "deputy",
      "todo",
      "deputy",
      "todo",
    ]);
  });
});

describe("Toast", () => {
  function Trigger() {
    const toast = useToast();
    return (
      <>
        <Button onClick={() => toast.success("已核准")}>成功</Button>
        <Button onClick={() => toast.error("連不上伺服器")}>錯誤</Button>
      </>
    );
  }

  it("成功訊息過一段時間自動消失；錯誤訊息要自己關", () => {
    vi.useFakeTimers();
    try {
      renderWithProviders(<Trigger />);
      fireEvent.click(screen.getByRole("button", { name: "成功" }));
      fireEvent.click(screen.getByRole("button", { name: "錯誤" }));
      expect(screen.getByRole("status").textContent).toContain("已核准");
      expect(screen.getByRole("alert").textContent).toContain("連不上伺服器");

      act(() => {
        vi.advanceTimersByTime(TOAST_DURATION_MS);
      });
      expect(screen.queryByRole("status")).toBeNull();
      expect(screen.getByRole("alert")).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "關閉通知" }));
      expect(screen.queryByRole("alert")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
