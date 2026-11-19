import { useState } from "react";
import {
  Alert,
  Button,
  ButtonLink,
  Card,
  Checkbox,
  EmptyState,
  ErrorState,
  Field,
  KeyValue,
  PageHeader,
  Segmented,
  Skeleton,
  StatusTag,
  Tabs,
  Tag,
  TierTag,
} from "../../components";
import { DemoLabel, DemoSection } from "./DemoSection";

export function ButtonSection() {
  return (
    <DemoSection title="Button">
      <div className="cluster">
        <Button>預設</Button>
        <Button variant="primary">主要動作</Button>
        <Button variant="danger">撤銷申請</Button>
        <Button variant="danger-solid">確認撤銷</Button>
        <Button variant="ghost">文字按鈕</Button>
      </div>
      <div className="cluster">
        <Button variant="primary" loading>
          送出中
        </Button>
        <Button disabled>不能按</Button>
        <ButtonLink to="/dev/components" variant="primary">
          連結按鈕
        </ButtonLink>
      </div>
      <Button variant="primary" block>
        撐滿寬度
      </Button>
    </DemoSection>
  );
}

export function TagSection() {
  return (
    <DemoSection title="Tag">
      <DemoLabel>級別</DemoLabel>
      <div className="cluster">
        <TierTag name="L3" />
        <TierTag name="L4" elevated />
        <TierTag name={null} />
      </div>
      <DemoLabel>狀態</DemoLabel>
      <div className="cluster">
        <StatusTag status="draft" />
        <StatusTag status="in_approval" detail="資安長關" />
        <StatusTag status="returned" />
        <StatusTag status="pending_fulfilment" />
        <StatusTag status="verifying" />
        <StatusTag status="active" />
        <StatusTag status="completed" />
        <StatusTag status="expired" />
        <StatusTag status="revoked" />
        <StatusTag status="cancelled" />
      </div>
      <DemoLabel>色調</DemoLabel>
      <div className="cluster">
        <Tag>新申請</Tag>
        <Tag tone="info">續期</Tag>
        <Tag tone="ok">與前案無差異</Tag>
        <Tag tone="warn">部分重疊</Tag>
        <Tag tone="danger">逾時升級</Tag>
      </div>
    </DemoSection>
  );
}

export function AlertSection() {
  return (
    <DemoSection title="Alert">
      <Alert tone="info">
        縮小範圍或期間只需通知；任何擴大都從第一關重簽。
      </Alert>
      <Alert tone="ok" title="紀錄完整性：驗證通過。">
        雜湊鏈上全部事件都沒有被修改或刪除的跡象。
      </Alert>
      <Alert tone="warn" title="部分重疊">
        同一個專案已有生效中的
        DA-2026-0098，涵蓋「銷售訂單：訂單編號、訂單金額｜北區｜2024」。
      </Alert>
      <Alert tone="danger">寬限期已過，這些授權已自動撤銷。</Alert>
    </DemoSection>
  );
}

export function FieldSection() {
  const [purpose, setPurpose] = useState("report");
  return (
    <DemoSection title="Field">
      <Field label="搜尋主題包" placeholder="輸入主題包或欄位名稱" />
      <Field
        as="select"
        label="分類"
        value={purpose}
        onChange={(event) => setPurpose(event.target.value)}
        options={[
          { value: "report", label: "報表與分析" },
          { value: "dev", label: "系統開發或測試" },
          { value: "other", label: "其他（需說明）" },
        ]}
      />
      <Field
        as="textarea"
        label="說明"
        hint="說明資料要用在哪裡。"
        defaultValue="分析北區客戶續約率下降的原因。"
      />
      <Field
        as="textarea"
        label="為什麼還需要這次申請"
        required
        error="請填寫理由。"
      />
      <Field
        type="date"
        label="授權迄（你已修改）"
        changed
        defaultValue="2027-04-30"
        hint="申請人原填 2027-05-31"
      />
      <Field label="負責人" defaultValue="林怡君（在職）" disabled />
    </DemoSection>
  );
}

export function ChoiceSection() {
  const [grantee, setGrantee] = useState<"team" | "project" | "agent">(
    "project",
  );
  const [fields, setFields] = useState(new Set(["客戶編號", "客戶名稱"]));
  function toggle(name: string) {
    const next = new Set(fields);
    if (!next.delete(name)) next.add(name);
    setFields(next);
  }
  return (
    <DemoSection title="Checkbox／Segmented">
      <Segmented
        legend="被授權者"
        hint="只能授權給團隊、專案或 agent，不能直接授權給個人。"
        value={grantee}
        onChange={setGrantee}
        options={[
          { value: "team", label: "團隊" },
          { value: "project", label: "專案" },
          { value: "agent", label: "agent／服務帳號" },
        ]}
      />
      <div>
        {["客戶編號", "客戶名稱", "統一編號"].map((name) => (
          <Checkbox
            key={name}
            label={name}
            suffix={
              name === "統一編號" ? (
                <TierTag name="L4" elevated />
              ) : (
                <TierTag name="L3" />
              )
            }
            checked={fields.has(name)}
            onChange={() => toggle(name)}
          />
        ))}
        <Checkbox
          label="產業別"
          suffix={<Tag>L1 自動給</Tag>}
          disabled
          hint="L1 欄位不需要申請。"
        />
      </div>
    </DemoSection>
  );
}

export function TabsSection() {
  const [tab, setTab] = useState<"todo" | "done" | "deputy" | "failed">("todo");
  return (
    <DemoSection title="Tabs">
      <Tabs
        label="清單分類"
        value={tab}
        onChange={setTab}
        panelId="demo-tabpanel"
        items={[
          { value: "todo", label: "待我簽", count: 6 },
          { value: "done", label: "我已簽" },
          { value: "deputy", label: "職務代理" },
          { value: "failed", label: "驗證失敗", count: 1 },
        ]}
      />
      <div id="demo-tabpanel" role="tabpanel" className="muted">
        目前分頁：{tab}
      </div>
    </DemoSection>
  );
}

export function KeyValueSection() {
  return (
    <DemoSection title="KeyValue">
      <KeyValue
        items={[
          {
            label: "被授權者",
            value: "專案：北區客戶流失分析（負責人 林怡君）",
          },
          {
            label: "資料範圍",
            value: "客戶主檔：客戶編號、客戶名稱、合約到期日",
          },
          { label: "列條件", value: "區域 屬於 北區" },
          { label: "授權起迄", value: "2026-12-01～2027-04-30" },
        ]}
      />
    </DemoSection>
  );
}

export function StateSection() {
  return (
    <DemoSection title="EmptyState／ErrorState／Skeleton">
      <EmptyState
        title="目前沒有待簽的單"
        description="有新的單送到你這一關時，會寄信通知你。"
        action={<Button>重新整理</Button>}
      />
      <ErrorState
        error={{ message: "連不上伺服器，請確認網路後再試一次。" }}
        onRetry={() => undefined}
      />
      <Skeleton count={3} />
      <Skeleton variant="card" count={2} />
    </DemoSection>
  );
}

export function PageHeaderSection() {
  return (
    <DemoSection title="PageHeader／Card">
      <PageHeader
        title="DA-2026-0142"
        back={{ to: "/dev/components", label: "待簽清單" }}
        tags={
          <>
            <TierTag name="L3" />
            <Tag>新申請</Tag>
            <Tag tone="warn">部分重疊</Tag>
          </>
        }
        meta="申請人 林怡君（業務分析部）｜你的角色：申請人主管｜送審 2026-11-10 09:30"
        actions={<Button variant="danger">撤銷申請</Button>}
      />
      <Card title="時限" actions={<Button>催辦</Button>}>
        <p>
          已等待 1 個工作天。3 個工作天未簽會催辦，再 2
          個工作天未簽會升級給你的主管。
        </p>
      </Card>
    </DemoSection>
  );
}
