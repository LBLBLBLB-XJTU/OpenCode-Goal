// Goal 插件功能测试（V2 插件 API：mock context，不触碰真实会话/模型）
// 用法: node tests/unit-test.mjs
//
// 与 V1 测试的区别：
//   - 入口从具名导出 GoalPlugin(...) 改为 default export { id, setup } + mock 插件上下文
//   - 续跑由事件驱动（session.execution.succeeded/failed/interrupted + session.idle 兜底），
//     不再依赖 prompt promise 自动链接，因此用事件总线模拟真实事件流
//   - V2 服务端插件没有 TUI toast，改为断言 console.warn 日志与工具返回文本
import { promises as fsp } from "node:fs"
import path from "node:path"
import os from "node:os"

const { default: pluginDef } = await import(new URL("../plugins/goals.js", import.meta.url).href)

const SID = "testsess_v2_check"
const GOAL_FILE = path.join(os.homedir(), ".config", "opencode", "goals", `${SID}.json`)
const CHAIN_WAIT = 3500 // 插件链式延迟 3000ms + 缓冲

let total = 0
let failures = 0
const check = (name, cond) => {
  total += 1
  console.log(`${cond ? "PASS" : "FAIL"} | ${name}`)
  if (!cond) failures += 1
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 捕获插件日志（V2 用 console 日志替代 V1 的 toast）
const warns = []
const origWarn = console.warn
console.warn = (...args) => {
  warns.push(args.map(String).join(" "))
  origWarn(...args)
}

// ---------------------------------------------------------------------------
// mock 插件上下文（V2 Context 的最小实现）
// ---------------------------------------------------------------------------

const calls = { prompts: [], failNextPrompt: false }
const hooks = {}
const tools = new Map()

const editor = {
  add: (t) => tools.set(t.name, t),
  update: (id, fn) => {
    const t = tools.get(id)
    if (t) fn(t)
  },
  remove: (id) => tools.delete(id),
  namespace: () => {},
  list: () => [...tools.values()],
  get: (id) => tools.get(id),
}

// 可推送的异步事件总线，模拟 ctx.event.subscribe()
function createEventBus() {
  const queue = []
  let waker = null
  let lastSignal = null
  return {
    get lastSignal() {
      return lastSignal
    },
    push(event) {
      queue.push(event)
      if (waker) {
        const wake = waker
        waker = null
        wake()
      }
    },
    subscribe({ signal }) {
      lastSignal = signal
      const self = this
      return (async function* () {
        while (!signal.aborted) {
          if (queue.length === 0) {
            await new Promise((resolve) => {
              waker = () => resolve()
              signal.addEventListener("abort", resolve, { once: true })
            })
            waker = null
            continue
          }
          yield queue.shift()
        }
        void self
      })()
    },
  }
}
const eventBus = createEventBus()

const ctx = {
  app: { name: "opencode", version: "0.0.0-test", channel: "test" },
  location: { directory: "test", project: { id: "test", directory: "test", canonical: "test" } },
  options: {},
  tool: {
    transform: async (cb) => {
      cb(editor)
    },
    reload: async () => {},
  },
  session: {
    hook: async (name, cb) => {
      hooks[name] = cb
      return { dispose: async () => {} }
    },
    prompt: async ({ sessionID, text }) => {
      if (calls.failNextPrompt) {
        calls.failNextPrompt = false
        throw new Error("mock prompt admission failure")
      }
      calls.prompts.push({ sessionID, text })
      return { data: { id: "inbox_mock" } }
    },
  },
  event: { subscribe: (options) => eventBus.subscribe(options) },
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

const emit = (type, data) => eventBus.push({ type, data })
const idle = () => emit("session.idle", { sessionID: SID })
const succeeded = () => emit("session.execution.succeeded", { sessionID: SID })
const runFailed = () =>
  emit("session.execution.failed", { sessionID: SID, error: { type: "mock", message: "mock run failure" } })
const runInterrupted = (reason) => emit("session.execution.interrupted", { sessionID: SID, reason })
const runTool = (name, args = {}) => tools.get(name).execute(args, { sessionID: SID })
const content = (r) => (typeof r === "string" ? r : (r?.content ?? ""))
const readGoal = async () => {
  try {
    return JSON.parse(await fsp.readFile(GOAL_FILE, "utf8"))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 测试流程
// ---------------------------------------------------------------------------

await fsp.rm(GOAL_FILE, { force: true })

// 1. 结构：V2 定义 + 工具/钩子注册
const cleanup = await pluginDef.setup(ctx)
check("默认导出为 V2 定义（id + setup）", pluginDef?.id === "goals" && typeof pluginDef?.setup === "function")
const expectedTools = [
  "goal_set", "goal_status", "goal_update_progress", "goal_complete",
  "goal_block", "goal_pause", "goal_resume", "goal_clear",
]
check("8 个工具全部注册", expectedTools.every((t) => typeof tools.get(t)?.execute === "function"))
check("context 钩子已注册", typeof hooks.context === "function")
check("compaction 钩子已注册", typeof hooks.compaction === "function")
check("setup 返回 cleanup 函数", typeof cleanup === "function")

// 2. 创建 goal（max_iterations=3）
let r = await runTool("goal_set", {
  objective: "测试目标：验证事件驱动续跑",
  done_condition: "3轮内完成",
  max_iterations: 3,
})
check("goal_set 成功", content(r).includes("已创建"))

// 3. 重复创建被拒
r = await runTool("goal_set", { objective: "另一个" })
check("重复创建被拒绝", content(r).includes("已存在活跃目标"))

// 4. system 注入（context / compaction 钩子）
let sys = []
await hooks.context({ sessionID: SID, system: sys })
check("context 注入目标", sys.length === 1 && sys[0].text.includes("[GOAL MODE]") && sys[0].text.includes("测试目标"))
sys = []
await hooks.compaction({ sessionID: SID, system: sys })
check("compaction 注入保留块", sys.length === 1 && sys[0].text.includes("GOAL MODE 状态"))

// 5. idle 兜底触发第 1 轮（延迟调度，不立即发送）
idle()
await sleep(150)
check("idle 后延迟调度（不立即发送）", calls.prompts.length === 0)
await sleep(CHAIN_WAIT)
check("idle 触发第 1 轮", calls.prompts.length === 1)
check("续跑消息含轮数", calls.prompts[0]?.text?.includes("第 1/3 轮"))

// 6. 完成事件驱动第 2 轮，且 idle+succeeded 双触发不产生重复续跑
idle()
succeeded()
await sleep(CHAIN_WAIT)
check("完成事件驱动第 2 轮（双触发无重复）", calls.prompts.length === 2)
check("第 2 轮消息含轮数", calls.prompts[1]?.text?.includes("第 2/3 轮"))

// 7. 第 3 轮
succeeded()
await sleep(CHAIN_WAIT)
check("事件驱动第 3 轮", calls.prompts.length === 3)
check("第 3 轮消息含轮数", calls.prompts[2]?.text?.includes("第 3/3 轮"))

// 8. 迭代上限：达到后停止续跑
succeeded()
await sleep(CHAIN_WAIT)
check("达到上限后停止（无第 4 轮）", calls.prompts.length === 3)
let g = await runTool("goal_status")
check("状态=budget_limited", content(g).includes("已达迭代上限"))
check("上限记录日志（替代 V1 toast）", warns.some((w) => w.includes("iteration budget")))

// 9. 进度记录 + 暂停阻断续跑
await runTool("goal_clear")
await runTool("goal_set", { objective: "暂停测试", max_iterations: 5 })
r = await runTool("goal_update_progress", { note: "测试进度" })
check("进度记录成功", content(r).includes("已记录"))
idle()
await sleep(CHAIN_WAIT)
check("新目标触发续跑", calls.prompts.length === 4)
await runTool("goal_pause")
idle() // 用户回合结束 + 本轮完成，均不应续跑
succeeded()
await sleep(CHAIN_WAIT)
check("暂停后不续跑", calls.prompts.length === 4)
g = await runTool("goal_status")
check("暂停状态可见", content(g).includes("已暂停"))

// 10. 恢复后续跑
await runTool("goal_resume")
succeeded()
await sleep(CHAIN_WAIT)
check("恢复后继续续跑", calls.prompts.length === 5)
check("恢复后轮数正确", calls.prompts[4]?.text?.includes("第 2/5 轮"))

// 11. 完成：短证据被拒 + 正常完成 + 停止
r = await runTool("goal_complete", { evidence: "ok" })
check("短证据被拒", content(r).includes("证据过短"))
r = await runTool("goal_complete", { evidence: "benchmark 输出 acc=0.90，见 /tmp/log" })
check("goal_complete 成功", content(r).includes("已达成"))
succeeded()
idle()
await sleep(CHAIN_WAIT)
check("完成后停止续跑", calls.prompts.length === 5)

// 12. 阻塞后 idle 兜底也不续跑
await runTool("goal_clear")
await runTool("goal_set", { objective: "阻塞测试", max_iterations: 5 })
r = await runTool("goal_block", { reason: "缺输入" })
check("goal_block 成功", content(r).includes("已阻塞"))
idle()
succeeded()
await sleep(CHAIN_WAIT)
check("阻塞后不续跑", calls.prompts.length === 5)

// 13. 连续执行失败 → 计数 → 达到上限转 blocked
await runTool("goal_clear")
await runTool("goal_set", { objective: "失败测试", max_iterations: 5 })
idle()
await sleep(CHAIN_WAIT)
check("失败场景触发第 1 轮", calls.prompts.length === 6)
runFailed()
await sleep(300)
g = await readGoal()
check("失败计数 pending 清除", g?.fail_count === 1 && g?.pending === false)
idle()
await sleep(CHAIN_WAIT)
check("单次失败后仍可继续（idle 兜底）", calls.prompts.length === 7)
runFailed()
await sleep(300)
check("失败计数=2", (await readGoal())?.fail_count === 2)
idle()
await sleep(CHAIN_WAIT)
check("第二次失败后继续", calls.prompts.length === 8)
runFailed()
await sleep(300)
g = await readGoal()
check("连续 3 次失败转 blocked", g?.status === "blocked" && g?.fail_count === 3)
idle()
await sleep(CHAIN_WAIT)
check("blocked 后不续跑", calls.prompts.length === 8)

// 14. 用户手动中断 → 自动暂停（V1 语义保留）
await runTool("goal_clear")
await runTool("goal_set", { objective: "中断测试", max_iterations: 3 })
idle()
await sleep(CHAIN_WAIT)
check("中断场景触发续跑", calls.prompts.length === 9)
runInterrupted("user")
await sleep(300)
g = await readGoal()
check("用户中断自动暂停", g?.status === "paused" && g?.pending === false)

// 15. superseded 中断（被新输入替代）→ 保持 pursuing
await runTool("goal_clear")
await runTool("goal_set", { objective: "替代测试", max_iterations: 3 })
idle()
await sleep(CHAIN_WAIT)
check("替代场景触发续跑", calls.prompts.length === 10)
runInterrupted("superseded")
await sleep(300)
g = await readGoal()
check("superseded 中断保持 pursuing", g?.status === "pursuing" && g?.pending === false)

// 16. prompt 提交失败 → 释放 pending 并计入失败
await runTool("goal_clear")
await runTool("goal_set", { objective: "提交失败测试", max_iterations: 3 })
calls.failNextPrompt = true
idle()
await sleep(CHAIN_WAIT)
check("提交失败不产生续跑消息", calls.prompts.length === 10)
g = await readGoal()
check("提交失败释放 pending 并计数", g?.pending === false && g?.fail_count === 1)

// 17. 清理
r = await runTool("goal_clear")
check("goal_clear 成功", content(r).includes("已清除"))
r = await runTool("goal_status")
check("clear 后无 goal", content(r).includes("没有 Goal"))

// 18. cleanup 中止事件订阅
cleanup()
await sleep(100)
check("cleanup 中止事件订阅", eventBus.lastSignal?.aborted === true)

await fsp.rm(GOAL_FILE, { force: true })
console.warn = origWarn

console.log(`\n总续跑轮数: ${calls.prompts.length}`)
console.log(`${total - failures}/${total} 通过`)
if (failures > 0) process.exitCode = 1
