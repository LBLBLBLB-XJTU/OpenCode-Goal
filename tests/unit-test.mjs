// Goal 插件单元测试 —— v2.2 真实事件形状（2026-10-17 实测校准版）
// 用法: node tests/unit-test.mjs                 （自动依次运行 main + ttl 两个套件）
//       TEST_MODE=main node tests/unit-test.mjs  （单独运行某个套件）
//
// 模拟事件（与会话关联）：
//   shell.created / shell.updated → data.info（含 metadata.sessionID）
//   shell.exited / shell.deleted  → data.id
//   session.execution.succeeded / failed / interrupted · session.idle → data.sessionID
// 覆盖场景：事件链续跑 / 运行中暂缓（核心回归）/ updated 不重置 / 短命前台 shell /
//   exited 与 deleted 释放闸门 / 跨实例互斥锁（外部持有、释放恢复、陈旧接管）/
//   双触发去重 / 暂停恢复 / 预算上限 / TTL 安全阀 / 钩子注入 / 完成·阻塞·受理失败 / cleanup
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import assert from "node:assert/strict"
import { setTimeout as sleep } from "node:timers/promises"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const MODE = process.env.TEST_MODE || ""

// 无 TEST_MODE 时：在子进程中依次运行两个套件（env 必须在导入插件之前设置）
if (!MODE) {
  const self = fileURLToPath(import.meta.url)
  let failed = 0
  for (const mode of ["main", "ttl"]) {
    console.log(`\n===== unit-test.mjs [${mode}] =====`)
    try {
      execFileSync(process.execPath, [self], { env: { ...process.env, TEST_MODE: mode }, stdio: "inherit" })
    } catch {
      failed += 1
    }
  }
  console.log(failed ? `\nRESULT: FAILED (${failed} suite)` : "\nRESULT: ALL SUITES PASSED")
  process.exit(failed ? 1 : 0)
}

// 隔离 goal 状态目录 + 加速定时器（必须在导入插件之前设置）
const goalDir = fs.mkdtempSync(path.join(os.tmpdir(), "goaltest-"))
process.env.GOAL_DIR_OVERRIDE = goalDir
process.env.GOAL_CHAIN_DELAY_MS = "50"
process.env.GOAL_SHELL_RECHECK_MS = "80"
if (MODE === "ttl") process.env.GOAL_SHELL_TTL_MS = "150"

const pluginDef = (await import(new URL("../plugins/goals.js", import.meta.url).href)).default

// ---- 事件队列 / 假 ctx ----
const queue = []
let wake = null
let lastSignal = null
function push(e) {
  queue.push(e)
  if (wake) {
    const w = wake
    wake = null
    w()
  }
}

const tools = {}
const hooks = {}
const prompts = []
let failNextPrompt = false

const ctx = {
  app: { version: "test" },
  location: { directory: process.cwd() },
  tool: {
    transform: async (fn) => {
      await fn({
        add: (t) => {
          tools[t.name] = t
          return () => {}
        },
      })
    },
  },
  session: {
    hook: async (name, cb) => {
      hooks[name] = cb
      return { dispose: async () => {} }
    },
    prompt: async ({ sessionID, text }) => {
      if (failNextPrompt) {
        failNextPrompt = false
        throw new Error("mock prompt admission failure")
      }
      prompts.push({ sessionID, text, at: Date.now() })
    },
  },
  event: {
    subscribe: async function* ({ signal } = {}) {
      lastSignal = signal
      while (!signal?.aborted) {
        if (queue.length) {
          yield queue.shift()
          continue
        }
        await new Promise((res) => {
          wake = res
          signal?.addEventListener("abort", res, { once: true })
        })
        if (signal?.aborted) return
      }
    },
  },
}

const cleanup = await pluginDef.setup(ctx)
const sid = "ses_test_0001"
const goalFile = path.join(goalDir, `${sid}.json`)
const lockFile = path.join(goalDir, `${sid}.inject.lock`)
const readGoal = () => JSON.parse(fs.readFileSync(goalFile, "utf8"))

// ---- v2.2 实测事件形状 ----
const succ = () => push({ type: "session.execution.succeeded", data: { sessionID: sid } })
const idle = () => push({ type: "session.idle", data: { sessionID: sid } })
const shellCreated = (id) =>
  push({
    type: "shell.created",
    data: {
      info: {
        id,
        status: "running",
        command: `cmd-${id}`,
        cwd: ".",
        shell: "powershell",
        metadata: { sessionID: sid },
        time: { started: Date.now() },
      },
    },
  })
const shellUpdated = (id) =>
  push({
    type: "shell.updated",
    data: { info: { id, status: "running", command: `cmd-${id}`, metadata: { sessionID: sid } } },
  })
const shellExited = (id) => push({ type: "shell.exited", data: { id, exit: 0, status: "completed" } })
const shellDeleted = (id) => push({ type: "shell.deleted", data: { id } })

let step = 0
const ok = (name) => console.log(`[PASS ${++step}] ${name}`)

try {
  if (MODE === "main") {
    const r = await tools.goal_set.execute({ objective: "测试目标", max_iterations: 8 }, { sessionID: sid })
    assert.match(r.content, /已创建/)
    ok("goal_set creates goal")

    // 场景1：一轮结束后注入下一轮（execution.succeeded 链式驱动）
    succ()
    await sleep(250)
    assert.equal(prompts.length, 1)
    assert.equal(readGoal().iteration, 1)
    assert.equal(readGoal().pending, true)
    ok("round1 injected on execution.succeeded")

    succ()
    await sleep(250)
    assert.equal(prompts.length, 2)
    assert.equal(readGoal().iteration, 2)
    ok("round2 injected after round1 ended")

    // 场景2（核心回归）：后台 shell 运行期间暂缓——旧 bug 是回合结束后 ~3s 立即注入
    shellCreated("sh_x1")
    succ()
    await sleep(300)
    assert.equal(prompts.length, 2, "shell running must defer continuation")
    assert.equal(readGoal().iteration, 2)
    assert.equal(readGoal().pending, false)
    ok("deferred while background shell running")

    // 场景3：shell.updated 不重置计时、不影响暂缓
    shellUpdated("sh_x1")
    await sleep(120)
    assert.equal(prompts.length, 2)
    ok("shell.updated keeps deferral (no timer reset)")

    // 场景4：短命前台 shell（created→exited）的复检仍受 x1 闸门约束
    shellCreated("sh_fg1")
    shellExited("sh_fg1")
    await sleep(160)
    assert.equal(prompts.length, 2, "exited shell recheck still gated by x1")
    ok("short-lived shell exits; still gated by x1")

    // 场景5：sh_x1 真正结束（exited）→ 复检恢复续跑
    shellExited("sh_x1")
    await sleep(450)
    assert.equal(prompts.length, 3, "continuation resumes after shell exits")
    assert.equal(readGoal().iteration, 3)
    ok("round3 injected after background shell exited")

    // 场景6：再次暂缓；shell.deleted 同样释放闸门
    shellCreated("sh_x2")
    succ()
    await sleep(300)
    assert.equal(prompts.length, 3, "second shell must also defer")
    shellDeleted("sh_x2")
    await sleep(450)
    assert.equal(prompts.length, 4, "deleted event must release gate")
    assert.equal(readGoal().iteration, 4)
    ok("shell.deleted resumes continuation")

    // 场景7（跨实例互斥锁）：外部持有 inject.lock → 放弃注入
    fs.writeFileSync(lockFile, `foreign:${process.pid}:${Date.now()}`)
    succ()
    await sleep(180)
    assert.equal(prompts.length, 4, "foreign inject.lock must block injection")
    assert.equal(readGoal().iteration, 4)
    ok("foreign inject lock blocks injection")

    // 场景8：锁释放后 idle 兜底恢复
    fs.unlinkSync(lockFile)
    idle()
    await sleep(180)
    assert.equal(prompts.length, 5, "continuation resumes after lock release")
    assert.equal(readGoal().iteration, 5)
    assert.equal(fs.existsSync(lockFile), false, "own lock released after injection")
    ok("resumes after foreign lock release")

    // 场景9：陈旧锁（mtime > 5s）被接管
    fs.writeFileSync(lockFile, `stale:${process.pid}:0`)
    const old = new Date(Date.now() - 10_000)
    fs.utimesSync(lockFile, old, old)
    succ()
    await sleep(220)
    assert.equal(prompts.length, 6, "stale lock must be taken over")
    assert.equal(readGoal().iteration, 6)
    assert.equal(fs.existsSync(lockFile), false, "taken-over lock released after injection")
    ok("stale inject lock taken over and released")

    // 场景10：双触发（succeeded + idle）只注入一次
    succ()
    idle()
    await sleep(350)
    assert.equal(prompts.length, 7, "double trigger must produce single injection")
    assert.equal(readGoal().iteration, 7)
    ok("double trigger produces single injection")

    // 场景11：暂停不续跑
    await tools.goal_pause.execute({}, { sessionID: sid })
    succ()
    await sleep(250)
    assert.equal(prompts.length, 7)
    ok("paused goal does not continue")

    // 场景12：恢复续跑
    await tools.goal_resume.execute({}, { sessionID: sid })
    succ()
    await sleep(250)
    assert.equal(prompts.length, 8)
    assert.equal(readGoal().iteration, 8)
    ok("resume continues")

    // 场景13：迭代预算
    succ()
    await sleep(300)
    assert.equal(prompts.length, 8)
    assert.equal(readGoal().status, "budget_limited")
    ok("budget limit enforced")

    // 场景14：context / compaction 钩子注入目标（pursuing 状态下）
    await tools.goal_clear.execute({}, { sessionID: sid })
    await tools.goal_set.execute({ objective: "钩子测试", max_iterations: 5 }, { sessionID: sid })
    let sys = []
    await hooks.context({ sessionID: sid, system: sys })
    assert.equal(sys.length, 1)
    assert.ok(sys[0].text.includes("[GOAL MODE]") && sys[0].text.includes("钩子测试"))
    sys = []
    await hooks.compaction({ sessionID: sid, system: sys })
    assert.equal(sys.length, 1)
    assert.ok(sys[0].text.includes("GOAL MODE 状态"))
    ok("context/compaction hooks inject goal")

    // 场景15：pursuing 中重复创建被拒绝
    const r15 = await tools.goal_set.execute({ objective: "重复目标" }, { sessionID: sid })
    assert.match(r15.content, /已存在活跃目标/)
    ok("duplicate goal_set rejected while pursuing")

    // 场景16：完成流程——短证据被拒 → 有效证据达成 → 停止续跑
    const r16a = await tools.goal_complete.execute({ evidence: "ok" }, { sessionID: sid })
    assert.match(r16a.content, /证据过短/)
    const r16b = await tools.goal_complete.execute({ evidence: "测试输出 acc=0.90，见 /tmp/log" }, { sessionID: sid })
    assert.match(r16b.content, /已达成/)
    succ()
    await sleep(250)
    assert.equal(prompts.length, 8)
    ok("short evidence rejected; valid evidence achieves; stops")

    // 场景17：阻塞后停止续跑
    await tools.goal_clear.execute({}, { sessionID: sid })
    await tools.goal_set.execute({ objective: "阻塞测试", max_iterations: 5 }, { sessionID: sid })
    const r17 = await tools.goal_block.execute({ reason: "缺少用户输入" }, { sessionID: sid })
    assert.match(r17.content, /已阻塞/)
    succ()
    await sleep(250)
    assert.equal(prompts.length, 8)
    ok("blocked stops continuation")

    // 场景18：prompt 受理失败 → 不注入、释放互斥锁、计入失败
    await tools.goal_clear.execute({}, { sessionID: sid })
    await tools.goal_set.execute({ objective: "受理失败测试", max_iterations: 5 }, { sessionID: sid })
    failNextPrompt = true
    succ()
    await sleep(250)
    assert.equal(prompts.length, 8)
    assert.equal(fs.existsSync(lockFile), false, "lock must be released on prompt failure")
    const g18 = readGoal()
    assert.equal(g18.pending, false)
    assert.equal(g18.fail_count, 1)
    ok("prompt admission failure releases lock and counts")

    // 场景19：cleanup 中止事件订阅
    cleanup()
    await sleep(100)
    assert.equal(lastSignal?.aborted, true)
    ok("cleanup aborts event subscription")

    // 收尾：无残留锁文件
    assert.equal(fs.existsSync(lockFile), false, "no leftover lock file")
    ok("no leftover inject lock")

    console.log("ALL MAIN TESTS PASSED")
  } else if (MODE === "ttl") {
    await tools.goal_set.execute({ objective: "TTL 测试", max_iterations: 5 }, { sessionID: sid })
    succ()
    await sleep(250)
    assert.equal(prompts.length, 1)
    ok("round1 injected (ttl mode)")

    // 幽灵 shell：created 后无结束事件；TTL 内必须暂缓
    shellCreated("sh_ghost")
    succ()
    await sleep(300)
    assert.equal(prompts.length, 1, "must defer while ghost shell is fresh")
    ok("deferred with fresh ghost shell")

    // 超过安全阀 TTL：复检时视为完成事件丢失，告警后放行
    await sleep(250)
    idle()
    await sleep(300)
    assert.equal(prompts.length, 2, "stale shell must be bypassed after TTL")
    assert.equal(readGoal().iteration, 2)
    ok("stale shell bypassed after safety TTL")

    console.log("ALL TTL TESTS PASSED")
  } else {
    throw new Error("unknown TEST_MODE: " + MODE)
  }
} finally {
  try {
    fs.rmSync(goalDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

process.exit(0)
