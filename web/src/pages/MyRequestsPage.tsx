import { PATHS } from "../app/paths";
import { ButtonLink, PageHeader } from "../components";
import { t } from "../i18n/zh-Hant";
import { PagePlaceholder } from "./PagePlaceholder";

export default function MyRequestsPage() {
  return (
    <>
      <PageHeader
        title={t.pages.myRequests.title}
        actions={
          <ButtonLink to={PATHS.requestNew} variant="primary">
            {t.pages.myRequests.newRequest}
          </ButtonLink>
        }
      />
      <PagePlaceholder wireframes={["Main.dc.html"]} />
    </>
  );
}
