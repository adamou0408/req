import { ButtonLink, EmptyState, PageHeader } from "../components";
import { t } from "../i18n/zh-Hant";

export default function NotFoundPage() {
  const copy = t.pages.notFound;
  return (
    <>
      <PageHeader title={copy.title} />
      <EmptyState
        title={copy.title}
        description={copy.body}
        action={<ButtonLink to="/">{copy.home}</ButtonLink>}
      />
    </>
  );
}
