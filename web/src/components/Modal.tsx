import { useEffect, useId, useRef } from "react";
import type { KeyboardEvent, MouseEvent, ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import { cx } from "../lib/cx";
import { t } from "../i18n/zh-Hant";
import { Button } from "./Button";
import type { ButtonVariant } from "./Button";
import { IconClose } from "./icons";
import "./Modal.css";

export interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** 送出中：不能用 Esc、背景或關閉鈕關掉，避免使用者以為已經取消。 */
  busy?: boolean;
  /** 手機上的樣子：sheet 從底部滑出；fullscreen 佔滿整個畫面。 */
  mobile?: "sheet" | "fullscreen";
}

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

let openCount = 0;

/** 開著彈窗時鎖住背景捲動；多個彈窗疊在一起時，全部關掉才解鎖。 */
function useScrollLock() {
  useEffect(() => {
    openCount += 1;
    document.documentElement.classList.add("modal-open");
    return () => {
      openCount -= 1;
      if (openCount === 0)
        document.documentElement.classList.remove("modal-open");
    };
  }, []);
}

/** 開啟時把焦點移進彈窗，關閉時還給原本的元素。 */
function useFocusOnOpen(dialogRef: RefObject<HTMLDivElement>) {
  useEffect(() => {
    const dialog = dialogRef.current;
    const previous = document.activeElement;
    const preferred = dialog?.querySelector<HTMLElement>("[data-autofocus]");
    const firstInBody = dialog?.querySelector<HTMLElement>(
      `.modal__body :is(${FOCUSABLE})`,
    );
    (preferred ?? firstInBody ?? dialog)?.focus();
    return () => {
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [dialogRef]);
}

/** Tab 走到最後一個可聚焦元素時繞回第一個，焦點不會跑到彈窗後面。 */
function trapTab(event: KeyboardEvent, dialog: HTMLElement) {
  const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
  const first = items[0];
  const last = items[items.length - 1];
  if (!first || !last) {
    event.preventDefault();
    return;
  }
  const active = document.activeElement;
  if (event.shiftKey && (active === first || active === dialog)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

interface ModalHeadProps {
  title: string;
  titleId: string;
  busy: boolean;
  onClose: () => void;
}

function ModalHead({ title, titleId, busy, onClose }: ModalHeadProps) {
  return (
    <div className="modal__head">
      <h2 className="modal__title" id={titleId}>
        {title}
      </h2>
      <button
        type="button"
        className="modal__close"
        aria-label={t.common.close}
        disabled={busy}
        onClick={onClose}
      >
        <IconClose />
      </button>
    </div>
  );
}

function ModalContent({
  title,
  onClose,
  children,
  footer,
  busy = false,
  mobile = "sheet",
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useScrollLock();
  useFocusOnOpen(dialogRef);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Tab") trapTab(event, event.currentTarget);
    if (event.key !== "Escape") return;
    event.stopPropagation();
    if (!busy) onClose();
  }

  function onBackdrop(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget && !busy) onClose();
  }

  return (
    <div className={cx("modal", `modal--${mobile}`)} onMouseDown={onBackdrop}>
      <div
        ref={dialogRef}
        className="modal__dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <ModalHead
          title={title}
          titleId={titleId}
          busy={busy}
          onClose={onClose}
        />
        <div className="modal__body">{children}</div>
        {footer && <div className="modal__foot">{footer}</div>}
      </div>
    </div>
  );
}

/** ConfirmDialog 與 MfaDialog 共用的彈窗外殼：焦點管理、Esc、背景點擊、捲動鎖定。 */
export function Modal(props: ModalProps) {
  if (!props.open) return null;
  return createPortal(<ModalContent {...props} />, document.body);
}

export interface DialogActionsProps {
  /** 確認鈕要送出的表單（表單在彈窗內容裡，按鈕在頁尾）。 */
  formId: string;
  confirmLabel: string;
  cancelLabel?: string;
  variant?: ButtonVariant;
  busy: boolean;
  /** 還不能送出（例如驗證碼還沒填滿）。 */
  disabled?: boolean;
  onCancel: () => void;
}

/** 彈窗頁尾的「取消／確認」。確認鈕永遠在右邊。 */
export function DialogActions(props: DialogActionsProps) {
  return (
    <>
      <Button onClick={props.onCancel} disabled={props.busy}>
        {props.cancelLabel ?? t.common.cancel}
      </Button>
      <Button
        type="submit"
        form={props.formId}
        variant={props.variant ?? "primary"}
        loading={props.busy}
        disabled={props.disabled}
      >
        {props.confirmLabel}
      </Button>
    </>
  );
}
