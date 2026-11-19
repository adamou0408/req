import { useState } from "react";
import {
  Button,
  DataList,
  DiffList,
  LevelTag,
  Stepper,
  Tag,
  Timeline,
} from "../../components";
import type { DataListColumn } from "../../components";
import { formatWaited } from "../../lib/format";
import { DemoLabel, DemoSection } from "./DemoSection";
import {
  SAMPLE_DIFF,
  SAMPLE_ROWS,
  SAMPLE_STEPS_PROGRESS,
  SAMPLE_STEPS_RETURNED,
  SAMPLE_TIMELINE,
} from "./sampleData";
import type { SampleRow } from "./sampleData";

const COLUMNS: readonly DataListColumn<SampleRow>[] = [
  { key: "id", header: "單號", primary: true, cell: (row) => row.id },
  { key: "level", header: "級別", primary: true, cell: (row) => <LevelTag level={row.level} /> },
  { key: "applicant", header: "申請人", cell: (row) => row.applicant },
  {
    key: "grantee",
    header: "被授權者／範圍",
    cell: (row) => (
      <>
        {row.grantee}
        <div className="muted">{row.scope}</div>
      </>
    ),
  },
  {
    key: "kind",
    header: "類型",
    cell: (row) => <Tag tone={row.kind === "續期" ? "ok" : "neutral"}>{row.kind}</Tag>,
  },
  { key: "waited", header: "已等待", cell: (row) => formatWaited(row.waitedDays) },
  { key: "batch", header: "批次", hideOnMobile: true, cell: (row) => row.batchNote },
];

export function DataListSection() {
  const [selected, setSelected] = useState<Set<string>>(new Set(["DA-2026-0139"]));
  return (
    <DemoSection title="DataList">
      <DemoLabel>桌面是表格，手機自動變成卡片清單。已選 {selected.size} 張。</DemoLabel>
      <DataList
        label="待簽清單"
        columns={COLUMNS}
        rows={SAMPLE_ROWS}
        rowKey={(row) => row.id}
        rowHref={() => "/dev/components"}
        rowActions={(row) => <Button size="sm">查看 {row.id}</Button>}
        selection={{
          selected,
          onChange: setSelected,
          isDisabled: (row) => !row.batchable,
          rowLabel: (row) => (row.batchable ? `選取 ${row.id}` : `${row.id} 不能批次`),
        }}
      />
      <DemoLabel>載入中</DemoLabel>
      <DataList label="載入中的清單" columns={COLUMNS} rows={[]} rowKey={(row) => row.id} loading />
      <DemoLabel>沒有資料</DemoLabel>
      <DataList label="空的清單" columns={COLUMNS} rows={[]} rowKey={(row) => row.id} />
    </DemoSection>
  );
}

export function StepperSection() {
  return (
    <DemoSection title="Stepper">
      <DemoLabel>進行中（並行關卡）</DemoLabel>
      <Stepper label="流程進度" steps={SAMPLE_STEPS_PROGRESS} />
      <DemoLabel>L4 路徑，資安長退回</DemoLabel>
      <Stepper label="簽核路徑" steps={SAMPLE_STEPS_RETURNED} />
    </DemoSection>
  );
}

export function TimelineSection() {
  return (
    <DemoSection title="Timeline">
      <Timeline label="紀錄" items={SAMPLE_TIMELINE} />
    </DemoSection>
  );
}

export function DiffListSection() {
  return (
    <DemoSection title="DiffList">
      <DemoLabel>與前案 DA-2026-0098 的差異</DemoLabel>
      <DiffList label="與前案的差異" items={SAMPLE_DIFF} />
      <DemoLabel>無差異續期</DemoLabel>
      <DiffList label="與前案的差異" items={[]} />
    </DemoSection>
  );
}
