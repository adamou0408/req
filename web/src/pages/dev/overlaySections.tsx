import { useState } from "react";
import {
  ActionBar,
  Button,
  ConfirmDialog,
  MfaDialog,
  useToast,
} from "../../components";
import { DemoLabel, DemoSection } from "./DemoSection";
import { SAMPLE_MFA_SUMMARY } from "./sampleData";

const FAKE_DELAY_MS = 800;

function wait(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, FAKE_DELAY_MS));
}

type ConfirmDemo = "simple" | "reason" | "failing" | null;

export function ConfirmDialogSection() {
  const toast = useToast();
  const [open, setOpen] = useState<ConfirmDemo>(null);
  const close = () => setOpen(null);
  return (
    <DemoSection title="ConfirmDialog">
      <div className="cluster">
        <Button onClick={() => setOpen("simple")}>單純確認</Button>
        <Button variant="danger" onClick={() => setOpen("reason")}>
          撤銷（要填原因）
        </Button>
        <Button onClick={() => setOpen("failing")}>送出失敗</Button>
      </div>
      <ConfirmDialog
        open={open === "simple"}
        title="批次核准 2 張？"
        onCancel={close}
        onConfirm={close}
      >
        每張單仍會各自留一筆核准紀錄。
      </ConfirmDialog>
      <ConfirmDialog
        open={open === "reason"}
        title="撤銷 DA-2026-0077？"
        tone="danger"
        confirmLabel="確認撤銷"
        reason={{
          label: "撤銷原因",
          hint: "原因會寫進稽核紀錄，並通知申請人和負責人。",
        }}
        onCancel={close}
        onConfirm={async (reason) => {
          await wait();
          close();
          toast.success(`已撤銷，原因：${reason}`);
        }}
      >
        撤銷不需要簽核，撤銷後授權立即失效。
      </ConfirmDialog>
      <ConfirmDialog
        open={open === "failing"}
        title="儲存設定？"
        reason={{ label: "修改原因" }}
        onCancel={close}
        onConfirm={async () => {
          await wait();
          throw new Error("只有 MIS 系統管理員可以修改設定。");
        }}
      />
    </DemoSection>
  );
}

export function MfaDialogSection() {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(code: string) {
    setBusy(true);
    await wait();
    setBusy(false);
    if (code !== "123456") {
      setError("驗證碼不正確，請再輸入一次。");
      return;
    }
    setOpen(false);
    setError(null);
    toast.success("已核准 DA-2026-0142");
  }

  return (
    <DemoSection title="MfaDialog">
      <DemoLabel>
        展示用：輸入 123456 會通過，其他會被拒絕。手機寬度時佔滿整個畫面。
      </DemoLabel>
      <div className="cluster">
        <Button variant="primary" onClick={() => setOpen(true)}>
          核准（需要 MFA）
        </Button>
      </div>
      <MfaDialog
        open={open}
        title="確認核准"
        summary={SAMPLE_MFA_SUMMARY}
        confirmLabel="確認核准"
        error={error}
        busy={busy}
        onSubmit={(code) => void submit(code)}
        onCancel={() => {
          setOpen(false);
          setError(null);
        }}
      />
    </DemoSection>
  );
}

export function ToastSection() {
  const toast = useToast();
  return (
    <DemoSection title="Toast">
      <div className="cluster">
        <Button onClick={() => toast.show("草稿已儲存")}>一般</Button>
        <Button onClick={() => toast.success("已核准 DA-2026-0139")}>
          成功
        </Button>
        <Button
          onClick={() => toast.error("連不上伺服器，請確認網路後再試一次。")}
        >
          錯誤（不會自動消失）
        </Button>
      </div>
    </DemoSection>
  );
}

export function ActionBarSection() {
  return (
    <DemoSection title="ActionBar">
      <DemoLabel>手機上固定貼在畫面底部；桌面上是一排按鈕。</DemoLabel>
      <ActionBar label="你的決定">
        <Button variant="danger">退回</Button>
        <Button variant="primary">核准</Button>
      </ActionBar>
    </DemoSection>
  );
}
