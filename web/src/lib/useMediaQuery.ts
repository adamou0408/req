import { useCallback, useSyncExternalStore } from "react";

/** 手機斷點：寬度小於 640px。樣式檔裡的 639.98px 是同一個值。 */
export const MOBILE_QUERY = "(max-width: 639.98px)";

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches);
}

export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_QUERY);
}
