import { useParams } from "react-router";
import { ID_PARAM, PATHS } from "../app/paths";
import { PageHeader } from "../components";
import { t } from "../i18n/zh-Hant";
import { PagePlaceholder } from "./PagePlaceholder";

export default function FulfilmentDetailPage() {
  const id = useParams()[ID_PARAM] ?? "";
  return (
    <>
      <PageHeader
        title={t.pages.fulfilmentDetail.title}
        back={{ to: PATHS.fulfilment, label: t.pages.fulfilmentQueue.title }}
        meta={t.pages.fulfilmentDetail.meta(id)}
      />
      <PagePlaceholder wireframes={["MIS-Check.dc.html"]} />
    </>
  );
}
