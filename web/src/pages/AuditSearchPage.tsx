import { PageHeader } from "../components";
import { t } from "../i18n/zh-Hant";
import { PagePlaceholder } from "./PagePlaceholder";

export default function AuditSearchPage() {
  return (
    <>
      <PageHeader title={t.pages.auditSearch.title} />
      <PagePlaceholder wireframes={["Audit-Search.dc.html"]} />
    </>
  );
}
