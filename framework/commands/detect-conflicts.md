# /detect-conflicts - Requirement Conflict Detection

## Description
Scan specs for cross-persona conflicts and flag them for human resolution. This command is a **thin wrapper** that delegates to the `req-conflict-detector` subagent so the main conversation context is not polluted by per-spec analysis text.

## Usage
```
/detect-conflicts [spec directory path | all]
```

If `all` is specified, scan every spec in `${REQ_DATA_ROOT}/specs/`.

## Behavior

1. **Delegate to subagent**: invoke the `req-conflict-detector` subagent via the Agent tool. Pass the spec path or the literal `all`.
2. The subagent will:
   - Analyze User Stories across personas
   - Detect functional / priority / permission / UX conflicts
   - Write conflict records to `${REQ_DATA_ROOT}/conflicts/CONFLICT-{NNN}.md`
   - Add ⚠️ markers to the affected `spec.md` files
   - Return a structured summary (under 40 lines, one line per conflict)
3. **Surface the subagent's summary** to the user as-is.
4. **Print a Decision Brief** in Chinese (per [AGENTS.md](../AGENTS.md) §7.0 Language Convention) summarising the conflict scan with drill-down links. Format defined in the "Decision Brief" section below.
5. **Call `AskUserQuestion`** with the picker defined below, applying the [Next Step Picker Convention](../AGENTS.md#7b-next-step-picker-convention). If `conflicts detected = 0`, the picker is **skipped** and the agent prints a one-line "no conflicts — recommend `/req-review`" message instead.

## Decision Brief

(Only printed when `conflicts detected > 0`. Skip the entire Brief and picker on a clean scan.)

```markdown
### 📋 決策摘要：衝突偵測結果 — <spec or all>

**目標**：決定如何處理偵測到的衝突。HARD checkpoint：解衝突仍由人決定，本 picker 只決定何時進入解衝突流程。

**關鍵事實**（每項附原檔連結）：
- 掃描範圍：<spec slug 或 `all`>
- 偵測到的衝突總數：<N 個> → 詳見 [conflicts/](${REQ_DATA_ROOT}/conflicts/)
- 嚴重度分布：<high: X / medium: Y / low: Z>
- 涉及的 specs：<列出 1~3 個 spec 名稱與連結>
- 涉及的 personas：<列出 1~3 個 persona 名稱與連結>
- L3 Auto 跳過數：<若 autonomy=auto 且有 skipped-low-severity-conflicts，列出 N 個；否則寫「無」>

**需特別關注**：
- ⚠️ <最高嚴重度的一條衝突摘要與 CONFLICT-NNN 連結>
- ⚠️ <若有跨 spec 衝突，列出涉及的 specs>

**建議**：<AI 推薦的下一步與一句話理由，例如「建議立即進入 /req-resolve-conflict — 共 2 個 high severity 衝突，會卡住 /req-review」>

👉 建議先點開 CONFLICT-NNN 檔案確認衝突細節後再做決定。
```

Then call `AskUserQuestion` with **at most three options**, AI-recommended option first with `（建議）` suffix:

- `進入 /req-resolve-conflict（建議）` — 觸發 `/req-resolve-conflict <path-or-all>`，逐一處理偵測到的衝突
- `先檢視衝突檔案` — 不前進，只開啟 CONFLICT-NNN 檔案讓人工先讀，稍後再手動跑解衝突
- `保留結果` — 不前進，spec 維持原狀（衝突 marker 仍在 spec.md 中）

## Constraints
- **MUST** delegate to `req-conflict-detector`; do not perform persona analysis inline in the main conversation
- **MUST NOT** resolve conflicts autonomously (HARD checkpoint — applies at every autonomy level)
- **MUST NOT** auto-trigger `/req-resolve-conflict` — always go through the picker
- **MUST** print the Decision Brief in Chinese before calling the picker when `conflicts detected > 0` (per AGENTS.md §7b)
- **MUST NOT** print the Brief or call the picker on a zero-conflict scan — keep the happy path quiet
- Cross-spec conflicts (between different features) **MUST** be detected when scanning `all`
- Under `REQ_AUTONOMY_LEVEL=auto`, the subagent **MAY** skip `severity: low` conflicts (not create a CONFLICT-NNN record for them) but **MUST** report the skipped count and slugs under `skipped-low-severity-conflicts` in its return summary, and the Brief **MUST** mention them. Never silently drop.
