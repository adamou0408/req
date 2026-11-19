export const meta = {
  name: 'research-and-verify',
  description: '依主題調查並寫成文件，每份再由獨立代理查證（調查 → 查證）',
  phases: [
    { title: 'Research', detail: '依主題上網調查並寫成文件' },
    { title: 'Verify', detail: '獨立代理重新查核關鍵論點並補漏' },
  ],
}

/*
用途：SKILL.md 步驟 2（依規模：小專案只查競品與痛點，可以只跑調查、不跑查證）。每個主題先由一個代理調查並寫成文件，再由沒參與的代理重新查核並補漏。

args 格式：
{
  context:       string   // 專案背景：repo 路徑、產品定位、今天日期、調查目的（放最前面，所有代理相同，利於快取）
  topics:        [{ slug, title, scope }]  // slug 是檔名；scope 是調查範圍的文字
  outDir:        string   // 輸出目錄，例如 'docs/research'；檔案為 <outDir>/<slug>.md
  researchModel: string   // 調查用的模型（大量閱讀用較省的）；省略則用預設
  verifyModel:   string   // 查證用的模型（建議最好的）；省略則用預設
}

範例：
args = {
  context: 'Repo: /path/to/repo。產品：<一句話>。先讀 docs/platform-vision.md。今天是 2026-11-19。調查目的：<要回答什麼>。',
  topics: [{ slug: '01-regulation', title: '法規', scope: '<要查的法規與子題>' }],
  outDir: 'docs/research',
  researchModel: 'sonnet',
  verifyModel: 'opus',
}

注意：
- 每個工作流程同時執行的代理數有上限。主題很多時，分成多個工作流程啟動（各帶一部分 topics），不要塞進同一支。
- 大量閱讀與蒐集用較省的模型（researchModel）；查證與最終判斷用最好的模型（verifyModel）。
- 代理需要用 ToolSearch 載入 WebSearch 與 WebFetch；腳本已在提示詞裡說明。
- 只想對已寫好的文件重跑查證，傳入只含該主題的 topics 並自行略過調查階段（複製本腳本，移除第一個 stage）。
*/

const CTX = `
${args.context}

# 工具
用 ToolSearch 載入 WebSearch 與 WebFetch（查詢 "select:WebSearch,WebFetch"）。多個搜尋同一輪一起送出。
工具不能用或查不到時：照實寫「查不到」，不可憑記憶編造條號、數字、產品功能或引文。

# 取材規則
- 優先一手來源：主管機關與法規資料庫、標準組織、廠商官方文件與定價頁、準則原文、有方法說明的調查報告。論壇與部落格只用來佐證痛點，並標明性質。
- 每個事實都附來源編號。條文要寫到條、項、款，並引用關鍵原文。數字要寫出處與年份。
- 分清楚三種內容：來源直接寫的事實／你的推論／查不到。
- 注意時效：標明資料年份；可能已修正的規定要確認現行版本。

# 產出
寫到指定檔案（專有名詞保留原文）。結構固定：
1. 重點結論（≤10 條，每條一句話＋來源編號）
2. 詳細內容（依子題分節；用表格比較）
3. 對產品的含意：列成需求清單，分「必須有／應該有／可以不做」，每條寫依據（連回上面的結論）
4. 不確定或查不到的事項
5. 來源（編號、標題、網址、查閱日期）
不寫空話。不要 git commit / push。只寫指定的檔案。
`

const opt = m => (m ? { model: m } : {})

phase('Research')
const results = await pipeline(
  args.topics,
  t => agent(CTX + `
# 你的主題：${t.title}　產出檔案：${args.outDir}/${t.slug}.md
調查範圍：
${t.scope}
回傳值（條列）：寫了什麼、最重要的 5 個發現、查不到的項目。`,
    { label: 'research:' + t.slug, phase: 'Research', ...opt(args.researchModel) }),
  (r, t) => agent(CTX + `
# 你的角色：獨立查證者　對象：${args.outDir}/${t.slug}.md（主題：${t.title}）
你沒有參與撰寫，請假設裡面有錯。
1. 挑出對產品決策影響最大的 15 個論點（條號、數字、「某產品沒有某功能」、標準的狀態與版本）。逐一重新查核：開原始來源，確認文件真的這樣寫。
2. 每個論點標記：已確認／已更正（寫明原本與更正後）／無法確認（降級為「未查證」或刪除）。直接修改文件內文。
3. 補漏：這個主題還有什麼重要面向沒查到？至少再做 5 次不同角度的搜尋（反面證據、最新消息、在地資訊），把有價值的補進文件。
4. 在文件最後加上「查證紀錄」一節：查了哪些論點、結果、補了什麼。
回傳值（條列）：確認數、更正數與內容、刪除或降級數、補充的重點。`,
    { label: 'verify:' + t.slug, phase: 'Verify', ...opt(args.verifyModel) })
    .then(v => ({ slug: t.slug, research: r, verify: v }))
)
return results.filter(Boolean)
