import { useParams } from "react-router";
import { PageHeader } from "../components";
import { t } from "../i18n/zh-Hant";
import { PagePlaceholder } from "./PagePlaceholder";

export default function RequestDetailPage() {
  const { id = "" } = useParams();
  return (
    <>
      <PageHeader
        title={t.pages.requestDetail.title}
        back={{ to: "/", label: t.pages.myRequests.title }}
        meta={t.pages.requestDetail.meta(id)}
      />
      <PagePlaceholder wireframes={["Request-Detail.dc.html"]} />
    </>
  );
}
