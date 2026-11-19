import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { api } from "../api/endpoints";
import { jsonResponse } from "../test/render";
import { MfaProvider } from "./MfaProvider";

const CODE_LABEL = "輸入驗證器 App 上的 6 位數驗證碼";
const PROMPT = { title: "確認核准", summary: ["DA-2026-0142｜銷售訂單 4 個欄位"], confirmLabel: "確認核准" };

function stubFetch(...responses: Response[]) {
  const fetchMock = vi.fn<typeof fetch>();
  responses.forEach((response) => fetchMock.mockResolvedValueOnce(response));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const mfaRequired = () => jsonResponse({ code: "MFA_REQUIRED", message: "需要多一道驗證" }, 401);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MfaProvider：API 層要求 MFA 時自動跳出 MfaDialog", () => {
  it("輸入驗證碼後帶著它重試，成功後關閉視窗", async () => {
    const fetchMock = stubFetch(mfaRequired(), jsonResponse({ approved: true }));
    render(<MfaProvider>頁面</MfaProvider>);

    const pending = api.post("/api/approvals/1/approve", { comment: "" }, { mfa: PROMPT });
    const dialog = await screen.findByRole("dialog", { name: "確認核准" });
    expect(dialog.textContent).toContain("DA-2026-0142｜銷售訂單 4 個欄位");

    await userEvent.type(screen.getByLabelText(CODE_LABEL), "482913");
    await userEvent.click(screen.getByRole("button", { name: "確認核准" }));

    await expect(pending).resolves.toEqual({ approved: true });
    const retryHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(retryHeaders["X-MFA-Code"]).toBe("482913");
    expect(retryHeaders["X-Requested-With"]).toBe("das-web");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("驗證碼被拒絕：視窗留著並顯示後端的訊息，重新輸入後通過", async () => {
    stubFetch(
      mfaRequired(),
      jsonResponse({ code: "MFA_INVALID", message: "驗證碼不正確，請再輸入一次。" }, 401),
      jsonResponse({ approved: true }),
    );
    render(<MfaProvider>頁面</MfaProvider>);
    const pending = api.post("/api/approvals/1/approve");

    await userEvent.type(await screen.findByLabelText(CODE_LABEL), "000000{Enter}");
    expect(await screen.findByText("驗證碼不正確，請再輸入一次。")).toBeTruthy();
    const input = screen.getByLabelText(CODE_LABEL) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe(""));

    await userEvent.type(input, "482913{Enter}");
    await expect(pending).resolves.toEqual({ approved: true });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("使用者取消：請求以 CLIENT_MFA_CANCELLED 結束，不會重送", async () => {
    const fetchMock = stubFetch(mfaRequired());
    render(<MfaProvider>頁面</MfaProvider>);
    const pending = api.post("/api/approvals/1/approve").catch((error: unknown) => error);

    await screen.findByRole("dialog");
    await userEvent.click(screen.getByRole("button", { name: "取消" }));

    const error = await pending;
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("CLIENT_MFA_CANCELLED");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
