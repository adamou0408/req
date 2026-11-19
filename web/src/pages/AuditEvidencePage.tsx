import { useParams } from "react-router";
import { ID_PARAM, PATHS } from "../app/paths";
import { PageHeader } from "../components";
import { t } from "../i18n/zh-Hant";
import { PagePlaceholder } from "./PagePlaceholder";

export default function AuditEvidencePage() {
  const id = useParams()[ID_PARAM] ?? "";
  return (
    <>
      <PageHeader
        title={t.pages.auditEvidence.title}
        back={{ to: PATHS.audit, label: t.pages.auditSearch.title }}
        meta={t.pages.auditEvidence.meta(id)}
      />
      <PagePlaceholder wireframes={["Audit-Evidence.dc.html"]} />
    </>
  );
}
