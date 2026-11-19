import { useEffect } from "react";
import { t } from "../i18n/zh-Hant";

export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = `${title}｜${t.app.name}`;
  }, [title]);
}
