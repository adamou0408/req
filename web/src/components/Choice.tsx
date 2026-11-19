import { useId } from "react";
import type { InputHTMLAttributes, ReactNode } from "react";
import { cx } from "../lib/cx";
import "./Choice.css";

export interface CheckboxProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "children"
> {
  label: ReactNode;
  /** 標籤後面的補充（例如欄位的級別標籤）。 */
  suffix?: ReactNode;
  hint?: ReactNode;
}

export function Checkbox({
  label,
  suffix,
  hint,
  className,
  id,
  ...rest
}: CheckboxProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const hintId = hint ? `${inputId}-hint` : undefined;
  return (
    <div
      className={cx("choice", rest.disabled && "choice--disabled", className)}
    >
      <label className="choice__row" htmlFor={inputId}>
        <input
          className="choice__input"
          type="checkbox"
          id={inputId}
          aria-describedby={hintId}
          {...rest}
        />
        <span className="choice__label">{label}</span>
        {suffix}
      </label>
      {hint && (
        <p className="choice__hint" id={hintId}>
          {hint}
        </p>
      )}
    </div>
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
}

export interface SegmentedProps<T extends string> {
  /** 這組選項在問什麼；會成為群組的名稱。 */
  legend: ReactNode;
  /** 畫面上已經有標題時，把 legend 留給螢幕閱讀器就好。 */
  hideLegend?: boolean;
  options: readonly SegmentedOption<T>[];
  value: T | null;
  onChange: (value: T) => void;
  hint?: ReactNode;
  disabled?: boolean;
}

/** 單選的一排選項。底層是原生 radio，方向鍵切換、空白鍵選取都由瀏覽器處理。 */
export function Segmented<T extends string>(props: SegmentedProps<T>) {
  const { legend, hideLegend, options, value, onChange, hint, disabled } =
    props;
  const name = useId();
  return (
    <fieldset className="seg" disabled={disabled}>
      <legend className={cx("seg__legend", hideLegend && "visually-hidden")}>
        {legend}
      </legend>
      <div className="seg__options">
        {options.map((option) => (
          <label
            key={option.value}
            className={cx(
              "seg__option",
              value === option.value && "seg__option--on",
            )}
          >
            <input
              className="choice__input"
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              disabled={option.disabled}
              onChange={() => onChange(option.value)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
      {hint && <p className="choice__hint">{hint}</p>}
    </fieldset>
  );
}
