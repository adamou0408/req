import { PATHS } from "../app/paths";
import { ButtonLink, PageHeader } from "../components";
import { t } from "../i18n/zh-Hant";
import { PagePlaceholder } from "./PagePlaceholder";

export default function FulfilmentQueuePage() {
  const copy = t.pages.fulfilmentQueue;
  return (
    <>
      <PageHeader
        title={copy.title}
        actions={<ButtonLink to={PATHS.settings}>{copy.settings}</ButtonLink>}
      />
      <PagePlaceholder wireframes={["MIS-Queue.dc.html"]} />
    </>
  );
}
