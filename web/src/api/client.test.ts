import { describe, expect, it, vi } from "vitest";
import { ApiError, CLIENT_ERROR, buildUrl, createClient } from "./client";
import type { MfaChallenge, MfaHandler } from "./client";
import { jsonResponse } from "../test/render";

type FetchArgs = [input: RequestInfo | URL, init?: RequestInit];

/** 讓 fetch 本身失敗（連不上、被中止）。 */
class FetchFailure {
  constructor(readonly reason: unknown) {}
}

function setup(...responses: Array<Response | FetchFailure>) {
  const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>();
  for (const response of responses) {
    if (response instanceof FetchFailure) fetchMock.mockRejectedValueOnce(response.reason);
    else fetchMock.mockResolvedValueOnce(response);
  }
  const client = createClient({
    unsafeMethodHeader: { name: "X-Requested-With", value: "das-web" },
    mfaRequiredCodes: ["MFA_REQUIRED"],
    mfaInvalidCodes: ["MFA_INVALID"],
    mfaHeaders: (code) => ({ "X-MFA-Code": code }),
    fetch: fetchMock,
  });
  const onUnauthorized = vi.fn();
  client.setUnauthorizedHandler(onUnauthorized);
  const headersOf = (call: number) => fetchMock.mock.calls[call]?.[1]?.headers as Record<string, string>;
  return { client, fetchMock, onUnauthorized, headersOf };
}

function mfaHandler(...codes: Array<string | null>) {
  const challenges: MfaChallenge[] = [];
  const handler: MfaHandler = {
    request: vi.fn((challenge: MfaChallenge) => {
      challenges.push(challenge);
      return Promise.resolve(codes.shift() ?? null);
    }),
    settle: vi.fn(),
  };
  return { handler, challenges };
}

async function caught(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

const mfaRequired = () => jsonResponse({ code: "MFA_REQUIRED", message: "需要多一道驗證" }, 401);
const mfaInvalid = () => jsonResponse({ code: "MFA_INVALID", message: "驗證碼不正確" }, 401);

describe("buildUrl", () => {
  it("略過 null 與 undefined，陣列展開成多個同名參數", () => {
    const url = buildUrl("", "/api/requests", { status: ["draft", "active"], q: null, page: 2, x: undefined });
    expect(url).toBe("/api/requests?status=draft&status=active&page=2");
  });
});

describe("一般請求", () => {
  it("GET 帶 cookie、不加自訂標頭，回傳解析後的 JSON", async () => {
    const { client, fetchMock, headersOf } = setup(jsonResponse({ id: 1 }));
    await expect(client.get("/api/x", { query: { a: 1 } })).resolves.toEqual({ id: 1 });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/x?a=1");
    expect(init?.method).toBe("GET");
    expect(init?.credentials).toBe("same-origin");
    expect(headersOf(0)["X-Requested-With"]).toBeUndefined();
  });

  it.each(["post", "put", "patch"] as const)("%s 加上自訂標頭並把 body 轉成 JSON", async (method) => {
    const { client, fetchMock, headersOf } = setup(jsonResponse({ ok: true }));
    await client[method]("/api/x", { reason: "測試" });
    expect(headersOf(0)["X-Requested-With"]).toBe("das-web");
    expect(headersOf(0)["Content-Type"]).toBe("application/json");
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe('{"reason":"測試"}');
  });

  it("DELETE 也算非 GET，要加自訂標頭", async () => {
    const { client, headersOf } = setup(new Response(null, { status: 204 }));
    await expect(client.delete("/api/x")).resolves.toBeUndefined();
    expect(headersOf(0)["X-Requested-With"]).toBe("das-web");
  });
});

describe("錯誤統一成 {code, message}", () => {
  it("後端回 {code, message}：原樣帶出並附上 HTTP 狀態", async () => {
    const { client, onUnauthorized } = setup(jsonResponse({ code: "REQUEST_NOT_FOUND", message: "找不到這張單" }, 404));
    const error = await caught(client.get("/api/x"));
    expect(error).toMatchObject({ code: "REQUEST_NOT_FOUND", message: "找不到這張單", status: 404 });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("後端回 {error: {code, message}}：也認得", async () => {
    const { client } = setup(jsonResponse({ error: { code: "FORBIDDEN", message: "沒有權限" } }, 403));
    const error = await caught(client.get("/api/x"));
    expect(error).toMatchObject({ code: "FORBIDDEN", message: "沒有權限", status: 403 });
  });

  it("回應不是 JSON（例如反向代理的錯誤頁）：用 HTTP 狀態組出代碼與訊息", async () => {
    const { client } = setup(new Response("<html>Bad Gateway</html>", { status: 502 }));
    const error = await caught(client.get("/api/x"));
    expect(error.code).toBe("HTTP_502");
    expect(error.message).toContain("502");
  });

  it("連不上後端：CLIENT_NETWORK_ERROR，狀態為 0", async () => {
    const { client } = setup(new FetchFailure(new TypeError("Failed to fetch")));
    const error = await caught(client.get("/api/x"));
    expect(error).toMatchObject({ code: CLIENT_ERROR.network, status: 0 });
  });

  it("成功但內容不是 JSON：CLIENT_BAD_RESPONSE", async () => {
    const { client } = setup(new Response("<html></html>", { status: 200, headers: { "Content-Type": "text/html" } }));
    const error = await caught(client.get("/api/x"));
    expect(error.code).toBe(CLIENT_ERROR.badResponse);
  });

  it("請求被中止：原樣丟出 AbortError，不包成 ApiError", async () => {
    const { client } = setup(new FetchFailure(new DOMException("aborted", "AbortError")));
    await expect(client.get("/api/x")).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("401", () => {
  it("通知身分層（由它導向登入），並把錯誤丟給呼叫端", async () => {
    const { client, onUnauthorized } = setup(jsonResponse({ code: "UNAUTHENTICATED", message: "尚未登入" }, 401));
    const error = await caught(client.get("/api/x"));
    expect(error.status).toBe(401);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("MFA 驗證通過後重試才發現登入過期：一樣通知身分層", async () => {
    const { client, onUnauthorized } = setup(mfaRequired(), jsonResponse({ code: "UNAUTHENTICATED", message: "尚未登入" }, 401));
    const { handler } = mfaHandler("123456");
    client.setMfaHandler(handler);
    await caught(client.post("/api/x"));
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(handler.settle).toHaveBeenCalledTimes(1);
  });
});

describe("需要 MFA", () => {
  it("向使用者要驗證碼，帶著驗證碼重試同一個請求", async () => {
    const { client, fetchMock, onUnauthorized, headersOf } = setup(mfaRequired(), jsonResponse({ approved: true }));
    const { handler, challenges } = mfaHandler("123456");
    client.setMfaHandler(handler);
    const prompt = { title: "確認核准", summary: ["DA-2026-0142"] };

    await expect(client.post("/api/approve", { id: 1 }, { mfa: prompt })).resolves.toEqual({ approved: true });

    expect(challenges).toEqual([{ attempt: 1, prompt }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(headersOf(0)["X-MFA-Code"]).toBeUndefined();
    expect(headersOf(1)["X-MFA-Code"]).toBe("123456");
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe('{"id":1}');
    expect(handler.settle).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("驗證碼被拒絕：帶著錯誤再問一次，直到通過", async () => {
    const { client, fetchMock, headersOf } = setup(mfaRequired(), mfaInvalid(), jsonResponse({ approved: true }));
    const { handler, challenges } = mfaHandler("000000", "123456");
    client.setMfaHandler(handler);

    await expect(client.post("/api/approve")).resolves.toEqual({ approved: true });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(challenges[1]).toMatchObject({ attempt: 2, error: { code: "MFA_INVALID", message: "驗證碼不正確" } });
    expect(headersOf(2)["X-MFA-Code"]).toBe("123456");
    expect(handler.settle).toHaveBeenCalledTimes(1);
  });

  it("連續三次被拒絕：不再問，把後端的錯誤丟出", async () => {
    const { client, fetchMock, onUnauthorized } = setup(mfaRequired(), mfaInvalid(), mfaInvalid(), mfaInvalid());
    const { handler } = mfaHandler("111111", "222222", "333333");
    client.setMfaHandler(handler);
    const error = await caught(client.post("/api/approve"));
    expect(error.code).toBe("MFA_INVALID");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(handler.request).toHaveBeenCalledTimes(3);
    expect(handler.settle).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("使用者取消：不重試，丟出 CLIENT_MFA_CANCELLED", async () => {
    const { client, fetchMock, onUnauthorized } = setup(mfaRequired());
    const { handler } = mfaHandler(null);
    client.setMfaHandler(handler);
    const error = await caught(client.post("/api/approve"));
    expect(error.code).toBe(CLIENT_ERROR.mfaCancelled);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(handler.settle).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("重試時遇到其他錯誤：直接丟出，不再問驗證碼", async () => {
    const { client } = setup(mfaRequired(), jsonResponse({ code: "STAGE_ALREADY_DECIDED", message: "這一關已經簽過" }, 409));
    const { handler } = mfaHandler("123456");
    client.setMfaHandler(handler);
    const error = await caught(client.post("/api/approve"));
    expect(error).toMatchObject({ code: "STAGE_ALREADY_DECIDED", status: 409 });
    expect(handler.request).toHaveBeenCalledTimes(1);
  });

  it("沒有註冊 MFA 視窗：把 MFA_REQUIRED 原樣丟出，不當成登入過期", async () => {
    const { client, onUnauthorized } = setup(mfaRequired());
    const error = await caught(client.post("/api/approve"));
    expect(error.code).toBe("MFA_REQUIRED");
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("兩個請求同時需要 MFA：一次只問一個", async () => {
    const { client } = setup(mfaRequired(), mfaRequired(), jsonResponse({ n: 1 }), jsonResponse({ n: 2 }));
    let open = 0;
    let maxOpen = 0;
    const answers: Array<(code: string) => void> = [];
    client.setMfaHandler({
      request: () => {
        open += 1;
        maxOpen = Math.max(maxOpen, open);
        return new Promise((resolve) => answers.push(resolve));
      },
      settle: () => {
        open -= 1;
      },
    });
    const both = Promise.all([client.post("/api/a"), client.post("/api/b")]);
    await vi.waitFor(() => expect(answers).toHaveLength(1));
    answers[0]?.("111111");
    await vi.waitFor(() => expect(answers).toHaveLength(2));
    answers[1]?.("222222");
    await expect(both).resolves.toHaveLength(2);
    expect(maxOpen).toBe(1);
  });
});
