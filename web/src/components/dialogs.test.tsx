import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Button, ConfirmDialog, MfaDialog } from ".";
import type { ConfirmDialogProps, MfaDialogProps } from ".";

function ConfirmHarness(props: Partial<ConfirmDialogProps>) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>撤銷</Button>
      <ConfirmDialog
        open={open}
        title="撤銷 DA-2026-0077？"
        onCancel={() => setOpen(false)}
        onConfirm={() => setOpen(false)}
        {...props}
      >
        撤銷後授權立即失效。
      </ConfirmDialog>
    </>
  );
}

async function openConfirm(props: Partial<ConfirmDialogProps> = {}) {
  render(<ConfirmHarness {...props} />);
  await userEvent.click(screen.getByRole("button", { name: "撤銷" }));
  return screen.getByRole("dialog", { name: "撤銷 DA-2026-0077？" });
}

describe("ConfirmDialog", () => {
  it("開啟時焦點移進對話框，是具名的 modal dialog", async () => {
    const dialog = await openConfirm();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.documentElement.classList.contains("modal-open")).toBe(true);
  });

  it("Esc 取消，焦點回到開啟它的按鈕，背景恢復捲動", async () => {
    await openConfirm();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "撤銷" }));
    expect(document.documentElement.classList.contains("modal-open")).toBe(false);
  });

  it("Tab 在對話框裡繞圈，不會跑到背景", async () => {
    const dialog = await openConfirm({ reason: {} });
    for (let step = 0; step < 8; step += 1) {
      await userEvent.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    await userEvent.tab({ shift: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("不需要原因時，確認直接回呼", async () => {
    const onConfirm = vi.fn();
    await openConfirm({ onConfirm });
    await userEvent.click(screen.getByRole("button", { name: "確認" }));
    expect(onConfirm).toHaveBeenCalledWith("");
  });

  it("要求原因：焦點在原因欄位；沒填不能送出並顯示錯誤", async () => {
    const onConfirm = vi.fn();
    await openConfirm({ onConfirm, reason: { label: "撤銷原因" }, confirmLabel: "確認撤銷" });
    const field = screen.getByRole("textbox", { name: /撤銷原因/ });
    expect(document.activeElement).toBe(field);
    await userEvent.type(field, "   ");
    await userEvent.click(screen.getByRole("button", { name: "確認撤銷" }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText("請填寫原因。")).toBeTruthy();
  });

  it("要求原因：填了之後把去掉前後空白的內容交給 onConfirm", async () => {
    const onConfirm = vi.fn();
    await openConfirm({ onConfirm, reason: { label: "撤銷原因" } });
    await userEvent.type(screen.getByRole("textbox", { name: /撤銷原因/ }), "  專案提前結束 ");
    await userEvent.click(screen.getByRole("button", { name: "確認" }));
    expect(onConfirm).toHaveBeenCalledWith("專案提前結束");
  });

  it("原因可以設成選填", async () => {
    const onConfirm = vi.fn();
    await openConfirm({ onConfirm, reason: { required: false } });
    await userEvent.click(screen.getByRole("button", { name: "確認" }));
    expect(onConfirm).toHaveBeenCalledWith("");
  });

  it("送出中不能關閉；失敗時把訊息留在對話框裡，可以再試", async () => {
    let fail: (error: Error) => void = () => undefined;
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
    );
    await openConfirm({ onConfirm });
    await userEvent.click(screen.getByRole("button", { name: "確認" }));
    expect(screen.getByRole("button", { name: "確認" }).getAttribute("aria-busy")).toBe("true");
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeTruthy();

    fail(new Error("只有 MIS 系統管理員可以修改設定。"));
    expect((await screen.findByRole("alert")).textContent).toBe("只有 MIS 系統管理員可以修改設定。");
    expect(screen.getByRole("button", { name: "確認" }).getAttribute("aria-busy")).toBeNull();
  });

  it("每次開啟都是全新的狀態", async () => {
    await openConfirm({ reason: {} });
    await userEvent.type(screen.getByRole("textbox", { name: /原因/ }), "上一次打的字");
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    await userEvent.click(screen.getByRole("button", { name: "撤銷" }));
    expect((screen.getByRole("textbox", { name: /原因/ }) as HTMLTextAreaElement).value).toBe("");
  });
});

function renderMfa(props: Partial<MfaDialogProps> = {}) {
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  const view = render(<MfaDialog open onSubmit={onSubmit} onCancel={onCancel} {...props} />);
  const input = () => screen.getByLabelText("輸入驗證器 App 上的 6 位數驗證碼") as HTMLInputElement;
  return { onSubmit, onCancel, input, ...view };
}

describe("MfaDialog", () => {
  it("焦點在驗證碼欄位；欄位設定成數字鍵盤與一次性驗證碼自動填入", () => {
    const { input } = renderMfa({ title: "確認核准", summary: ["DA-2026-0142｜銷售訂單 4 個欄位", "2026-12-01～2027-04-30"] });
    expect(screen.getByRole("dialog", { name: "確認核准" })).toBeTruthy();
    expect(document.activeElement).toBe(input());
    expect(input().getAttribute("inputmode")).toBe("numeric");
    expect(input().getAttribute("autocomplete")).toBe("one-time-code");
    expect(screen.getByText("DA-2026-0142｜銷售訂單 4 個欄位")).toBeTruthy();
  });

  it("只收數字，最多 6 位；不滿 6 位不能送出", async () => {
    const { input, onSubmit } = renderMfa();
    const confirm = screen.getByRole("button", { name: "確認" }) as HTMLButtonElement;
    await userEvent.type(input(), "12a 3-4");
    expect(input().value).toBe("1234");
    expect(confirm.disabled).toBe(true);
    await userEvent.keyboard("{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
    await userEvent.type(input(), "5678");
    expect(input().value).toBe("123456");
    expect(confirm.disabled).toBe(false);
  });

  it("滿 6 位後按 Enter 或確認鈕送出", async () => {
    const { input, onSubmit } = renderMfa({ confirmLabel: "確認核准" });
    await userEvent.type(input(), "482913{Enter}");
    expect(onSubmit).toHaveBeenCalledWith("482913");
    await userEvent.click(screen.getByRole("button", { name: "確認核准" }));
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it("取消與 Esc 都會回呼 onCancel", async () => {
    const { onCancel } = renderMfa();
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    await userEvent.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it("等待後端回應時不能重複送出，也不能關閉", async () => {
    const { onSubmit, onCancel } = renderMfa({ busy: true });
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "確認" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "關閉" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("驗證碼被拒絕：顯示訊息、清空欄位、焦點回到欄位", async () => {
    const { input, rerender, onSubmit, onCancel } = renderMfa();
    await userEvent.type(input(), "000000");
    rerender(<MfaDialog open busy onSubmit={onSubmit} onCancel={onCancel} />);
    rerender(<MfaDialog open error="驗證碼不正確" onSubmit={onSubmit} onCancel={onCancel} />);
    await waitFor(() => expect(input().value).toBe(""));
    expect(input().getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText("驗證碼不正確")).toBeTruthy();
    expect(document.activeElement).toBe(input());
  });
});
