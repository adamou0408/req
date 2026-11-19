import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { api } from "../api/endpoints";
import { jsonResponse } from "../test/render";
import { MfaProvider } from "./MfaProvider";

const CODE_LABEL = "輸入驗證器 App 上的 6 位數驗證碼";
const PROMPT = {
  title: "確認核准",
  summary: ["DA-2026-0142｜銷售訂單 4 個欄位"],
  confirmLabel: "確認核准",
};

function stubFetch(...responses: Response[]) {
  const fetchMock = vi.fn<typeof fetch>();
  responses.forEach((response) => fetchMock.mockResolvedValueOnce(response));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const mfaRequired = () =>
  jsonResponse(
    { code: "mfa_required", message: "這個動作需要再驗證一次身分" },
    403,
  );
const mfaVerified = () => jsonResponse({ mfa_verified: true });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MfaProvider：API 層要求 MFA 時自動跳出 MfaDialog", () => {
  it("輸入驗證碼後交給後端驗證，通過就重送原本的請求並關閉視窗", async () => {
    const fetchMock = stubFetch(
      mfaRequired(),
      mfaVerified(),
      jsonResponse({ approved: true }),
    );
    render(<MfaProvider>頁面</MfaProvider>);

    const pending = api.post(
      "/api/tasks/1/approve",
      { comment: "" },
      { mfa: PROMPT },
    );
    const dialog = await screen.findByRole("dialog", { name: "確認核准" });
    expect(dialog.textContent).toContain("DA-2026-0142｜銷售訂單 4 個欄位");

    await userEvent.type(screen.getByLabelText(CODE_LABEL), "482913");
    await userEvent.click(screen.getByRole("button", { name: "確認核准" }));

    await expect(pending).resolves.toEqual({ approved: true });
    const [verifyUrl, verifyInit] = fetchMock.mock.calls[1] ?? [];
    expect(verifyUrl).toBe("/api/auth/mfa/verify");
    expect(verifyInit?.body).toBe('{"code":"482913"}');
    expect(
      (verifyInit?.headers as Record<string, string>)["X-Requested-With"],
    ).toBe("sgn-web");
    expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/tasks/1/approve");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("驗證碼被拒絕：視窗留著並顯示後端的訊息，重新輸入後通過", async () => {
    stubFetch(
      mfaRequired(),
      jsonResponse({ code: "mfa_invalid", message: "驗證碼不正確" }, 422),
      mfaVerified(),
      jsonResponse({ approved: true }),
    );
    render(<MfaProvider>頁面</MfaProvider>);
    const pending = api.post("/api/tasks/1/approve");

    await userEvent.type(
      await screen.findByLabelText(CODE_LABEL),
      "000000{Enter}",
    );
    expect(await screen.findByText("驗證碼不正確")).toBeTruthy();
    const input = screen.getByLabelText(CODE_LABEL) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe(""));

    await userEvent.type(input, "482913{Enter}");
    await expect(pending).resolves.toEqual({ approved: true });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("使用者取消：請求以 client_mfa_cancelled 結束，不會重送", async () => {
    const fetchMock = stubFetch(mfaRequired());
    render(<MfaProvider>頁面</MfaProvider>);
    const pending = api
      .post("/api/tasks/1/approve")
      .catch((error: unknown) => error);

    await screen.findByRole("dialog");
    await userEvent.click(screen.getByRole("button", { name: "取消" }));

    const error = await pending;
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("client_mfa_cancelled");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
