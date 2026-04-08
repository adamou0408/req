# /resolve-conflict - Guided Conflict Resolution

## Description
Guide humans through a structured conflict resolution process with decision framework, impact analysis, and documentation.

## Usage
```
/resolve-conflict [conflict file path | all]
```

If `all` is specified, process every conflict with status `detected` or `under-discussion`.

## Behavior

### 1. Load Conflict Context
- Read the specified conflict record from `${REQ_DATA_ROOT}/conflicts/CONFLICT-{NNN}.md`
- Read the related `spec.md` and its User Stories
- Read the persona definitions for all involved roles

### 2. Present Decision Framework
For each conflict, present a structured analysis:

#### Impact Matrix
For each resolution option, show:
| 方案 | 受益角色 | 受損角色 | 開發成本 | 風險 |
|------|----------|----------|----------|------|

#### Trade-off Analysis
- What does each persona gain or lose?
- Are there creative solutions that serve both personas (compromise)?
- What is the technical feasibility of each option?
- Which option aligns best with the project's CONSTITUTION principles?

#### Recommendation
- AI provides a recommended option with justification
- **But explicitly states this is a suggestion, not a decision**

### 3. Capture Human Decision (Decision Brief UX)

**MUST** present the decision through a Decision Brief that gives the resolver enough context to drill down into the actual conflict, persona definitions, and impact matrix before judging — not a compressed wall of text and not a 5-line TL;DR. Conflict resolution is a HARD checkpoint and the decision quality must be load-bearing.

1. **Print a Decision Brief in Chinese** (per [AGENTS.md](../AGENTS.md) section 7.0 Language Convention). The Brief must surface every key fact with a drill-down link, **not** compress them into one line each:

   ```markdown
   ### ⚖️ 決策摘要：衝突解決 — CONFLICT-{NNN}

   **目標**：在多個解決方案中選擇一個，並記錄決策理由。此為 HARD checkpoint，AI 不得代為決定。

   **關鍵事實**（每項附原檔連結）：
   - 衝突標題：<one-line title> → 詳見 [CONFLICT-{NNN}.md](../conflicts/CONFLICT-{NNN}.md)
   - 衝突角色：<persona A> ↔ <persona B> → 詳見 [persona A](../personas/<a>.md) / [persona B](../personas/<b>.md)
   - 核心爭點：<一句話描述雙方分歧的根本原因>
   - 受影響的 spec：<spec 名稱與目前狀態> → 詳見 [spec.md#衝突標記](../specs/<feature-slug>/spec.md#衝突標記)
   - 受影響的 User Stories：<列出 1~3 個會被改動的 stories> → 詳見 [spec.md#使用者故事](../specs/<feature-slug>/spec.md#使用者故事)
   - 候選方案數量：<N 個方案，含影響矩陣> → 見上方 Impact Matrix 表格
   - AI 推薦方案：方案 <X> — <一句話理由>

   **需特別關注**：
   - ⚠️ <方案 X 對 persona A 的風險，附連結>
   - ⚠️ <方案 Y 對 persona B 的風險，附連結>
   - ⚠️ <若有方案會違反 CONSTITUTION 的某條原則，明確列出>

   **建議**：<AI 的推薦選項與一句話理由，明確標註此為「建議而非決定」>

   👉 建議先點開上列連結確認雙方角色定義與既有 stories 後再做決定。AI 不會替你選。
   ```

2. **Then call the `AskUserQuestion` tool** with one question whose options are the resolution alternatives (max 4, plus an automatic "Other" option for custom answers). Each option's `label` ≤ 12 chars, `description` ≤ 1 line summarising the trade-off. This renders as a popup-style picker in Claude Code instead of free-text.

3. After the human picks an option, call `AskUserQuestion` **a second time** to capture the one-sentence reasoning. Do **not** accept "just because".

4. If the human picks "Other", prompt for the custom option text via the same tool before asking for reasoning.

- Wait for the human to select a resolution option
- Require the human to provide:
  - Which option they chose (or a custom option)
  - The reasoning behind the decision
  - Any additional constraints or conditions

### 4. Update Records
- Update `${REQ_DATA_ROOT}/conflicts/CONFLICT-{NNN}.md`:
  - Set status to `resolved`
  - Fill in decision record (選擇方案, 決策者, 決策日期, 理由)
- Update the corresponding `spec.md`:
  - Remove or update conflict markers (⚠️)
  - Adjust User Stories based on the resolution
  - Add a note in the spec linking to the conflict record
- Log the resolution in `${REQ_DATA_ROOT}/docs/changelog.md`

### 5. Check Readiness
- After resolving, check if the spec has any remaining unresolved conflicts
- If all conflicts are resolved:
  - Notify the user that the spec is ready for `/review`
  - Update conflict status in the spec from ⚠️ to ✅

## Constraints
- **MUST NOT** resolve conflicts autonomously — always wait for human decision
- **MUST** print the Decision Brief in Chinese before calling `AskUserQuestion`. Do **NOT** call `AskUserQuestion` without the Brief.
- **MUST** present all options fairly without bias (even if AI has a recommendation)
- **MUST** require reasoning from the human — "just because" is not sufficient
- **MUST** update all related documents atomically (conflict record + spec + changelog)
- **MUST** preserve the full conflict history (append resolution, don't delete original analysis)
