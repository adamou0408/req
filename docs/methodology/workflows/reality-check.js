export const meta = {
  name: 'reality-check',
  description: '從不同立場列出真實世界會遇到、設計沒涵蓋的情境，並提出最佳解',
  phases: [{ title: 'Discover', detail: '每個立場一位代理：列情境、對照設計、提最佳解與替代方案' }],
}

/*
用途：SKILL.md 步驟 3。每個立場一位代理，扮演真實角色，找出設計者想不到、但上線後一定會遇到的情境，
對照現有設計，對沒涵蓋的提出最佳解與替代方案，並檢討既有決策。

args 格式：
{
  context:   string   // 專案背景與終極目標、優先順序、今天日期
  readFirst: string[] // 代理要先讀的文件路徑（定位、骨幹、決策紀錄、驗收標準等）
  lenses:    [{ slug, title, focus }]  // 立場；slug 是檔名；focus 是這個立場關注什麼
  outDir:    string   // 輸出目錄，例如 'docs/reality-check'；檔案為 <outDir>/<slug>.md
  model:     string   // 代理用的模型（建議最好的）；省略則用預設
}

範例：
args = {
  context: 'Repo: /path/to/repo。產品：<一句話>。終極目標：<...>。今天是 2026-11-19。',
  readFirst: ['docs/platform-vision.md', 'docs/contract/00-spine.md', 'docs/decision-log.md'],
  lenses: [{ slug: 'ops', title: '維運', focus: '你負責安裝、升級、備援與排查問題……' }],
  outDir: 'docs/reality-check',
  model: 'opus',
}

注意：
- 每個工作流程同時執行的代理數有上限。立場超過上限時，分成多個工作流程啟動（各帶一部分 lenses）。
- 每個立場只回傳結構化摘要，完整內容由代理寫進檔案；下一階段（裁決）再讀檔案。
- 立場的建議清單見 workflows/README.md。
*/

const CTX = `
# 背景
${args.context}
先讀：${args.readFirst.join('、')}。
詳細契約可能還在撰寫中；有就參考，沒有就以骨幹為準。

# 任務
你扮演一個真實世界的角色。設計者坐在桌前想不到、但系統上線後一定會遇到的情況，由你找出來。
1. 以你的立場，列出會實際發生的情境。要具體：誰、在什麼時候、做了什麼、系統現在的設計會怎麼反應、結果出了什麼問題。不要列空泛的類別。
2. 每個情境對照現有設計：已涵蓋／部分涵蓋／沒涵蓋（指出文件位置或缺口）。已完整涵蓋的不用回報。
3. 對沒涵蓋或部分涵蓋的，提出最佳解：考慮至少兩個替代方案，說明為什麼選這個（依文件裡的優先順序）。最佳解要是現實中行得通的做法，不是最省事的。
4. 也檢查決策紀錄的每一筆決定：從你的立場看有沒有錯或不足。有就當成一個情境回報。
目標 15–25 個情境；寧可少而具體。
把完整內容寫到指定檔案（每個情境一小節），並用結構化輸出回傳摘要。
不要 git commit / push。只寫指定的檔案。
`

const SCHEMA = {
  type: 'object',
  properties: {
    scenarios: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          situation: { type: 'string' },
          likelihood: { type: 'string', enum: ['常見', '偶爾', '少見'] },
          impact: { type: 'string', enum: ['高', '中', '低'] },
          coverage: { type: 'string', enum: ['沒涵蓋', '部分涵蓋'] },
          best_solution: { type: 'string' },
          alternatives: { type: 'array', items: { type: 'string' } },
          affects: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'situation', 'likelihood', 'impact', 'coverage', 'best_solution'],
      },
    },
  },
  required: ['scenarios'],
}

phase('Discover')
const results = await parallel(args.lenses.map(l => () =>
  agent(CTX + `
# 你的立場：${l.title}　產出檔案：${args.outDir}/${l.slug}.md
${l.focus}`, { label: 'lens:' + l.slug, phase: 'Discover', schema: SCHEMA, ...(args.model ? { model: args.model } : {}) })
    .then(r => r ? ({ slug: l.slug, title: l.title, scenarios: r.scenarios }) : null)
))
const ok = results.filter(Boolean)
log(`共 ${ok.reduce((n, r) => n + r.scenarios.length, 0)} 個情境，來自 ${ok.length} 個立場`)
return ok
