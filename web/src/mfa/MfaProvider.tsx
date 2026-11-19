import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { MfaChallenge } from "../api/client";
import { api } from "../api/endpoints";
import { MfaDialog } from "../components";

interface DialogState {
  challenge: MfaChallenge;
  /** 驗證碼已送出，等後端回應。 */
  busy: boolean;
}

/**
 * 把 API 層的「需要 MFA」接到 MfaDialog：
 * 任何請求被後端要求 MFA 時，這裡跳出視窗要驗證碼，交回去讓 API 層重試。
 * 頁面不需要自己處理 MFA。
 */
export function MfaProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const resolver = useRef<((code: string | null) => void) | null>(null);

  useEffect(() => {
    api.setMfaHandler({
      request: (challenge) =>
        new Promise((resolve) => {
          resolver.current = resolve;
          setDialog({ challenge, busy: false });
        }),
      settle: () => {
        resolver.current = null;
        setDialog(null);
      },
    });
    return () => {
      api.setMfaHandler(null);
      resolver.current?.(null);
    };
  }, []);

  function answer(code: string | null) {
    resolver.current?.(code);
    resolver.current = null;
    if (code !== null)
      setDialog((current) => current && { ...current, busy: true });
  }

  const prompt = dialog?.challenge.prompt;
  return (
    <>
      {children}
      <MfaDialog
        open={dialog !== null}
        title={prompt?.title}
        summary={prompt?.summary}
        confirmLabel={prompt?.confirmLabel}
        error={dialog?.challenge.error?.message ?? null}
        busy={dialog?.busy ?? false}
        onSubmit={answer}
        onCancel={() => answer(null)}
      />
    </>
  );
}
