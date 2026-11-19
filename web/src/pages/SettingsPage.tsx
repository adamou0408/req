import { PageHeader } from "../components";
import { t } from "../i18n/zh-Hant";
import { PagePlaceholder } from "./PagePlaceholder";

export default function SettingsPage() {
  return (
    <>
      <PageHeader
        title={t.pages.settings.title}
        back={{ to: "/mis", label: t.pages.misQueue.title }}
      />
      <PagePlaceholder wireframes={["MIS-Settings.dc.html"]} />
    </>
  );
}
