import { useId, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { t } from "../i18n/zh-Hant";
import { Alert } from "./Alert";
import { Field } from "./Field";
import { DialogActions, Modal } from "./Modal";

export interface ConfirmReasonOptions {
  label?: string;
  hint?: string;
  /** 預設必填（撤銷、退回、改設定都必須留原因）。 */
  required?: boolean;
}

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** 這個動作會造成什麼結果。 */
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** danger 用在撤銷、退回這類動作。 */
  tone?: "primary" | "danger";
  /** 給了就會多一個「原因」欄位，內容傳給 onConfirm。 */
  reason?: ConfirmReasonOptions;
  /** 回傳 Promise 時，對話框會顯示送出中；失敗會把訊息留在對話框裡。 */
  onConfirm: (reason: string) => void | Promise<void>;
  onCancel: () => void;
}

type ContentProps = Omit<ConfirmDialogProps, "open">;

function useConfirmSubmit({ reason, onConfirm }: ContentProps) {
  const [text, setText] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = text.trim();
    if (reason && reason.required !== false && trimmed === "") {
      setFieldError(t.confirm.reasonRequired);
      return;
    }
    setFieldError(null);
    setSubmitError(null);
    setBusy(true);
    try {
      await onConfirm(trimmed);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : t.errors.unknown);
    } finally {
      setBusy(false);
    }
  }

  return { text, setText, fieldError, submitError, busy, submit };
}

function ConfirmDialogContent(props: ContentProps) {
  const { title, children, tone = "primary", reason, onCancel } = props;
  const formId = useId();
  const form = useConfirmSubmit(props);
  const footer = (
    <DialogActions
      formId={formId}
      confirmLabel={props.confirmLabel ?? t.common.confirm}
      cancelLabel={props.cancelLabel}
      variant={tone === "danger" ? "danger-solid" : "primary"}
      busy={form.busy}
      onCancel={onCancel}
    />
  );
  return (
    <Modal
      open
      title={title}
      onClose={onCancel}
      busy={form.busy}
      footer={footer}
    >
      <form id={formId} className="stack" onSubmit={form.submit} noValidate>
        {children && <div>{children}</div>}
        {reason && (
          <Field
            as="textarea"
            label={reason.label ?? t.confirm.reasonLabel}
            hint={reason.hint}
            required={reason.required !== false}
            value={form.text}
            error={form.fieldError}
            onChange={(event) => form.setText(event.target.value)}
            data-autofocus
          />
        )}
        {form.submitError && (
          <Alert tone="danger" live>
            {form.submitError}
          </Alert>
        )}
      </form>
    </Modal>
  );
}

/** 需要使用者再確認一次的動作；可以要求填原因。每次開啟都是全新的狀態。 */
export function ConfirmDialog({ open, ...rest }: ConfirmDialogProps) {
  return open ? <ConfirmDialogContent {...rest} /> : null;
}
