// Goal 插件端到端测试（OpenCode V2 HTTP API，零 SDK 依赖）
// 前置：opencode 服务已运行并加载本插件（默认自动发现后台服务；
//       也可 OPENCODE_URL=http://127.0.0.1:4097 指向独立的 opencode serve 实例）
// 用法: node tests/e2e-test.mjs
// 验证：目标创建 → 自动续跑（真实事件链驱动） → 诚实阻塞 → 恢复 → 完成 → 停止
import { execSync } from "node:child_process"
import { promises as fs } from "node:fs"
import path from "node:path"
import os from "node:os"

// ---------------------------------------------------------------------------
// 服务地址与认证（V2 本地服务：Basic auth，用户名 opencode，
// 密码在 ~/.config/opencode/service.json）
// ---------------------------------------------------------------------------

const BASE = (
  process.env.OPENCODE_URL ||
  execSync("opencode service status", { encoding: "utf8" }).match(/https?:\/\/\S+/)?.[0] ||
  ""
).replace(/\/+$/, "")
if (!BASE) {
  console.error("无法确定 opencode 服务地址，请先启动 opencode 或设置 OPENCODE_URL")
  process.exit(1)
}
console.log("server:", BASE)

let auth = ""
try {
  const { password } = JSON.parse(
    await fs.readFile(path.join(os.homedir(), ".config", "opencode", "service.json"), "utf8"),
  )
  if (password) auth = "Basic " + Buffer.from(`opencode:${password}`).toString("base64")
} catch {
  /* 无密码文件（如独立 serve 未启用认证） */
}

async function api(method, apipath, body) {
  const res = await fetch(BASE + apipath, {
    method,
    headers: { ...(auth ? { Authorization: auth } : {}), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${apipath} -> ${res.status} ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : null
}

// ---------------------------------------------------------------------------
// 会话与目标读取
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const created = await api("POST", "/api/session", { title: "goal-e2e-v2-test" })
const sid = created.data.id
console.log("session:", sid)

// 固定测试模型（默认模型可能指向不可用的上游；可用 E2E_MODEL=provider/model 覆盖）
const [modelProviderID, modelID] = (process.env.E2E_MODEL || "opencode/mimo-v2.6-flash-free").split("/")
await api("POST", `/api/session/${sid}/model`, { model: { id: modelID, providerID: modelProviderID } })
console.log("model:", `${modelProviderID}/${modelID}`)

const goalFile = path.join(os.homedir(), ".config", "opencode", "goals", `${sid}.json`)
const readGoal = async () => {
  try {
    return JSON.parse(await fs.readFile(goalFile, "utf8"))
  } catch {
    return null
  }
}
const textOf = (m) =>
  typeof m.text === "string"
    ? m.text
    : Array.isArray(m.content)
      ? m.content.map((c) => c.text || "").join(" ")
      : ""
const snapshot = async () => {
  const r = await api("GET", `/api/session/${sid}/message`)
  const msgs = r.data || []
  let continues = 0
  let errors = 0
  for (const m of msgs) {
    if (textOf(m).includes("[GOAL MODE]")) continues += 1
    if (m.outcome === "failed" || m.finish === "error") errors += 1
  }
  return { total: msgs.length, continues, errors }
}
const prompt = (text) => api("POST", `/api/session/${sid}/prompt`, { text })

let failed = false
const assert = (name, cond, extra = "") => {
  console.log(`${cond ? "✅" : "❌"} ${name}${extra ? ` (${extra})` : ""}`)
  if (!cond) failed = true
}

try {
  console.log("\n[步骤1] 创建目标（任务天然缺输入 → 应该触发续跑）...")
  await prompt(
    "请调用 goal_set 工具创建目标：等用户提供数字 N 后计算 N*7。" +
      "完成条件=给出计算结果。最多4轮。注意：现在还没有数字，创建目标后先等待。",
  )
  // 等待模型完成第一轮（goal_set 落盘）；模型调用报错则快速失败
  let g1 = null
  let step1Err = null
  for (let i = 0; i < 24 && !g1; i++) {
    await sleep(5000)
    g1 = await readGoal()
    const s = await snapshot()
    if (s.errors > 0) {
      step1Err = `模型调用失败（messages 中有 error，常见原因：所选模型上游不可用，可设 E2E_MODEL=provider/model 换模型）`
      break
    }
  }
  const s1 = await snapshot()
  console.log(`步骤1完成: 消息=${s1.total} 续跑=${s1.continues} goal=${g1?.status} 迭代=${g1?.iteration}`)
  if (step1Err) console.error("❌ " + step1Err)
  assert("目标已创建", g1?.status !== undefined, `status=${g1?.status}`)

  console.log("\n[步骤2] 等待自动续跑（真实事件链驱动，最多3分钟）...")
  const t0 = Date.now()
  let observed = false
  while (Date.now() - t0 < 3 * 60 * 1000) {
    await sleep(15000)
    const s = await snapshot()
    const g = await readGoal()
    console.log(
      `[${Math.round((Date.now() - t0) / 1000)}s] 消息=${s.total} 续跑=${s.continues} goal=${g?.status} 迭代=${g?.iteration}/${g?.max_iterations}`,
    )
    if (s.continues >= 1) {
      observed = true
      if (g && g.status !== "pursuing") break // 续跑后模型阻塞/暂停则结束等待
    }
  }
  assert("自动续跑已触发", observed)

  console.log("\n[步骤3] 提供数字（若被阻塞则先恢复）...")
  await prompt(
    "数字 N = 888。如果目标当前被阻塞或暂停，请先调用 goal_resume，" +
      "然后计算 N*7 并调用 goal_complete 给出证据（含计算过程）。",
  )
  let g3 = null
  for (let i = 0; i < 24 && g3?.status !== "achieved"; i++) {
    await sleep(5000)
    g3 = await readGoal()
  }
  const s3 = await snapshot()
  console.log(`步骤3完成: 消息=${s3.total} 续跑=${s3.continues} goal=${g3?.status}`)
  assert("目标达成", g3?.status === "achieved", `status=${g3?.status}`)

  console.log("\n[步骤4] 验证完成后不再续跑（等60秒）...")
  const before = (await snapshot()).total
  await sleep(60000)
  const s4 = await snapshot()
  console.log(`步骤4: 消息数 ${before} → ${s4.total}（应不变）`)
  assert("完成后停止续跑", s4.total === before, `${before} -> ${s4.total}`)

  const g = await readGoal()
  console.log("\n===== 最终 goal 状态 =====")
  console.log(JSON.stringify(g, null, 2))
  console.log(
    "\n小结:",
    "续跑触发=" + observed,
    "| 最终状态=" + g?.status,
    "| 证据=" + (g?.evidence || "").slice(0, 120),
  )
} catch (err) {
  failed = true
  console.error("\n测试异常:", err?.message || err)
} finally {
  // 清理：删除测试会话与目标状态文件
  try {
    await api("DELETE", `/api/session/${sid}`)
    console.log("\n已删除测试会话:", sid)
  } catch (err) {
    console.warn("删除测试会话失败（可手动清理）:", sid, err?.message || err)
  }
  await fs.rm(goalFile, { force: true })
}

console.log(failed ? "\n结果: ❌ FAILED" : "\n结果: ✅ PASSED")
if (failed) process.exitCode = 1
