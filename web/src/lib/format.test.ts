import { describe, expect, it } from "vitest";
import {
  formatCount,
  formatDate,
  formatDateRange,
  formatDateShort,
  formatDateTime,
  formatDaysLeft,
  formatGrantee,
  formatLevel,
  formatRole,
  formatStatus,
  formatWaited,
  formatWorkdays,
  formatWorkdaysLeft,
} from "./format";

describe("日期", () => {
  it("純日期字串原樣顯示，不做時區換算", () => {
    expect(formatDate("2026-12-01")).toBe("2026-12-01");
  });

  it("時間一律換成台北時間", () => {
    expect(formatDate("2026-11-10T01:30:41Z")).toBe("2026-11-10");
    expect(formatDateTime("2026-11-10T01:30:41Z")).toBe("2026-11-10 09:30");
    // UTC 的 16:30 在台北已經是隔天。
    expect(formatDateTime("2026-11-10T16:30:00Z")).toBe("2026-11-11 00:30");
    expect(formatDate(new Date("2026-12-31T16:00:00Z"))).toBe("2027-01-01");
  });

  it("短日期只留月日", () => {
    expect(formatDateShort("2026-11-21")).toBe("11-21");
  });

  it("沒有值或看不懂的值顯示「—」", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDate(undefined)).toBe("—");
    expect(formatDate("")).toBe("—");
    expect(formatDateTime("不是日期")).toBe("—");
    expect(formatDateShort(null)).toBe("—");
  });

  it("起迄", () => {
    expect(formatDateRange("2026-12-01", "2027-04-30")).toBe(
      "2026-12-01～2027-04-30",
    );
    expect(formatDateRange("2026-12-01", null)).toBe("2026-12-01～—");
    expect(formatDateRange(null, null)).toBe("—");
  });
});

describe("工作天與天數", () => {
  it("0 天顯示「當天」", () => {
    expect(formatWorkdays(0)).toBe("當天");
    expect(formatWaited(0)).toBe("當天");
  });

  it("天數帶單位", () => {
    expect(formatWorkdays(3)).toBe("3 個工作天");
    expect(formatWaited(1)).toBe("已等 1 個工作天");
    expect(formatWorkdaysLeft(3)).toBe("剩 3 個工作天");
    expect(formatDaysLeft(9)).toBe("剩 9 天");
  });

  it("倒數不會出現負數", () => {
    expect(formatWorkdaysLeft(-1)).toBe("剩 0 個工作天");
    expect(formatDaysLeft(-2)).toBe("剩 0 天");
  });
});

describe("級別、狀態、角色", () => {
  it("L3 與 L4 各有自己的顏色，L1、L2 用中性色", () => {
    expect(formatLevel("L3")).toEqual({ label: "L3", tone: "l3" });
    expect(formatLevel("L4")).toEqual({ label: "L4", tone: "l4" });
    expect(formatLevel("L1")).toEqual({ label: "L1", tone: "neutral" });
  });

  it("還沒選欄位時顯示「未判定」", () => {
    expect(formatLevel(null)).toEqual({ label: "未判定", tone: "neutral" });
  });

  it("狀態對應文案與色調", () => {
    expect(formatStatus("draft")).toEqual({ label: "草稿", tone: "neutral" });
    expect(formatStatus("verifying")).toEqual({
      label: "驗證中",
      tone: "warn",
    });
    expect(formatStatus("active")).toEqual({ label: "生效中", tone: "ok" });
    expect(formatStatus("revoked")).toEqual({
      label: "已撤銷",
      tone: "danger",
    });
  });

  it("角色、被授權者、件數", () => {
    expect(formatRole("mis_admin")).toBe("MIS 系統管理員");
    expect(formatGrantee("project", "北區客戶流失分析")).toBe(
      "專案：北區客戶流失分析",
    );
    expect(formatCount("待我簽", 6)).toBe("待我簽（6）");
  });
});
