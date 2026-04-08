# 審核紀錄：功能名稱

> **欄位標記說明**：所有段落皆為**必填**。Checklist 項目於審核完成後必須全部勾選或註明跳過原因。

## * 基本資訊

- **規格路徑**：specs/{feature-slug}/spec.md
- **審核日期**：
- **審核者**：

## * 審核清單

### * 完整性

- [ ] 所有相關使用者角色都已涵蓋
- [ ] 每個角色都有對應的 User Story
- [ ] 需求摘要準確反映原始需求

### * 品質

- [ ] User Story 描述清晰且合理
- [ ] 驗收條件具體且可測試
- [ ] 非功能需求已適當定義

### * 一致性

- [ ] 所有衝突已解決（conflicts/ 中無 `detected` 狀態）
- [ ] 與現有功能無重疊或矛盾
- [ ] 開放問題已全部回答

### * 追溯性

- [ ] 可追溯到原始需求文件（intake/raw/）
- [ ] 來源資訊完整且正確

## * 審核結果

- **結果**：`approved` | `rejected`
- **意見**：
- **需修改事項**：（如果退回）

---

# Fixup 變體（diff-only review）

> 此區塊**僅在** `/req-iterate --fixup` 觸發的修補審核中使用。一般 spec 審核請使用上方完整 checklist。
> Fixup 變體的目的是把每次事後修補的審核單位縮到最小：reviewer 只需要看「漂移了什麼、改了什麼」，不需要重審整份 spec。

## * Fixup 基本資訊

- **規格路徑**：specs/{feature-slug}/spec.md
- **原版本 → 修補後版本**：v{old} → v{new}（patch-level bump）
- **觸發來源**：`audits/AUDIT-{date}.md` 第 {N} 列 / 手動觸發
- **當時 autonomy level**：`strict` | `balanced` | `auto`
- **審核日期**：
- **審核者**：

## * 觸發此次修補的 Drift Row

> 直接複製自 audit report，原文照抄，不要改寫。

```
spec: {slug}
source: {spec-code | auto-residue | changelog-review | test-retro}
severity: {high | medium | low}
description: {一句話描述漂移}
```

## * 受影響的驗收條件（diff）

> 只列出**有變動**的 acceptance criteria。**禁止**新增或修改條件 —— 若需要新增，fixup 應已被拒絕。
> 此處的「變動」僅限：補上原本缺失的實作對應、修正測試對應、補上被刪除的標記。

```diff
  AC-{id}: {原條件文字 — 不變}
- {刪除的對應 / 標記}
+ {補回的對應 / 標記}
```

## * Micro-plan（≤5 tasks）

- [ ] Task 1: …
- [ ] Task 2: …
- [ ] Task 3: …
- [ ] Task 4: …
- [ ] Task 5: …

> 若超過 5 項，fixup 應已被拒絕並升級為一般 `/req-iterate`。此處超過代表流程錯誤，**MUST** 退回。

## * Fixup 審核 checklist（精簡版）

- [ ] Drift row 描述屬實，可被 reviewer 在 code 中驗證
- [ ] 修補**未**新增或修改任何 acceptance criterion
- [ ] Micro-plan 任務數 ≤ 5，且每項都對應到關閉一條 drift
- [ ] 未觸碰 `infra/` 或已上 production 的代碼
- [ ] 修補後測試（test before/after）已記錄於 `audits/FIXUP-*.md`

## * Fixup 審核結果

- **結果**：`approved` | `rejected`（拒絕請註明原因；常見：應走一般 `/req-iterate`）
- **意見**：
- **Audit trail 連結**：`audits/FIXUP-{slug}-{date-time}.md`
