import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./client";
import { useMutation, useQuery } from "./hooks";

const boom = new ApiError("REQUEST_NOT_FOUND", "找不到這張單", 404);

describe("useQuery", () => {
  it("先 loading，再給資料", async () => {
    const { result } = renderHook(() =>
      useQuery("k", () => Promise.resolve("資料")),
    );
    expect(result.current).toMatchObject({
      loading: true,
      data: undefined,
      error: null,
    });
    await waitFor(() => expect(result.current.data).toBe("資料"));
    expect(result.current).toMatchObject({
      loading: false,
      fetching: false,
      error: null,
    });
  });

  it("失敗時把錯誤放在 error", async () => {
    const { result } = renderHook(() =>
      useQuery("k", () => Promise.reject(boom)),
    );
    await waitFor(() => expect(result.current.error).toBe(boom));
    expect(result.current.loading).toBe(false);
  });

  it("reload 重新抓，期間保留舊資料（loading 為 false、fetching 為 true）", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce("第一次")
      .mockResolvedValueOnce("第二次");
    const { result } = renderHook(() => useQuery("k", fetcher));
    await waitFor(() => expect(result.current.data).toBe("第一次"));
    act(() => result.current.reload());
    expect(result.current).toMatchObject({
      data: "第一次",
      loading: false,
      fetching: true,
    });
    await waitFor(() => expect(result.current.data).toBe("第二次"));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("key 為 null 時不抓", () => {
    const fetcher = vi.fn();
    const { result } = renderHook(() => useQuery<string>(null, fetcher));
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({
      loading: false,
      fetching: false,
      data: undefined,
    });
  });

  it("換 key：不顯示上一個 key 的資料，並中止上一個請求", async () => {
    const signals: AbortSignal[] = [];
    const fetcher = (id: string) => (signal: AbortSignal) => {
      signals.push(signal);
      return Promise.resolve(`單 ${id}`);
    };
    const { result, rerender } = renderHook(
      ({ id }) => useQuery(id, fetcher(id)),
      {
        initialProps: { id: "1" },
      },
    );
    await waitFor(() => expect(result.current.data).toBe("單 1"));
    rerender({ id: "2" });
    expect(result.current).toMatchObject({ data: undefined, loading: true });
    await waitFor(() => expect(result.current.data).toBe("單 2"));
    expect(signals[0]?.aborted).toBe(true);
  });
});

describe("useMutation", () => {
  it("成功：回傳結果並呼叫 onSuccess", async () => {
    const onSuccess = vi.fn();
    const { result } = renderHook(() =>
      useMutation((id: string) => Promise.resolve(`已核准 ${id}`), {
        onSuccess,
      }),
    );
    let returned: string | undefined;
    await act(async () => {
      returned = await result.current.mutate("DA-1");
    });
    expect(returned).toBe("已核准 DA-1");
    expect(onSuccess).toHaveBeenCalledWith("已核准 DA-1");
    expect(result.current).toMatchObject({ loading: false, error: null });
  });

  it("失敗：mutate 不會 reject，錯誤放在 error 並呼叫 onError", async () => {
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useMutation(() => Promise.reject(boom), { onError }),
    );
    let returned: unknown = "尚未回傳";
    await act(async () => {
      returned = await result.current.mutate(undefined);
    });
    expect(returned).toBeUndefined();
    expect(result.current.error).toBe(boom);
    expect(onError).toHaveBeenCalledWith(boom);
    act(() => result.current.reset());
    expect(result.current.error).toBeNull();
  });

  it("mutateAsync 失敗時 reject；不是 ApiError 的錯誤也會包成 ApiError", async () => {
    const { result } = renderHook(() =>
      useMutation(() => Promise.reject(new Error("壞了"))),
    );
    let error: unknown;
    await act(async () => {
      error = await result.current
        .mutateAsync(undefined)
        .catch((reason: unknown) => reason);
    });
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: "CLIENT_UNEXPECTED", message: "壞了" });
  });

  it("進行中 loading 為 true", async () => {
    let finish: (value: string) => void = () => undefined;
    const pending = new Promise<string>((resolve) => {
      finish = resolve;
    });
    const { result } = renderHook(() => useMutation(() => pending));
    act(() => void result.current.mutate(undefined));
    expect(result.current.loading).toBe(true);
    await act(async () => {
      finish("好了");
      await pending;
    });
    expect(result.current.loading).toBe(false);
  });
});
