export const meta = {
  name: 'contract-draft-attack-revise',
  description: '撰寫契約，由多個對立立場審查，依審查修訂，再由審查方確認重大問題已修（撰寫 → 攻擊 → 修訂 → 確認）',
  phases: [
    { title: 'Draft', detail: '依骨幹撰寫契約' },
    { title: 'Attack', detail: '多個對立立場各自審查' },
    { title: 'Revise', detail: '依審查結果修訂' },
    { title: 'Verify', detail: '審查方確認 blocker 與 major 已修，未修的再修訂' },
  ],
}

/*
用途：SKILL.md 步驟 8。一份契約經過四階段：撰寫者寫草稿 → 多個對立立場審查（只審不改）→ 修訂者逐項處理
→ 沒參與修訂的確認者逐項確認 blocker 與 major「已修／未修／修錯」，未修的回到修訂，最多 maxRounds 輪。
回傳的 unresolved 不為空，就代表這份契約還沒完成，由主代理處理或回報負責人。

args 格式：
{
  context:     string   // 專案背景、必讀文件（骨幹定稿、工程規範）、今天日期、撰寫規則
  outFile:     string   // 契約檔案路徑，例如 'docs/contract/05-integration.md'
  draftPrompt: string   // 撰寫者的任務：角色、目的、步驟、契約要包含的內容、回傳值格式
  lenses:      [{ key, prompt }]  // 審查立場；prompt 描述這個立場要試著做什麼
  draftModel:  string   // 撰寫與修訂用的模型（建議最好的）；省略則用預設
  criticModel: string   // 審查與確認用的模型（建議最好的）；省略則用預設
  maxRounds:   number   // 確認 → 再修訂的最多輪數；預設 2
}

範例：
args = {
  context: 'Repo: /path/to/repo。先讀 docs/contract/00-spine.md、docs/engineering-standards.md。骨幹需要改時不要自己改，列在回報的「骨幹修改建議」。契約要精確到實作者不需要再做設計決定。',
  outFile: 'docs/contract/05-integration.md',
  draftPrompt: '# 你的角色：整合介面架構師\n目的：<...>\n步驟：1. 查證標準現況 2. 撰寫契約，內容：<...>\n回傳值（條列）：<...>',
  lenses: [
    { key: 'attacker', prompt: '你是攻擊者。試著：<具體的攻擊手法>。每個發現給具體修正。' },
    { key: 'integrator', prompt: '你是要串接的工程師。檢查：照文件能不能直接實作……' },
  ],
  draftModel: 'opus',
  criticModel: 'opus',
  maxRounds: 2,
}

注意：
- 每個工作流程同時執行的代理數有上限。多份契約要平行撰寫時，每份契約各啟動一個工作流程，不要塞進同一支。
- 審查者只審不改檔，沒有把握的不要報；撰寫者與修訂者不改骨幹，只在回報中列修改建議，由主代理集中處理。
- 契約依賴的骨幹必須已定稿（SKILL.md 步驟 7）；骨幹還在變動就不要啟動。
- 審查立場要對立：攻擊者（依 STRIDE）、要串接的工程師、要照著實作的人；受稽核的產品加稽核或驗收方。
- 對外介面以機器可讀的定義檔（OpenAPI、JSON Schema）為唯一來源，契約文字引用它。
*/

const CTX = args.context

const FINDINGS = {
  type: 'object',
  properties: {
    findings: { type: 'array', items: { type: 'object', properties: {
      severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
      location: { type: 'string' }, problem: { type: 'string' }, fix: { type: 'string' },
    }, required: ['severity', 'problem', 'fix'] } },
  },
  required: ['findings'],
}

const opt = m => (m ? { model: m } : {})

phase('Draft')
const draft = await agent(CTX + `\n# 產出：${args.outFile}\n` + args.draftPrompt,
  { label: 'drafter', phase: 'Draft', effort: 'high', ...opt(args.draftModel) })

phase('Attack')
const reviews = (await parallel(args.lenses.map(l => () =>
  agent(CTX + `\n# 審查對象：${args.outFile}\n${l.prompt}\n只審查，不改檔。沒有把握的不要報。`,
    { label: 'critic:' + l.key, phase: 'Attack', schema: FINDINGS, ...opt(args.criticModel) })
))).filter(Boolean)
const all = reviews.flatMap(r => r.findings)
log(`審查共 ${all.length} 項（blocker ${all.filter(f => f.severity === 'blocker').length}、major ${all.filter(f => f.severity === 'major').length}）`)

phase('Revise')
const revised = await agent(CTX + `
# 你的角色：修訂者　對象：${args.outFile}
審查發現（JSON）：
${JSON.stringify(all, null, 1)}
逐項處理：blocker、major 必須修進文件；minor 能修就修；有誤的發現不採納並說明理由。修完檢查文件內部一致（端點 ↔ 函式 ↔ 資料表 ↔ 規則代碼）。
回傳值（條列）：已修正數、未採納與理由、骨幹修改建議（彙整）、仍需負責人決定的事項。`,
  { label: 'reviser', phase: 'Revise', effort: 'high', ...opt(args.draftModel) })

const VERIFY = {
  type: 'object',
  properties: {
    items: { type: 'array', items: { type: 'object', properties: {
      id: { type: 'integer' },
      status: { type: 'string', enum: ['已修', '未修', '修錯', '不採納有理'] },
      note: { type: 'string' },
    }, required: ['id', 'status'] } },
  },
  required: ['items'],
}

const MAX_ROUNDS = args.maxRounds || 2
let open = all.map((f, i) => ({ id: i, ...f })).filter(f => f.severity !== 'minor')
const revisions = [revised]

phase('Verify')
for (let round = 1; open.length > 0 && round <= MAX_ROUNDS; round++) {
  const v = await agent(CTX + `
# 你的角色：確認者（沒有參與撰寫與修訂）　對象：${args.outFile}
下面是審查發現的 blocker 與 major（JSON，含 id）。逐項打開文件確認：已修／未修／修錯／不採納有理（修訂者不採納且理由成立）。
${JSON.stringify(open, null, 1)}
只確認，不改檔。每個 id 都要回報。`,
    { label: 'verify:' + round, phase: 'Verify', schema: VERIFY, ...opt(args.criticModel) })
  const done = new Set((v ? v.items : [])
    .filter(i => i.status === '已修' || i.status === '不採納有理').map(i => i.id))
  open = open.filter(f => !done.has(f.id))
  log(`第 ${round} 輪確認：仍未解決 ${open.length} 項`)
  if (open.length === 0 || round === MAX_ROUNDS) break
  revisions.push(await agent(CTX + `
# 你的角色：修訂者　對象：${args.outFile}
確認者認為下列問題未修或修錯（JSON）。逐項修進文件，修完檢查文件內部一致。
${JSON.stringify(open, null, 1)}
回傳值（條列）：每個 id 怎麼修。`,
    { label: 'reviser:' + (round + 1), phase: 'Verify', effort: 'high', ...opt(args.draftModel) }))
}

return {
  draft,
  findings: all.map(f => ({ s: f.severity, p: f.problem })),
  revisions,
  unresolved: open.map(f => ({ id: f.id, s: f.severity, p: f.problem })),
}
