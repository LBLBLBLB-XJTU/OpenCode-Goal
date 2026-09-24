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

// 1. 工具注册完整性
const expectedTools = ["goal_set", "goal_status", "goal_update_progress", "goal_complete",
  "goal_block", "goal_pause", "goal_resume", "goal_clear"]
check("工具集完整", expectedTools.every((t) => typeof hooks.tool[t]?.execute === "function"))
check("system.transform 钩子存在", typeof hooks["experimental.chat.system.transform"] === "function")
check("compacting 钩子存在", typeof hooks["experimental.session.compacting"] === "function")

// 2. 创建 goal
let r = await hooks.tool.goal_set.execute(
  { objective: "把测试acc从0.5提升到0.9", done_condition: "acc>=0.9", verification: "运行 eval.py", max_iterations: 3 },
  ctx,
)
check("goal_set 成功", r.includes("已创建"))

// 3. 重复创建被拒绝
r = await hooks.tool.goal_set.execute({ objective: "另一个目标" }, ctx)
check("重复创建被拒绝", r.includes("已存在活跃目标"))

// 4. idle 触发续跑
await hooks.event({ event: { type: "session.idle", properties: { sessionID: SID } } })
await new Promise((res) => setTimeout(res, 800))
check("idle 触发第1轮续跑", calls.prompts.length === 1)
check("续跑消息含目标", calls.prompts[0]?.body?.parts?.[0]?.text?.includes("把测试acc"))
check("续跑消息含轮数", calls.prompts[0]?.body?.parts?.[0]?.text?.includes("第 1/3 轮"))

// 5. 进度记录
r = await hooks.tool.goal_update_progress.execute({ note: "第一轮：改了lr" }, ctx)
check("进度记录成功", r.includes("已记录"))

// 6. 模拟 prompt resolve 后 pending 清除 → 再次 idle 应第2轮
await new Promise((res) => setTimeout(res, 300)) // 让 .then 回调写入文件
await hooks.event({ event: { type: "session.idle", properties: { sessionID: SID } } })
await new Promise((res) => setTimeout(res, 800))
check("第2轮续跑成功", calls.prompts.length === 2)

// 7. status 输出
r = await hooks.tool.goal_status.execute({}, ctx)
check("status 含迭代数", r.includes("2/3") || r.includes("迭代"))

// 8. 完成（证据过短被拒）
r = await hooks.tool.goal_complete.execute({ evidence: "ok" }, ctx)
check("短证据被拒", r.includes("证据过短"))

// 9. 完成（正常）
r = await hooks.tool.goal_complete.execute({ evidence: "eval_v2.py 输出 acc=0.90，见于 /tmp/log" }, ctx)
check("goal_complete 成功", r.includes("已达成"))

// 10. 完成后 idle 不再续跑
const before = calls.prompts.length
await hooks.event({ event: { type: "session.idle", properties: { sessionID: SID } } })
await new Promise((res) => setTimeout(res, 800))
check("完成后停止续跑", calls.prompts.length === before)

// 11. pause/resume
await hooks.tool.goal_clear.execute({}, ctx)
r = await hooks.tool.goal_set.execute({ objective: "暂停测试", max_iterations: 5 }, ctx)
await hooks.tool.goal_pause.execute({}, ctx)
await hooks.event({ event: { type: "session.idle", properties: { sessionID: SID } } })
await new Promise((res) => setTimeout(res, 500))
check("暂停后不续跑", calls.prompts.length === before)
await hooks.tool.goal_resume.execute({}, ctx)
await hooks.event({ event: { type: "session.idle", properties: { sessionID: SID } } })
await new Promise((res) => setTimeout(res, 800))
check("恢复后续跑", calls.prompts.length === before + 1)

// 12. 迭代上限
await hooks.tool.goal_clear.execute({}, ctx)
await hooks.tool.goal_set.execute({ objective: "上限测试", max_iterations: 1 }, ctx)
await hooks.event({ event: { type: "session.idle", properties: { sessionID: SID } } })
await new Promise((res) => setTimeout(res, 800))
const afterLimit = calls.prompts.length
await hooks.event({ event: { type: "session.idle", properties: { sessionID: SID } } })
await new Promise((res) => setTimeout(res, 800))
check("达到上限后停止", calls.prompts.length === afterLimit)
check("上限触发 toast", calls.toasts.some((t) => t.message.includes("迭代上限")))

// 13. 清理
await hooks.tool.goal_clear.execute({}, ctx)
r = await hooks.tool.goal_status.execute({}, ctx)
check("clear 后无 goal", r.includes("没有 Goal"))

console.log("\ntoasts:", calls.toasts.map((t) => t.message))
console.log("总续跑轮数:", calls.prompts.length)
