import { useEffect, useId, useState } from "react";
import type { FormEvent } from "react";
import { t } from "../i18n/zh-Hant";
import { Field } from "./Field";
import { DialogActions, Modal } from "./Modal";
import "./MfaDialog.css";

export const MFA_CODE_LENGTH = 6;

export interface MfaDialogProps {
  open: boolean;
  title?: string;
  /** 讓使用者核對這次要確認的是什麼（單號、範圍、起迄）。 */
  summary?: readonly string[];
  /** 上一次驗證碼被拒絕時的訊息；出現時會清空輸入並把焦點放回欄位。 */
  error?: string | null;
  /** 驗證碼送出後等待後端回應。 */
  busy?: boolean;
  confirmLabel?: string;
  onSubmit: (code: string) => void;
  onCancel: () => void;
}

type ContentProps = Omit<MfaDialogProps, "open">;

function MfaSummary({ lines }: { lines: readonly string[] }) {
  if (lines.length === 0) return null;
  return (
    <p className="mfa__summary">
      {lines.map((line, index) => (
        <span key={`${index}-${line}`}>{line}</span>
      ))}
    </p>
  );
}

function MfaDialogContent(props: ContentProps) {
  const { summary, error, busy = false, onSubmit, onCancel } = props;
  const formId = useId();
  const inputId = useId();
  const [code, setCode] = useState("");
  const complete = code.length === MFA_CODE_LENGTH;

  // 後端拒絕驗證碼後（busy 結束且帶著錯誤），清空重填；連續兩次同樣的錯誤訊息也要清。
  useEffect(() => {
    if (!error || busy) return;
    setCode("");
    document.getElementById(inputId)?.focus();
  }, [error, busy, inputId]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (complete && !busy) onSubmit(code);
  }

  const footer = (
    <DialogActions
      formId={formId}
      confirmLabel={props.confirmLabel ?? t.mfa.confirm}
      busy={busy}
      disabled={!complete}
      onCancel={onCancel}
    />
  );
  return (
    <Modal
      open
      title={props.title ?? t.mfa.title}
      onClose={onCancel}
      busy={busy}
      footer={footer}
      mobile="fullscreen"
    >
      <form id={formId} className="mfa" onSubmit={submit} noValidate>
        {summary && <MfaSummary lines={summary} />}
        <Field
          id={inputId}
          className="mfa__field"
          label={t.mfa.codeLabel}
          value={code}
          error={error}
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          maxLength={MFA_CODE_LENGTH}
          readOnly={busy}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
          data-autofocus
        />
        <p className="muted">{t.mfa.auditNote}</p>
      </form>
    </Modal>
  );
}

/** 核准前多一道驗證：輸入驗證器 App 的 6 位數驗證碼。手機上佔滿整個畫面。 */
export function MfaDialog({ open, ...rest }: MfaDialogProps) {
  return open ? <MfaDialogContent {...rest} /> : null;
}
