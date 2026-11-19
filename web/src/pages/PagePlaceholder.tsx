import { EmptyState } from "../components";
import { t } from "../i18n/zh-Hant";

export interface PagePlaceholderProps {
  /** 這一頁要照著做的 wireframe 檔名（在 docs/wireframes/ 底下）。 */
  wireframes: readonly string[];
}

/** 頁面骨架的佔位內容：標明這一頁對應哪一張 wireframe，實作後整個換掉。 */
export function PagePlaceholder({ wireframes }: PagePlaceholderProps) {
  const files = wireframes
    .map((file) => `${t.pages.wireframeDir}${file}`)
    .join("、");
  return (
    <EmptyState
      title={t.pages.placeholderTitle}
      description={t.pages.placeholderBody(files)}
    />
  );
}
