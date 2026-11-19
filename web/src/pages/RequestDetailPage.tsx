import { useParams } from "react-router";
import { ID_PARAM, PATHS } from "../app/paths";
import { PageHeader } from "../components";
import { t } from "../i18n/zh-Hant";
import { PagePlaceholder } from "./PagePlaceholder";

export default function RequestDetailPage() {
  const id = useParams()[ID_PARAM] ?? "";
  return (
    <>
      <PageHeader
        title={t.pages.requestDetail.title}
        back={{ to: PATHS.home, label: t.pages.myRequests.title }}
        meta={t.pages.requestDetail.meta(id)}
      />
      <PagePlaceholder wireframes={["Request-Detail.dc.html"]} />
    </>
  );
}
