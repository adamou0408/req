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
export type ButtonSize = "md" | "sm";

interface ButtonStyleProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** 撐滿容器寬度（手機底部的主要動作常用）。 */
  block?: boolean;
}

function buttonClass(
  { variant = "default", size = "md", block }: ButtonStyleProps,
  extra?: string,
) {
  return cx(
    "btn",
    `btn--${variant}`,
    size === "sm" && "btn--sm",
    block && "btn--block",
    extra,
  );
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
      size,
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
          { variant, size, block },
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
  size,
  block,
  className,
  children,
  ...rest
}: ButtonLinkProps) {
  return (
    <Link
      className={buttonClass({ variant, size, block }, className)}
      {...rest}
    >
      <span className="btn__label">{children}</span>
    </Link>
  );
}
