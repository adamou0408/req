import { useId } from "react";
import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { cx } from "../lib/cx";
import { t } from "../i18n/zh-Hant";
import "./Field.css";

export interface FieldOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface FieldBaseProps {
  label: ReactNode;
  /** 欄位下方的說明文字。 */
  hint?: ReactNode;
  /** 有值時欄位標成錯誤，並由螢幕閱讀器連同欄位一起讀出。 */
  error?: string | null;
  /** 值被目前使用者改過（例如簽核人縮短期間）時的醒目標示。 */
  changed?: boolean;
  className?: string;
}

type InputFieldProps = FieldBaseProps & { as?: "input" } & Omit<
    InputHTMLAttributes<HTMLInputElement>,
    "children"
  >;

type SelectFieldProps = FieldBaseProps & {
  as: "select";
  options: readonly FieldOption[];
  /** 尚未選擇時顯示的第一個選項。 */
  placeholder?: string;
} & Omit<SelectHTMLAttributes<HTMLSelectElement>, "children">;

type TextareaFieldProps = FieldBaseProps & { as: "textarea" } & Omit<
    TextareaHTMLAttributes<HTMLTextAreaElement>,
    "children"
  >;

export type FieldProps = InputFieldProps | SelectFieldProps | TextareaFieldProps;

type ControlProps =
  | Omit<InputFieldProps, keyof FieldBaseProps>
  | Omit<SelectFieldProps, keyof FieldBaseProps>
  | Omit<TextareaFieldProps, keyof FieldBaseProps>;

interface SharedControlProps {
  id: string;
  className: string;
  "aria-invalid": true | undefined;
  "aria-describedby": string | undefined;
}

function renderControl(control: ControlProps, shared: SharedControlProps) {
  if (control.as === "select") {
    const { as: _as, options, placeholder, ...rest } = control;
    return (
      <select {...rest} {...shared}>
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }
  if (control.as === "textarea") {
    const { as: _as, rows = 3, ...rest } = control;
    return <textarea rows={rows} {...rest} {...shared} />;
  }
  const { as: _as, type = "text", ...rest } = control;
  return <input type={type} {...rest} {...shared} />;
}

export function Field(props: FieldProps) {
  const { label, hint, error, changed, className, ...control } = props;
  const autoId = useId();
  const id = control.id ?? autoId;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const shared: SharedControlProps = {
    id,
    className: cx("field__control", changed && "field__control--changed"),
    "aria-invalid": error ? true : undefined,
    "aria-describedby": [hintId, errorId].filter(Boolean).join(" ") || undefined,
  };
  return (
    <div className={cx("field", error && "field--error", className)}>
      <label className="field__label" htmlFor={id}>
        {label}
        {control.required && <span className="field__required">{t.common.requiredMark}</span>}
      </label>
      {renderControl(control, shared)}
      {hint && (
        <p className="field__hint" id={hintId}>
          {hint}
        </p>
      )}
      {error && (
        <p className="field__error" id={errorId}>
          {error}
        </p>
      )}
    </div>
  );
}
