import { useParams } from "react-router";
import { PageHeader } from "../components";
import { t } from "../i18n/zh-Hant";
import { PagePlaceholder } from "./PagePlaceholder";

export default function AuditEvidencePage() {
  const { id = "" } = useParams();
  return (
    <>
      <PageHeader
        title={t.pages.auditEvidence.title}
        back={{ to: "/audit", label: t.pages.auditSearch.title }}
        meta={t.pages.auditEvidence.meta(id)}
      />
      <PagePlaceholder wireframes={["Audit-Evidence.dc.html"]} />
    </>
  );
}
