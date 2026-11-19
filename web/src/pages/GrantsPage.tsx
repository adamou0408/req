import { PageHeader } from "../components";
import { t } from "../i18n/zh-Hant";
import { PagePlaceholder } from "./PagePlaceholder";

export default function GrantsPage() {
  return (
    <>
      <PageHeader title={t.pages.grants.title} />
      <PagePlaceholder wireframes={["Owner-Grants.dc.html"]} />
    </>
  );
}
