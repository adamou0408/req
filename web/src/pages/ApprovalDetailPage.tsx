import { useParams } from "react-router";
import { ID_PARAM } from "../app/paths";
import { PageHeader } from "../components";
import { useIsMobile } from "../lib/useMediaQuery";
import { t } from "../i18n/zh-Hant";
import { PagePlaceholder } from "./PagePlaceholder";

const MOBILE_WIREFRAMES = [
  "Mobile-Review.dc.html",
  "Mobile-MFA.dc.html",
] as const;
const DESKTOP_WIREFRAMES = ["Approver-Review.dc.html"] as const;

/**
 * 手機寬度照 Mobile-Review 排（動作列固定在底部，用 ActionBar），
 * 核准時的 Mobile-MFA 畫面就是 MfaDialog 在手機上的全螢幕樣子，由 API 層自動觸發。
 */
export default function ApprovalDetailPage() {
  const id = useParams()[ID_PARAM] ?? "";
  const isMobile = useIsMobile();
  const list = t.pages.approvals;
  return (
    <>
      <PageHeader
        title={t.pages.approvalDetail.title}
        back={{
          to: PATHS.approvals,
          label: isMobile ? list.mobileTitle : list.title,
        }}
        meta={t.pages.approvalDetail.meta(id)}
      />
      <PagePlaceholder
        wireframes={isMobile ? MOBILE_WIREFRAMES : DESKTOP_WIREFRAMES}
      />
    </>
  );
}
