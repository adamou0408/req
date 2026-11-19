import { useParams } from "react-router";
import { PageHeader } from "../components";
import { t } from "../i18n/zh-Hant";
import { PagePlaceholder } from "./PagePlaceholder";

export default function MisCheckPage() {
  const { id = "" } = useParams();
  return (
    <>
      <PageHeader
        title={t.pages.misCheck.title}
        back={{ to: "/mis", label: t.pages.misQueue.title }}
        meta={t.pages.misCheck.meta(id)}
      />
      <PagePlaceholder wireframes={["MIS-Check.dc.html"]} />
    </>
  );
}
