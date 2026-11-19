/**
 * 資料抓取用的兩個小 hook。不做快取：畫面掛上時抓一次，要更新就呼叫 reload。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, CLIENT_ERROR, isAbortError, isApiError } from "./client";
import { t } from "../i18n/zh-Hant";

function asApiError(error: unknown): ApiError {
  if (isApiError(error)) return error;
  const message = error instanceof Error ? error.message : t.errors.unknown;
  return new ApiError(CLIENT_ERROR.unexpected, message, 0, error);
}

export interface QueryResult<T> {
  data: T | undefined;
  error: ApiError | null;
  /** 第一次載入、還沒有資料可以顯示。 */
  loading: boolean;
  /** 任何一次抓取進行中（包含 reload）。 */
  fetching: boolean;
  reload: () => void;
}

interface QueryState<T> {
  key: string | null;
  data: T | undefined;
  error: ApiError | null;
  fetching: boolean;
}

/**
 * key 改變就重新抓；key 為 null 表示先不抓（例如還沒拿到 id）。
 * 抓取中換 key 或畫面卸載時，會中止上一個請求。
 */
export function useQuery<T>(
  key: string | null,
  fetcher: (signal: AbortSignal) => Promise<T>,
): QueryResult<T> {
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<QueryState<T>>({
    key,
    data: undefined,
    error: null,
    fetching: key !== null,
  });

  useEffect(() => {
    if (key === null) return;
    const controller = new AbortController();
    // 換了 key 就不再顯示上一個 key 的資料；同一個 key 的 reload 保留舊資料。
    setState((prev) => ({
      key,
      data: prev.key === key ? prev.data : undefined,
      error: null,
      fetching: true,
    }));
    fetcherRef.current(controller.signal).then(
      (data) => setState({ key, data, error: null, fetching: false }),
      (error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) return;
        setState((prev) => ({ ...prev, error: asApiError(error), fetching: false }));
      },
    );
    return () => controller.abort();
  }, [key, version]);

  const reload = useCallback(() => setVersion((value) => value + 1), []);
  const current = state.key === key ? state : { data: undefined, error: null, fetching: key !== null };

  return {
    data: current.data,
    error: current.error,
    loading: current.fetching && current.data === undefined,
    fetching: current.fetching,
    reload,
  };
}

export interface MutationOptions<TResult> {
  onSuccess?: (result: TResult) => void;
  onError?: (error: ApiError) => void;
}

export interface MutationResult<TArgs, TResult> {
  /** 不會 reject：失敗時回傳 undefined，錯誤放在 error 並呼叫 onError。 */
  mutate: (args: TArgs) => Promise<TResult | undefined>;
  /** 失敗時 reject，給需要自己接錯誤的呼叫端。 */
  mutateAsync: (args: TArgs) => Promise<TResult>;
  loading: boolean;
  error: ApiError | null;
  reset: () => void;
}

export function useMutation<TArgs, TResult>(
  mutation: (args: TArgs) => Promise<TResult>,
  options: MutationOptions<TResult> = {},
): MutationResult<TArgs, TResult> {
  const mutationRef = useRef(mutation);
  mutationRef.current = mutation;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const mounted = useRef(true);
  const [state, setState] = useState<{ loading: boolean; error: ApiError | null }>({
    loading: false,
    error: null,
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const mutateAsync = useCallback(async (args: TArgs): Promise<TResult> => {
    setState({ loading: true, error: null });
    try {
      const result = await mutationRef.current(args);
      if (mounted.current) setState({ loading: false, error: null });
      optionsRef.current.onSuccess?.(result);
      return result;
    } catch (cause) {
      const error = asApiError(cause);
      if (mounted.current) setState({ loading: false, error });
      optionsRef.current.onError?.(error);
      throw error;
    }
  }, []);

  const mutate = useCallback(
    (args: TArgs) => mutateAsync(args).catch(() => undefined),
    [mutateAsync],
  );
  const reset = useCallback(() => setState({ loading: false, error: null }), []);

  return { mutate, mutateAsync, loading: state.loading, error: state.error, reset };
}
