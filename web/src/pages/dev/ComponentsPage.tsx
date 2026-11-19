import { PageHeader } from "../../components";
import {
  AlertSection,
  ButtonSection,
  ChoiceSection,
  FieldSection,
  KeyValueSection,
  PageHeaderSection,
  StateSection,
  TabsSection,
  TagSection,
} from "./basicSections";
import {
  DataListSection,
  DiffListSection,
  StepperSection,
  TimelineSection,
} from "./dataSections";
import {
  ActionBarSection,
  ConfirmDialogSection,
  MfaDialogSection,
  ToastSection,
} from "./overlaySections";
import "./ComponentsPage.css";

/**
 * 共用元件展示頁（只在開發模式）。這一頁的文字是展示用的範例內容，
 * 所以直接寫在這個資料夾裡，不放進 i18n。
 */
export default function ComponentsPage() {
  return (
    <main className="devpage">
      <PageHeader
        title="共用元件"
        meta="開發用展示頁：每個元件的各種狀態。深色主題跟隨系統設定。"
      />
      <ButtonSection />
      <TagSection />
      <AlertSection />
      <FieldSection />
      <ChoiceSection />
      <TabsSection />
      <DataListSection />
      <StepperSection />
      <TimelineSection />
      <DiffListSection />
      <KeyValueSection />
      <ConfirmDialogSection />
      <MfaDialogSection />
      <ToastSection />
      <StateSection />
      <PageHeaderSection />
      <ActionBarSection />
    </main>
  );
}
