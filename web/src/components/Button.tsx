import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Link } from "react-router";
import type { LinkProps } from "react-router";
import { cx } from "../lib/cx";
import "./Button.css";

export type ButtonVariant =
  | "default"
  | "primary"
  | "danger"
  | "danger-solid"
  | "ghost";

interface ButtonStyleProps {
  variant?: ButtonVariant;
  /** 撐滿容器寬度（手機底部的主要動作常用）。 */
  block?: boolean;
}

function buttonClass(
  { variant = "default", block }: ButtonStyleProps,
  extra?: string,
) {
  return cx("btn", `btn--${variant}`, block && "btn--block", extra);
}

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, ButtonStyleProps {
  /** 送出中：顯示轉圈、擋住重複點擊，但保留焦點。 */
  loading?: boolean;
  children: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant,
      block,
      loading = false,
      className,
      type = "button",
      onClick,
      children,
      ...rest
    },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type={type}
        className={buttonClass(
          { variant, block },
          cx(loading && "btn--loading", className),
        )}
        aria-busy={loading || undefined}
        aria-disabled={loading || undefined}
        onClick={loading ? (event) => event.preventDefault() : onClick}
        {...rest}
      >
        {loading && <span className="btn__spinner" aria-hidden="true" />}
        <span className="btn__label">{children}</span>
      </button>
    );
  },
);

export interface ButtonLinkProps extends LinkProps, ButtonStyleProps {}

/** 外觀是按鈕、行為是站內連結（換頁用連結，不用 onClick 導頁）。 */
export function ButtonLink({
  variant,
  block,
  className,
  children,
  ...rest
}: ButtonLinkProps) {
  return (
    <Link className={buttonClass({ variant, block }, className)} {...rest}>
      <span className="btn__label">{children}</span>
    </Link>
  );
}
