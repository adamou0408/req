import { PageHeader } from "../components";
import { useIsMobile } from "../lib/useMediaQuery";
import { t } from "../i18n/zh-Hant";
import { PagePlaceholder } from "./PagePlaceholder";

/**
 * 手機核准不另做頁面：同一個路由，手機寬度照 Mobile-Inbox 排（卡片清單、逐張簽），
 * 桌面照 Approver-Inbox 排（表格、可批次核准）。
 */
export default function ApprovalsPage() {
  const isMobile = useIsMobile();
  return (
    <>
      <PageHeader
        title={isMobile ? t.pages.approvals.mobileTitle : t.pages.approvals.title}
      />
      <PagePlaceholder
        wireframes={[isMobile ? "Mobile-Inbox.dc.html" : "Approver-Inbox.dc.html"]}
      />
    </>
  );
}
