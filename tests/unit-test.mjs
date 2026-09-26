// Goal 插件功能测试（mock client，不触碰真实会话）
// 用法: node tests/unit-test.mjs
const { GoalPlugin } = await import(new URL("../plugins/goals.js", import.meta.url).href)

const calls = { toasts: [], prompts: [] }
const mockClient = {
  tui: { showToast: async ({ body }) => { calls.toasts.push(body); return true } },
  app: { log: async () => true },
  session: { prompt: async ({ path, body }) => { calls.prompts.push({ path, body }); return {} } },
}

const hooks = await GoalPlugin({ client: mockClient, directory: "x", worktree: "x" })
const SID = "testsess_plugin_check"
const ctx = { sessionID: SID }

const check = (name, cond) => console.log(`${cond ? "PASS" : "FAIL"} | ${name}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 1. 结构与工具
const expectedTools = ["goal_set", "goal_status", "goal_update_progress", "goal_complete",
  "goal_block", "goal_pause", "goal_resume", "goal_clear"]
check("工具集完整", expectedTools.every((t) => typeof hooks.tool[t]?.execute === "function"))
check("system.transform 钩子存在", typeof hooks["experimental.chat.system.transform"] === "function")
check("compacting 钩子存在", typeof hooks["experimental.session.compacting"] === "function")
check("event 钩子存在", typeof hooks.event === "function")

// 2. 创建 goal（max_iterations=3）
let r = await hooks.tool.goal_set.execute(
  { objective: "测试目标：验证链式续跑", done_condition: "3轮内完成", max_iterations: 3 }, ctx)
check("goal_set 成功", r.includes("已创建"))

// 3. 重复创建被拒
r = await hooks.tool.goal_set.execute({ objective: "另一个" }, ctx)
check("重复创建被拒绝", r.includes("已存在活跃目标"))

// 4. idle 触发第1轮
await hooks.event({ event: { type: "session.idle", properties: { sessionID: SID } } })
await sleep(500)
check("idle 触发第1轮", calls.prompts.length === 1)
check("续跑消息含轮数", calls.prompts[0]?.body?.parts?.[0]?.text?.includes("第 1/3 轮"))

// 5. 链式驱动：不发任何事件，等待自动出现第2轮（prompt resolve 后 3s 延迟）
await sleep(4200)
check("链式驱动自动触发第2轮（不依赖事件）", calls.prompts.length === 2)
check("第2轮消息含轮数", calls.prompts[1]?.body?.parts?.[0]?.text?.includes("第 2/3 轮"))

// 6. 链式跑到上限：等第3轮 + 上限停止
await sleep(4200)
check("链式驱动自动触发第3轮", calls.prompts.length === 3)
await sleep(4200)
check("达到上限后停止（无第4轮）", calls.prompts.length === 3)
check("上限触发 toast", calls.toasts.some((t) => t.message.includes("迭代上限")))
let g = await hooks.tool.goal_status.execute({}, ctx)
check("状态=budget_limited", g.includes("已达迭代上限") || g.includes("budget"))

// 7. 进度记录 + pause 阻断链式（在链的调度窗口内暂停）
await hooks.tool.goal_clear.execute({}, ctx)
await hooks.tool.goal_set.execute({ objective: "暂停测试", max_iterations: 5 }, ctx)
r = await hooks.tool.goal_update_progress.execute({ note: "测试进度" }, ctx)
check("进度记录成功", r.includes("已记录"))
await hooks.event({ event: { type: "session.idle", properties: { sessionID: SID } } }) // 触发第1轮
await sleep(300)
check("idle 触发新轮", calls.prompts.length === 4)
await hooks.tool.goal_pause.execute({}, ctx)
await sleep(4200)
check("暂停后链式不触发", calls.prompts.length === 4)

// 8. resume + idle（模拟真实场景：工具调用后回复结束）恢复链式
await hooks.tool.goal_resume.execute({}, ctx)
await hooks.event({ event: { type: "session.idle", properties: { sessionID: SID } } })
await sleep(500)
check("恢复后触发", calls.prompts.length === 5)

// 10. 完成（短证据被拒 + 正常完成 + 停止）
r = await hooks.tool.goal_complete.execute({ evidence: "ok" }, ctx)
check("短证据被拒", r.includes("证据过短"))
r = await hooks.tool.goal_complete.execute({ evidence: "benchmark 输出 acc=0.90，见 /tmp/log" }, ctx)
check("goal_complete 成功", r.includes("已达成"))
const nBefore = calls.prompts.length
await sleep(4200)
check("完成后链式停止", calls.prompts.length === nBefore)

// 11. 阻塞 + idle 兜底验证
await hooks.tool.goal_clear.execute({}, ctx)
await hooks.tool.goal_set.execute({ objective: "阻塞测试", max_iterations: 5 }, ctx)
await hooks.tool.goal_block.execute({ reason: "缺输入" }, ctx)
await hooks.event({ event: { type: "session.idle", properties: { sessionID: SID } } })
await sleep(800)
check("阻塞后 idle 不续跑", calls.prompts.length === nBefore)

// 12. clear 清理
await hooks.tool.goal_clear.execute({}, ctx)
r = await hooks.tool.goal_status.execute({}, ctx)
check("clear 后无 goal", r.includes("没有 Goal"))

console.log("\ntoasts:", calls.toasts.map((t) => t.message))
console.log("总续跑轮数:", calls.prompts.length)
