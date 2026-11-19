import { ButtonLink, PageHeader } from "../components";
import { t } from "../i18n/zh-Hant";
import { PagePlaceholder } from "./PagePlaceholder";

export default function MisQueuePage() {
  return (
    <>
      <PageHeader
        title={t.pages.misQueue.title}
        actions={
          <ButtonLink to="/settings">{t.pages.misQueue.settings}</ButtonLink>
        }
      />
      <PagePlaceholder wireframes={["MIS-Queue.dc.html"]} />
    </>
  );
}
