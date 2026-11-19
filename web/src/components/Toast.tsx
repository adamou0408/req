import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { t } from "../i18n/zh-Hant";
import { IconClose } from "./icons";
import "./Toast.css";

export type ToastTone = "info" | "success" | "error";

interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
}

export interface ToastApi {
  show: (message: string, tone?: ToastTone) => void;
  success: (message: string) => void;
  /** 錯誤訊息不會自動消失，要使用者自己關掉。 */
  error: (message: string) => void;
}

/** 成功與一般訊息停留的時間；錯誤訊息不自動消失。 */
export const TOAST_DURATION_MS = 5000;

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast 必須用在 ToastProvider 裡面");
  return api;
}

function useToastQueue() {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const show = useCallback(
    (message: string, tone: ToastTone = "info") => {
      const id = nextId.current++;
      setItems((current) => [...current, { id, tone, message }]);
      if (tone === "error") return;
      const timer = setTimeout(() => {
        timers.current.delete(timer);
        dismiss(id);
      }, TOAST_DURATION_MS);
      timers.current.add(timer);
    },
    [dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);

  return { items, show, dismiss };
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const { items, show, dismiss } = useToastQueue();
  const api = useMemo<ToastApi>(
    () => ({
      show,
      success: (message) => show(message, "success"),
      error: (message) => show(message, "error"),
    }),
    [show],
  );
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" role="region" aria-label={t.toast.region}>
        {items.map((item) => (
          <div
            key={item.id}
            className={`toast toast--${item.tone}`}
            role={item.tone === "error" ? "alert" : "status"}
          >
            <p className="toast__message">{item.message}</p>
            <button
              type="button"
              className="toast__close"
              aria-label={t.toast.dismiss}
              onClick={() => dismiss(item.id)}
            >
              <IconClose size={18} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
