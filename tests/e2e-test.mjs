// Goal 插件端到端测试：真实 server + 真实模型
// 前置：opencode serve --port 4097（加载本插件），并确保 opencode 已配置可用模型
// 用法: node tests/e2e-test.mjs
// 验证：目标创建 → 自动续跑 → 诚实阻塞 → 恢复 → 完成 → 停止
import { createOpencodeClient } from "@opencode-ai/sdk"
import { promises as fs } from "node:fs"
import path from "node:path"
import os from "node:os"

const BASE = process.env.OPENCODE_URL || "http://127.0.0.1:4097"
const client = createOpencodeClient({ baseUrl: BASE })

const sess = await client.session.create({ body: { title: "goal-e2e-test2" } })
const sid = sess.data.id
console.log("session:", sid)

const goalFile = path.join(os.homedir(), ".config", "opencode", "goals", `${sid}.json`)
const readGoal = async () => {
  try { return JSON.parse(await fs.readFile(goalFile, "utf8")) } catch { return null }
}
const snapshot = async () => {
  const r = await client.session.messages({ path: { id: sid } })
  const msgs = r.data
  let continues = 0
  for (const m of msgs) {
    const t = (m.parts || []).map((p) => p.text || "").join(" ")
    if (t.includes("[GOAL MODE]")) continues += 1
  }
  return { total: msgs.length, continues }
}

console.log("\n[步骤1] 创建目标（任务天然缺输入 → 应该触发续跑）...")
await client.session.prompt({
  path: { id: sid },
  body: {
    parts: [{
      type: "text",
      text: "请调用 goal_set 工具创建目标：等用户提供数字 N 后计算 N*7。完成条件=给出计算结果。最多4轮。注意：现在还没有数字，创建目标后先等待。",
    }],
  },
})
let s1 = await snapshot()
let g1 = await readGoal()
console.log(`步骤1完成: 消息=${s1.total} 续跑=${s1.continues} goal=${g1?.status} 迭代=${g1?.iteration}`)

console.log("\n[步骤2] 等待自动续跑（最多3分钟）...")
const t0 = Date.now()
let observed = false
while (Date.now() - t0 < 3 * 60 * 1000) {
  await new Promise((r) => setTimeout(r, 15000))
  const s = await snapshot()
  const g = await readGoal()
  console.log(`[${Math.round((Date.now() - t0) / 1000)}s] 消息=${s.total} 续跑=${s.continues} goal=${g?.status} 迭代=${g?.iteration}/${g?.max_iterations}`)
  if (s.continues >= 1) {
    observed = true
    if (g && g.status !== "pursuing") break // 续跑后模型阻塞/暂停则结束等待
  }
}
console.log(observed ? "✅ 自动续跑已触发" : "❌ 未观察到续跑")

console.log("\n[步骤3] 提供数字（若被阻塞则先恢复）...")
await client.session.prompt({
  path: { id: sid },
  body: {
    parts: [{
      type: "text",
      text: "数字 N = 888。如果目标当前被阻塞或暂停，请先调用 goal_resume，然后计算 N*7 并调用 goal_complete 给出证据（含计算过程）。",
    }],
  },
})
await new Promise((r) => setTimeout(r, 5000))
const s3 = await snapshot()
const g3 = await readGoal()
console.log(`步骤3完成: 消息=${s3.total} 续跑=${s3.continues} goal=${g3?.status}`)

console.log("\n[步骤4] 验证完成后不再续跑（等60秒）...")
const before = (await snapshot()).total
await new Promise((r) => setTimeout(r, 60000))
const s4 = await snapshot()
console.log(`步骤4: 消息数 ${before} → ${s4.total}（应不变）`)

const g = await readGoal()
console.log("\n===== 最终 goal 状态 =====")
console.log(JSON.stringify(g, null, 2))
console.log("\n小结:",
  "续跑触发=" + observed,
  "| 最终状态=" + g?.status,
  "| 证据=" + (g?.evidence || "").slice(0, 120))
