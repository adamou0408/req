import type { ReactNode } from "react";
import { t } from "../i18n/zh-Hant";
import { IconCheck, IconClose } from "./icons";
import "./Stepper.css";

/** 每一關的狀態由後端給，元件只負責畫。 */
export type StepState = "done" | "current" | "todo" | "rejected";

export interface StepPerson {
  name: string;
  /** 並行關卡裡每個人各自的進度；不給就只列名字。 */
  state?: StepState;
}

export interface StepItem {
  key: string;
  label: string;
  state: StepState;
  /** 關卡名稱下面的補充，例如「陳建宏・11-11」或「等你確認」。 */
  detail?: ReactNode;
  /** 並行簽核的人（資料擁有者關卡）。 */
  people?: readonly StepPerson[];
}

export interface StepperProps {
  /** 這條進度的名稱，例如「簽核路徑」。 */
  label: string;
  steps: readonly StepItem[];
}

function Marker({ state, index }: { state: StepState; index: number }) {
  if (state === "done") return <IconCheck size={16} />;
  if (state === "rejected") return <IconClose size={16} />;
  return <>{index + 1}</>;
}

function People({ people }: { people: readonly StepPerson[] }) {
  return (
    <ul className="stepper__people">
      {people.map((person) => (
        <li
          key={person.name}
          className={`stepper__person stepper__person--${person.state ?? "todo"}`}
        >
          {person.name}
          {person.state && (
            <span className="stepper__person-state">
              {t.stepper.state[person.state]}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

export function Stepper({ label, steps }: StepperProps) {
  return (
    <ol className="stepper" aria-label={label}>
      {steps.map((step, index) => (
        <li
          key={step.key}
          className={`stepper__step stepper__step--${step.state}`}
          aria-current={step.state === "current" ? "step" : undefined}
        >
          <span className="stepper__marker" aria-hidden="true">
            <Marker state={step.state} index={index} />
          </span>
          <div className="stepper__text">
            <span className="stepper__label">
              {step.label}
              <span className="visually-hidden">
                （{t.stepper.state[step.state]}）
              </span>
            </span>
            {step.detail && (
              <span className="stepper__detail">{step.detail}</span>
            )}
            {step.people && <People people={step.people} />}
          </div>
        </li>
      ))}
    </ol>
  );
}
