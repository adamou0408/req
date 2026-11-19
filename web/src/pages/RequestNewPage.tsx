import { PATHS } from "../app/paths";
import { PageHeader } from "../components";
import { t } from "../i18n/zh-Hant";
import { PagePlaceholder } from "./PagePlaceholder";

export default function RequestNewPage() {
  return (
    <>
      <PageHeader
        title={t.pages.requestNew.title}
        back={{ to: PATHS.home, label: t.pages.myRequests.title }}
      />
      <PagePlaceholder wireframes={["Apply-Form.dc.html"]} />
    </>
  );
}
