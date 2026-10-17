/**
 * Goal Mode Plugin for opencode (V2 plugin API)
 * =============================================
 * 复刻 Codex `/goal` 的核心语义，适用于任何"可验证、需多轮推进"的长期任务：
 *
 * 1. 会话级持久目标（thread-scoped，存于 ~/.config/opencode/goals/<sessionID>.json）
 * 2. 事件驱动续跑（一轮执行结束后自动注入下一轮，不需要用户反复说"继续"）
 * 3. 证据驱动完成（模型必须调用 goal_complete 并附证据；或 goal_block 声明阻塞）
 * 4. 生命周期控制（pause / resume / clear / budget_limited）
 * 5. 目标持续可见（每轮 system prompt 注入；上下文压缩时保留）
 *
 * 模型工具：goal_set / goal_status / goal_update_progress / goal_complete
 *           goal_block / goal_pause / goal_resume / goal_clear
 *
 * 命令（见 ~/.config/opencode/command/）：/goal /goal-status /goal-pause
 *           /goal-resume /goal-clear
 *
 * ---------------------------------------------------------------------------
 * V1 → V2 迁移说明（原 V1 插件报错：Plugin must export a default definition
 * with an id and an effect or setup function）：
 *   - 入口：V1 具名导出 `export const GoalPlugin = async (...) => ({...})`
 *     → V2 默认导出 `export default Plugin.define({ id, setup })`
 *   - 工具：V1 `tool()` helper + 返回字符串
 *     → V2 `ctx.tool.transform(editor.add(...))` + JSON Schema 输入 + `{ content }`
 *   - 续跑驱动：V1 `client.session.prompt().then(...)` promise 链
 *     → V2 提交 prompt 后由 `session.execution.*` / `session.idle` 事件收尾
 *   - 系统提示注入：V1 `experimental.chat.system.transform`
 *     → V2 `ctx.session.hook("context", ...)` 编辑 `event.system`
 *   - 压缩保留：V1 `experimental.session.compacting`
 *     → V2 `ctx.session.hook("compaction", ...)`（context 钩子每轮从磁盘重新注入，
 *       故即使摘要丢失，目标仍会随每轮请求恢复可见）
 *   - 清理：返回值 `dispose/event` → `setup` 返回的 cleanup + 自动回收的注册
 *   - V2 服务端插件没有 TUI toast / app.log 接口，提示改为工具返回文本 + console 日志
 *
 * ---------------------------------------------------------------------------
 * V2.2（2026-10-17）：「运行中不停轮」修复（按运行时实测事件校准）——任务未结束前不再注入下一轮：
 *   1. shell 跟踪使用真实运行时事件（2026-10-17 实测）：
 *      `shell.created` / `shell.updated` → data.info = { id, command, metadata.sessionID, ... }
 *      `shell.exited` / `shell.deleted`  → data = { id, ... }；顶层没有 sessionID，
 *      会话关联取 info.metadata.sessionID（metadata 无 background 标志，所有 shell 均跟踪）。
 *   2. 仍有运行中的 shell 时续跑暂缓（log: goal continue deferred），
 *      shell 结束事件到达后延迟复检续跑（SHELL_RECHECK_DELAY_MS）；
 *      回合结束的链式检查以「仍在运行者」为准（前台工具调用在回合结束前已退出，不受影响）。
 *   3. 跨实例互斥锁（<GOAL_DIR>/<sessionID>.inject.lock，open "wx" + 5s 陈旧接管 + token 释放）：
 *      热加载/多工作区并存的实例间只允许一个注入，防止重复续跑消息。
 *   4. 轮次提示明确要求：等长任务真正结束、核对结果后再结束本轮；
 *      禁止以「仍在运行/继续观察」为由空转结束本轮。
 *   5. 安全阀：shell 记录超过 SHELL_DEFER_TTL_MS 视为完成事件丢失，告警后放行；
 *      pending 锁在运行中的回合内仍然生效（防止复检在回合中途注入）。
 *   调试用环境变量（可选）：GOAL_CHAIN_DELAY_MS / GOAL_SHELL_RECHECK_MS /
 *   GOAL_SHELL_TTL_MS / GOAL_PENDING_TTL_MS / GOAL_DIR_OVERRIDE。
 */
import { Plugin } from "@opencode/plugin"
import { promises as fsp } from "node:fs"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

const GOAL_DIR =
  process.env.GOAL_DIR_OVERRIDE || path.join(os.homedir(), ".config", "opencode", "goals")
const DEFAULT_MAX_ITER = 30
const MAX_FAILS = 3
// pending 锁的过期时间：续跑已发起但长时间未结束（如进程崩溃）时允许恢复
const PENDING_TTL_MS = Number(process.env.GOAL_PENDING_TTL_MS || 3 * 60 * 60 * 1000)
// 一轮结束后延迟多久再安排下一轮（等 TUI/会话完全稳定）
const CHAIN_DELAY_MS = Number(process.env.GOAL_CHAIN_DELAY_MS || 3000)
// 事件流中断后的重连间隔
const RECONNECT_DELAY_MS = 5000
// 后台任务闸门：shell 结束事件到达后，延迟复检是否可续跑
// （先让「任务完成通知」回合被受理，避免与其竞争注入）
const SHELL_RECHECK_DELAY_MS = Number(process.env.GOAL_SHELL_RECHECK_MS || 15000)
// 后台任务闸门安全阀：shell 记录存活超过该时长视为完成事件丢失，告警后放行
const SHELL_DEFER_TTL_MS = Number(process.env.GOAL_SHELL_TTL_MS || 12 * 60 * 60 * 1000)

// ---------------------------------------------------------------------------
// 状态存取（每个会话一个 JSON 文件）
// ---------------------------------------------------------------------------

async function loadGoal(sessionID) {
  try {
    const raw = await fsp.readFile(path.join(GOAL_DIR, `${sessionID}.json`), "utf8")
    return JSON.parse(raw)
  } catch {
    return null
  }
}

async function saveGoal(sessionID, goal) {
  await fsp.mkdir(GOAL_DIR, { recursive: true })
  goal.updated_at = new Date().toISOString()
  await fsp.writeFile(
    path.join(GOAL_DIR, `${sessionID}.json`),
    JSON.stringify(goal, null, 2),
    "utf8",
  )
}

async function removeGoalFile(sessionID) {
  try {
    await fsp.unlink(path.join(GOAL_DIR, `${sessionID}.json`))
  } catch {
    /* not exists */
  }
}

// ---------------------------------------------------------------------------
// 后台任务跟踪：会话仍有未结束的后台命令时，续跑暂缓（等命令真正结束后再继续）
// 运行时真实事件（2026-10-17 实测）：
//   shell.created / shell.updated → data.info = { id, status, command, cwd, shell, file,
//                                                  metadata: { sessionID, ... } }
//   shell.exited                  → data = { id, exit, status }
//   shell.deleted                 → data = { id }
// 注意：shell 事件顶层没有 sessionID，会话关联在 info.metadata.sessionID。
// ---------------------------------------------------------------------------

// shellID -> { sessionID, command, isBackground, startedAt }
const liveShells = new Map()

function noteShellInfo(info, isCreate) {
  if (!info || !info.id) return
  const sessionID = info.metadata?.sessionID
  if (!sessionID) return // 无法关联会话的 shell 不参与闸门
  const key = String(info.id)
  if (!isCreate && liveShells.has(key)) return // updated：不重置计时
  liveShells.set(key, {
    sessionID: String(sessionID),
    command: String(info.command || ""),
    isBackground: info.metadata?.background === true,
    startedAt: Date.now(),
  })
}

function dropShell(shellID) {
  if (!shellID) return undefined
  const key = String(shellID)
  const known = liveShells.get(key)
  liveShells.delete(key)
  return known
}

// 返回仍在运行的命令（超过安全阀的条目视为完成事件丢失，告警并清理）
function activeShells(sessionID) {
  const now = Date.now()
  const alive = []
  for (const [id, info] of liveShells) {
    if (info.sessionID !== sessionID) continue
    const age = now - info.startedAt
    if (age >= SHELL_DEFER_TTL_MS) {
      log("warn", "stale running shell ignored (completion event likely lost)", {
        sessionID,
        shell: id,
        command: info.command.slice(0, 120),
        ageMs: age,
      })
      liveShells.delete(id)
      continue
    }
    alive.push({ id, ...info })
  }
  return alive
}

// ---------------------------------------------------------------------------
// 跨实例注入互斥锁：热加载会并存多份插件实例（实测每次重载产生 2 份），
// 用文件锁保证同一触发只被一个实例注入一次。
// ---------------------------------------------------------------------------

const injectLocks = new Map() // sessionID -> 本实例持有的锁 token
const INJECT_MUTEX_STALE_MS = 5000

function injectLockPath(sessionID) {
  return path.join(GOAL_DIR, `${sessionID}.inject.lock`)
}

function acquireInjectMutex(sessionID) {
  if (!sessionID) return false
  const p = injectLockPath(sessionID)
  const token = `${process.pid}:${GOALS_INST}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
  const tryCreate = () => {
    try {
      const h = fs.openSync(p, "wx")
      fs.writeSync(h, token)
      fs.closeSync(h)
      return true
    } catch (err) {
      if (err && err.code === "EEXIST") return null
      return false
    }
  }
  let r = tryCreate()
  if (r === true) {
    injectLocks.set(sessionID, token)
    return true
  }
  if (r === null) {
    try {
      const st = fs.statSync(p)
      if (Date.now() - st.mtimeMs > INJECT_MUTEX_STALE_MS) {
        fs.unlinkSync(p) // 陈旧锁（持有者异常退出）：接管
        r = tryCreate()
        if (r === true) {
          injectLocks.set(sessionID, token)
          return true
        }
      }
    } catch {
      /* 其他实例已接管 */
    }
  }
  return false
}

function releaseInjectMutex(sessionID) {
  const token = injectLocks.get(sessionID)
  if (!token) return
  injectLocks.delete(sessionID)
  try {
    const cur = fs.readFileSync(injectLockPath(sessionID), "utf8")
    if (cur === token) fs.unlinkSync(injectLockPath(sessionID))
  } catch {
    /* ignore */
  }
}

function log(level, message, extra) {
  const line = `[goal-plugin] ${message}`
  const detail = extra === undefined ? "" : extra
  if (level === "error") console.error(line, detail)
  else if (level === "warn") console.warn(line, detail)
  else console.log(line, detail)
}

function errMsg(err) {
  return String(err?.message || err)
}

// 实例标识：跨实例注入互斥锁的持有者 token（现场诊断日志已于验证通过后移除）
const GOALS_INST = Math.random().toString(36).slice(2, 8)

function fmtStatus(g) {
  const statusLabel = {
    pursuing: "进行中",
    paused: "已暂停",
    achieved: "已达成",
    blocked: "已阻塞",
    budget_limited: "已达迭代上限",
  }[g.status] || g.status
  const recent = (g.progress || [])
    .slice(-5)
    .map((p) => `- #${p.iteration} ${p.note}`)
    .join("\n")
  return [
    `🎯 目标: ${g.objective}`,
    `状态: ${statusLabel} | 迭代: ${g.iteration}/${g.max_iterations}`,
    `完成条件: ${g.done_condition || "—"}`,
    `验证方式: ${g.verification || "—"}`,
    `约束: ${g.constraints || "—"}`,
    g.evidence ? `证据: ${g.evidence}` : null,
    g.blocker ? `阻塞原因: ${g.blocker}` : null,
    `最近进度:\n${recent || "（无）"}`,
  ]
    .filter(Boolean)
    .join("\n")
}

function nextRoundPrompt(g) {
  const recent =
    (g.progress || [])
      .slice(-5)
      .map((p) => `- #${p.iteration} ${p.note}`)
      .join("\n") || "（无）"
  return `[GOAL MODE] 自动续跑 第 ${g.iteration}/${g.max_iterations} 轮

🎯 目标: ${g.objective}
✅ 完成条件: ${g.done_condition || "（见目标描述）"}
🔍 验证方式: ${g.verification || "自行确定可客观检查的证据（文件/命令输出/产物）"}
⛓ 约束: ${g.constraints || "无特殊约束"}
📜 最近进度:
${recent}

执行要求（按顺序）：
1. 【先验证】检查完成条件当前是否已经满足（运行验证命令 / 检查产物文件 / 对照证据）。已满足 → 调用 goal_complete 并附上具体证据（命令输出、文件路径、数值），结束工作。
2. 【诚实阻塞】若确认无法继续推进（缺资源、缺用户关键输入、连续失败且无新路径）→ 调用 goal_block 说明原因与所需输入。
3. 【推进】否则从当前状态继续：优先做最有价值且未被证伪的下一步；不要重复此前已证明无效的尝试。
4. 【等任务完成再结束本轮】如果本轮启动或依赖长任务（后台命令、训练、远程作业）：不得在任务仍在运行时以「仍在运行/稍后继续/继续观察」为由空转结束本轮。必须等任务真正结束并核对结果后再结束本轮——可用阻塞式等待命令原地等待，或让后台任务继续运行（系统检测到未结束的后台任务会自动暂缓续跑，任务结束后继续）。
5. 【留痕】结束本轮前调用 goal_update_progress，记录：本轮做了什么、结果如何、下一步计划。`
}

// ---------------------------------------------------------------------------
// 插件主体（V2：default export { id, setup }）
// ---------------------------------------------------------------------------

export default Plugin.define({
  id: "goals",

  async setup(ctx) {
    // 进程内锁：防止同一会话并发触发多轮续跑（同步加锁，消除 await 窗口）
    const inflight = new Set()

    // ------------------------------------------------------------------
    // 工具集
    // ------------------------------------------------------------------

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "goal_set",
        description:
          "创建会话级持久目标（Goal 模式）。适用于有明确完成条件、需要多轮迭代推进的长周期任务" +
          "（如性能优化、调试、迁移、研究、批量实验）。设定后：每当回答结束进入空闲，系统会自动" +
          "续跑下一轮；若检测到会话仍有未结束的后台任务，会等任务结束后再续跑。直到达成完成条件" +
          "（goal_complete）、被阻塞（goal_block）、暂停或达到迭代上限。",
        input: {
          type: "object",
          properties: {
            objective: { type: "string", description: "目标：想要达成的结果（一句话，可附细节）" },
            done_condition: {
              type: "string",
              description: "可验证的完成条件（推荐：明确的数值/产物/状态）",
            },
            verification: {
              type: "string",
              description: "验证方法：运行什么命令/检查什么文件来证明完成",
            },
            constraints: { type: "string", description: "约束：推进过程中不能破坏什么" },
            max_iterations: { type: "number", description: "最大自动续跑轮数（默认 30）" },
          },
          required: ["objective"],
          additionalProperties: false,
        },
        async execute(args, context) {
          const sessionID = context.sessionID
          const existing = await loadGoal(sessionID)
          if (existing && existing.status === "pursuing") {
            return {
              content:
                `⚠️ 已存在活跃目标，未创建新目标。\n${fmtStatus(existing)}\n` +
                `如需替换，请先调用 goal_clear（或用户执行 /goal-clear）。`,
            }
          }
          const goal = {
            objective: args.objective,
            done_condition: args.done_condition || "",
            verification: args.verification || "",
            constraints: args.constraints || "",
            status: "pursuing",
            iteration: 0,
            max_iterations: Math.max(1, Math.floor(Number(args.max_iterations) || DEFAULT_MAX_ITER)),
            progress: [],
            evidence: "",
            blocker: "",
            fail_count: 0,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }
          await saveGoal(sessionID, goal)
          log("info", "goal created", { sessionID, objective: goal.objective })
          return {
            content:
              `🎯 Goal 已创建（本会话绑定，最多自动续跑 ${goal.max_iterations} 轮）\n` +
              `目标: ${goal.objective}\n` +
              `完成条件: ${goal.done_condition || "—"}\n` +
              `验证方式: ${goal.verification || "—"}\n\n` +
              `→ 完成你当前的回复后，系统会在空闲时自动开始第 1 轮续跑。\n` +
              `→ 管理指令：/goal-status 查看 · /goal-pause 暂停 · /goal-resume 恢复 · /goal-clear 清除。`,
          }
        },
      })

      editor.add({
        name: "goal_status",
        description: "查看当前会话的 Goal 状态（目标、进度、迭代数、证据/阻塞原因）。",
        input: { type: "object", properties: {}, additionalProperties: false },
        async execute(_args, context) {
          const g = await loadGoal(context.sessionID)
          if (!g) return { content: "当前会话没有 Goal。可用 /goal <目标> 或调用 goal_set 创建。" }
          return { content: fmtStatus(g) }
        },
      })

      editor.add({
        name: "goal_update_progress",
        description:
          "记录本轮 Goal 推进情况（Goal 模式下的每轮结束前调用）。note 应包含：做了什么、结果、下一步。",
        input: {
          type: "object",
          properties: {
            note: { type: "string", description: "本轮进展总结（做了什么/结果/下一步）" },
          },
          required: ["note"],
          additionalProperties: false,
        },
        async execute(args, context) {
          const sessionID = context.sessionID
          const g = await loadGoal(sessionID)
          if (!g) return { content: "当前会话没有 Goal，无需记录。" }
          g.progress = g.progress || []
          g.progress.push({ iteration: g.iteration, note: args.note, at: new Date().toISOString() })
          if (g.progress.length > 200) g.progress = g.progress.slice(-200)
          await saveGoal(sessionID, g)
          return { content: `📝 已记录第 ${g.iteration} 轮进度（共 ${g.progress.length} 条）。` }
        },
      })

      editor.add({
        name: "goal_complete",
        description:
          "标记 Goal 已达成（必须附证据）。仅当完成条件已被客观验证时调用；证据不足时不要调用，继续推进。",
        input: {
          type: "object",
          properties: {
            evidence: {
              type: "string",
              description: "完成证据：命令输出/文件路径/数值/产物说明（越具体越好）",
            },
          },
          required: ["evidence"],
          additionalProperties: false,
        },
        async execute(args, context) {
          const sessionID = context.sessionID
          const g = await loadGoal(sessionID)
          if (!g) return { content: "当前会话没有 Goal。" }
          if (!args.evidence || args.evidence.trim().length < 4) {
            return {
              content: "⚠️ 证据过短，无法标记完成。请提供具体证据（命令输出、文件、数值）。",
            }
          }
          g.status = "achieved"
          g.evidence = args.evidence
          await saveGoal(sessionID, g)
          log("info", "goal achieved", { sessionID, evidence: args.evidence })
          return {
            content:
              `✅ Goal 已标记为【已达成】，自动续跑停止。\n` +
              `证据已存档：${args.evidence.slice(0, 200)}`,
          }
        },
      })

      editor.add({
        name: "goal_block",
        description:
          "标记 Goal 被阻塞（停止自动续跑）。当确认无法继续推进（缺资源/缺用户输入/连续失败无新路径）时调用。",
        input: {
          type: "object",
          properties: {
            reason: { type: "string", description: "阻塞原因 + 继续所需的关键输入" },
          },
          required: ["reason"],
          additionalProperties: false,
        },
        async execute(args, context) {
          const sessionID = context.sessionID
          const g = await loadGoal(sessionID)
          if (!g) return { content: "当前会话没有 Goal。" }
          g.status = "blocked"
          g.blocker = args.reason
          await saveGoal(sessionID, g)
          log("info", "goal blocked", { sessionID, reason: args.reason })
          return {
            content:
              `⛔ Goal 已标记为【已阻塞】，自动续跑停止。\n原因: ${args.reason}\n` +
              `（用户补充输入后可用 /goal-resume 恢复）`,
          }
        },
      })

      editor.add({
        name: "goal_pause",
        description: "暂停当前 Goal 的自动续跑（保留状态，可随时恢复）。",
        input: { type: "object", properties: {}, additionalProperties: false },
        async execute(_args, context) {
          const sessionID = context.sessionID
          const g = await loadGoal(sessionID)
          if (!g) return { content: "当前会话没有 Goal。" }
          g.status = "paused"
          await saveGoal(sessionID, g)
          log("info", "goal paused", { sessionID })
          return {
            content: `⏸ Goal 已暂停（迭代 ${g.iteration}/${g.max_iterations}）。用 goal_resume 或 /goal-resume 恢复。`,
          }
        },
      })

      editor.add({
        name: "goal_resume",
        description: "恢复被暂停/阻塞/达上限的 Goal，继续自动续跑。",
        input: { type: "object", properties: {}, additionalProperties: false },
        async execute(_args, context) {
          const sessionID = context.sessionID
          const g = await loadGoal(sessionID)
          if (!g) return { content: "当前会话没有 Goal。" }
          if (g.status === "achieved") {
            return { content: "该 Goal 已达成。如需新目标，请用 goal_set（或 /goal）创建。" }
          }
          g.status = "pursuing"
          g.fail_count = 0
          await saveGoal(sessionID, g)
          log("info", "goal resumed", { sessionID })
          return {
            content: `▶️ Goal 已恢复（从第 ${g.iteration + 1} 轮继续，上限 ${g.max_iterations}）。本回复结束后自动续跑。`,
          }
        },
      })

      editor.add({
        name: "goal_clear",
        description: "清除当前 Goal（删除状态文件，停止一切自动续跑）。",
        input: { type: "object", properties: {}, additionalProperties: false },
        async execute(_args, context) {
          await removeGoalFile(context.sessionID)
          log("info", "goal cleared", { sessionID: context.sessionID })
          return { content: "🗑 Goal 已清除，自动续跑已停止。" }
        },
      })
    })

    // ------------------------------------------------------------------
    // 目标持续可见：每轮 agent 请求注入 system 提示
    // ------------------------------------------------------------------

    await ctx.session.hook("context", async (event) => {
      try {
        const g = await loadGoal(event.sessionID)
        if (!g) return
        const shells = g.status === "pursuing" ? activeShells(event.sessionID) : []
        const tail =
          g.status === "pursuing"
            ? `自动续跑进行中（第 ${g.iteration}/${g.max_iterations} 轮）。每轮结束前：达成调用 goal_complete（附证据）；无法继续调用 goal_block；否则用 goal_update_progress 留痕。` +
              (shells.length
                ? `检测到 ${shells.length} 个未结束的后台任务，续跑暂缓至其结束；请先等任务完成并核对结果再结束本轮。`
                : "")
            : `当前状态：${g.status}。`
        event.system.push({
          type: "text",
          text:
            `[GOAL MODE] 本会话绑定的持久目标：${g.objective}\n` +
            `完成条件：${g.done_condition || "—"}\n` +
            `约束：${g.constraints || "—"}\n` +
            `${tail}`,
        })
      } catch {
        /* 注入失败不影响主流程 */
      }
    })

    // ------------------------------------------------------------------
    // 上下文压缩时保留 Goal 状态（压缩后即使摘要丢失，
    // 上面的 context 钩子也会在下一轮请求时从磁盘重新注入）
    // ------------------------------------------------------------------

    await ctx.session.hook("compaction", async (event) => {
      try {
        const g = await loadGoal(event.sessionID)
        if (!g) return
        const recent =
          (g.progress || [])
            .slice(-5)
            .map((p) => `- #${p.iteration} ${p.note}`)
            .join("\n") || "（无）"
        event.system.push({
          type: "text",
          text:
            `## GOAL MODE 状态（生成摘要时必须原样保留该块）\n` +
            `目标: ${g.objective}\n` +
            `完成条件: ${g.done_condition || "—"}\n` +
            `验证方式: ${g.verification || "—"}\n` +
            `约束: ${g.constraints || "—"}\n` +
            `状态: ${g.status} | 迭代: ${g.iteration}/${g.max_iterations}\n` +
            `最近进度:\n${recent}`,
        })
      } catch {
        /* ignore */
      }
    })

    // ------------------------------------------------------------------
    // 续跑引擎：一轮执行结束后（事件）清锁并延迟安排下一轮
    // ------------------------------------------------------------------

    async function maybeContinue(sessionID, source) {
      if (!sessionID || inflight.has(sessionID)) return
      inflight.add(sessionID) // 同步加锁：消除 await 期间的并发窗口（曾导致重复续跑）
      // 跨实例互斥：热加载并存的另一份实例正在处理同一触发时，直接让出
      if (!acquireInjectMutex(sessionID)) {
        inflight.delete(sessionID)
        return
      }
      try {
        const g = await loadGoal(sessionID)
        if (!g || g.status !== "pursuing") return

        // pending 锁：续跑在途时跳过；超 TTL（崩溃/卡死）则恢复续跑
        if (g.pending) {
          const age = Date.now() - new Date(g.updated_at || g.created_at).getTime()
          if (age < PENDING_TTL_MS) {
            return
          }
          log("warn", "goal pending lock expired, resuming", { sessionID, ageMs: age })
        }

        // 后台任务闸门：仍有未结束的后台命令时暂缓续跑（命令结束事件会再触发复检）
        const shells = activeShells(sessionID)
        if (shells.length) {
          log("info", "goal continue deferred: background commands still running", {
            sessionID,
            shells: shells.map((s) => `${s.id}:${s.command.slice(0, 80)}`),
          })
          return
        }

        // 迭代预算
        if (g.iteration >= g.max_iterations) {
          g.status = "budget_limited"
          await saveGoal(sessionID, g)
          log("warn", `goal reached iteration budget ${g.max_iterations}`, { sessionID })
          return
        }

        g.iteration += 1
        g.pending = true
        await saveGoal(sessionID, g) // 先落盘再发 prompt，事件到达时必然能读到 pending
        log("info", "goal continue", {
          sessionID,
          source,
          iteration: g.iteration,
          objective: g.objective,
        })

        try {
          await ctx.session.prompt({ sessionID, text: nextRoundPrompt(g) })
        } catch (err) {
          // 提交失败：释放 pending 锁并计入失败
          const msg = errMsg(err)
          log("error", "goal continue prompt failed", { sessionID, error: msg })
          const cur = await loadGoal(sessionID)
          if (cur) {
            cur.pending = false
            cur.fail_count = (cur.fail_count || 0) + 1
            if (cur.fail_count >= MAX_FAILS) {
              cur.status = "blocked"
              cur.blocker = `连续 ${cur.fail_count} 次续跑失败: ${msg.slice(0, 300)}`
              log("error", "goal blocked after repeated prompt failures", { sessionID })
            }
            await saveGoal(sessionID, cur)
          }
        }
      } catch (err) {
        log("error", "maybeContinue failed", { sessionID, source, error: errMsg(err) })
      } finally {
        releaseInjectMutex(sessionID)
        inflight.delete(sessionID)
      }
    }

    // 链式驱动：上一轮彻底结束后，延迟安排下一轮
    function scheduleChain(sessionID) {
      setTimeout(() => {
        maybeContinue(sessionID, "chain").catch((err) =>
          log("error", "chain continue failed", { sessionID, error: errMsg(err) }),
        )
      }, CHAIN_DELAY_MS)
    }

    // 后台任务结束后的复检（同一会话只保留一个待触发复检，避免堆积）
    const shellRechecks = new Map()
    function scheduleShellRecheck(sessionID) {
      if (!sessionID || shellRechecks.has(sessionID)) return
      const timer = setTimeout(() => {
        shellRechecks.delete(sessionID)
        maybeContinue(sessionID, "shell-ended").catch((err) =>
          log("error", "shell recheck continue failed", { sessionID, error: errMsg(err) }),
        )
      }, SHELL_RECHECK_DELAY_MS)
      shellRechecks.set(sessionID, timer)
    }

    // 一轮成功结束：释放 pending 锁并安排下一轮
    async function onExecutionSucceeded(sessionID) {
      const g = await loadGoal(sessionID)
      if (!g) return
      let changed = false
      if (g.pending) {
        g.pending = false
        g.fail_count = 0
        changed = true
      }
      if (changed) await saveGoal(sessionID, g)
      if (g.status === "pursuing") scheduleChain(sessionID)
    }

    // 一轮失败：计入连续失败，达到上限则阻塞（不自动续跑，留给下一次触发恢复）
    async function onExecutionFailed(sessionID, error) {
      const g = await loadGoal(sessionID)
      if (!g || !g.pending) return // 不是我们的续跑轮
      g.pending = false
      g.fail_count = (g.fail_count || 0) + 1
      const msg = error ? `${error.type || "error"}: ${error.message || ""}` : "unknown error"
      if (g.fail_count >= MAX_FAILS) {
        g.status = "blocked"
        g.blocker = `连续 ${g.fail_count} 次续跑失败: ${msg.slice(0, 300)}`
        log("error", "goal blocked after repeated failures", { sessionID, msg })
      } else {
        log("warn", "goal round failed", { sessionID, fail_count: g.fail_count, msg })
      }
      await saveGoal(sessionID, g)
    }

    // 一轮被中断：仅当是我们的续跑轮时处理
    async function onExecutionInterrupted(sessionID, reason) {
      const g = await loadGoal(sessionID)
      if (!g || !g.pending) return // 不是我们的续跑轮被中断
      g.pending = false
      if (reason === "user") {
        // 用户手动中断（esc）：与 V1 一致，自动暂停
        g.status = "paused"
        log("info", "goal auto-paused: run interrupted by user", { sessionID })
      } else {
        // shutdown / superseded / inactivity：保留 pursuing，由后续事件或空闲兜底恢复
        log("info", "goal round interrupted", { sessionID, reason })
      }
      await saveGoal(sessionID, g)
    }

    // ------------------------------------------------------------------
    // 事件订阅：执行生命周期 + 空闲兜底（进程重启/TUI 重新激活后的恢复触发）
    // ------------------------------------------------------------------

    async function dispatchEvent(event) {
      if (!event || typeof event.type !== "string") return
      const sessionID = event.data?.sessionID ?? event.properties?.sessionID
      // shell 事件（实测运行时名称）：顶层无 sessionID，会话关联在 info.metadata.sessionID
      if (event.type === "shell.created" || event.type === "shell.updated") {
        noteShellInfo(event.data?.info ?? event.properties?.info, event.type === "shell.created")
        return undefined
      }
      if (event.type === "shell.exited" || event.type === "shell.deleted") {
        const known = dropShell(event.data?.id ?? event.properties?.id)
        // 后台任务结束：延迟复检（完成通知回合与其并发到达，pending/互斥锁防重）
        if (known?.sessionID) scheduleShellRecheck(known.sessionID)
        return undefined
      }
      if (!sessionID) return
      switch (event.type) {
        case "session.execution.succeeded":
          return onExecutionSucceeded(sessionID)
        case "session.execution.failed":
          return onExecutionFailed(sessionID, event.data?.error)
        case "session.execution.interrupted":
          return onExecutionInterrupted(sessionID, event.data?.reason)
        case "session.idle":
          // 兜底：完成事件丢失时也能恢复续跑（延迟调度，避免与会话稳定期竞争）
          return scheduleChain(sessionID)
        default:
          return undefined
      }
    }

    const controller = new AbortController()
    void (async () => {
      while (!controller.signal.aborted) {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            try {
              await dispatchEvent(event)
            } catch (err) {
              log("error", "event handler failed", { type: event?.type, error: errMsg(err) })
            }
          }
        } catch (err) {
          if (controller.signal.aborted) return
          log("warn", "event stream interrupted, reconnecting", { error: errMsg(err) })
          await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY_MS))
        }
      }
    })()

    log("info", `plugin loaded (OpenCode ${ctx.app.version})`, { directory: ctx.location.directory })

    // cleanup：中止事件订阅 + 清理复检定时器（其余 hook/transform 注册随插件卸载自动回收）
    return () => {
      controller.abort()
      for (const timer of shellRechecks.values()) clearTimeout(timer)
      shellRechecks.clear()
    }
  },
})
