import { PATHS } from "../app/paths";
import { PageHeader } from "../components";
import { t } from "../i18n/zh-Hant";
import { PagePlaceholder } from "./PagePlaceholder";

export default function SettingsPage() {
  return (
    <>
      <PageHeader
        title={t.pages.settings.title}
        back={{ to: PATHS.fulfilment, label: t.pages.fulfilmentQueue.title }}
      />
      <PagePlaceholder wireframes={["MIS-Settings.dc.html"]} />
    </>
  );
}
