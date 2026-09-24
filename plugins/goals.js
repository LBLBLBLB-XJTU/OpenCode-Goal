/**
 * Goal Mode Plugin for opencode
 * =============================
 * 复刻 Codex `/goal` 的核心语义，适用于任何"可验证、需多轮推进"的长期任务：
 *
 * 1. 会话级持久目标（thread-scoped，存于 ~/.config/opencode/goals/<sessionID>.json）
 * 2. 事件驱动续跑（session.idle 时自动注入下一轮，不需要用户反复说"继续"）
 * 3. 证据驱动完成（模型必须调用 goal_complete 并附证据；或 goal_block 声明阻塞）
 * 4. 生命周期控制（pause / resume / clear / budget_limited）
 * 5. 目标持续可见（每轮 system prompt 注入；上下文压缩时保留）
 *
 * 模型工具：goal_set / goal_status / goal_update_progress / goal_complete
 *           goal_block / goal_pause / goal_resume / goal_clear
 *
 * 命令（见 ~/.config/opencode/command/）：/goal /goal-status /goal-pause
 *           /goal-resume /goal-clear
 */
import { tool } from "@opencode-ai/plugin"
import { promises as fsp } from "node:fs"
import path from "node:path"
import os from "node:os"

const GOAL_DIR = path.join(os.homedir(), ".config", "opencode", "goals")
const DEFAULT_MAX_ITER = 30
const MAX_FAILS = 3
// pending 锁的过期时间：续跑已发起但长时间未结束（如进程崩溃）时允许恢复
const PENDING_TTL_MS = 3 * 60 * 60 * 1000

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
4. 【留痕】结束本轮前调用 goal_update_progress，记录：本轮做了什么、结果如何、下一步计划。`
}

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

export const GoalPlugin = async ({ client, directory, worktree }) => {
  // 进程内锁：防止同一会话并发触发多轮续跑
  const inflight = new Set()

  // 安全 toast（TUI 不可用时静默失败）
  const toast = (message, variant = "info") =>
    client?.tui?.showToast?.({ body: { message, variant } }).catch?.(() => {}) ?? Promise.resolve()

  const log = (level, message, extra) =>
    client?.app
      ?.log?.({ body: { service: "goal-plugin", level, message, extra } })
      .catch?.(() => {}) ?? Promise.resolve()

  // ------------------------------------------------------------------
  // 工具集
  // ------------------------------------------------------------------

  const goalSet = tool({
    description:
      "创建会话级持久目标（Goal 模式）。适用于有明确完成条件、需要多轮迭代推进的长周期任务" +
      "（如性能优化、调试、迁移、研究、批量实验）。设定后：每当回答结束进入空闲，系统会自动" +
      "续跑下一轮，直到达成完成条件（goal_complete）、被阻塞（goal_block）、暂停或达到迭代上限。",
    args: {
      objective: tool.schema.string().describe("目标：想要达成的结果（一句话，可附细节）"),
      done_condition: tool.schema.string().optional().describe("可验证的完成条件（推荐：明确的数值/产物/状态）"),
      verification: tool.schema.string().optional().describe("验证方法：运行什么命令/检查什么文件来证明完成"),
      constraints: tool.schema.string().optional().describe("约束：推进过程中不能破坏什么"),
      max_iterations: tool.schema.number().optional().describe("最大自动续跑轮数（默认 30）"),
    },
    async execute(args, ctx) {
      const existing = await loadGoal(ctx.sessionID)
      if (existing && existing.status === "pursuing") {
        return `⚠️ 已存在活跃目标，未创建新目标。\n${fmtStatus(existing)}\n如需替换，请先调用 goal_clear（或用户执行 /goal-clear）。`
      }
      const goal = {
        objective: args.objective,
        done_condition: args.done_condition || "",
        verification: args.verification || "",
        constraints: args.constraints || "",
        status: "pursuing",
        iteration: 0,
        max_iterations: Math.max(1, Math.floor(args.max_iterations || DEFAULT_MAX_ITER)),
        progress: [],
        evidence: "",
        blocker: "",
        fail_count: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      await saveGoal(ctx.sessionID, goal)
      await toast(`🎯 Goal 已创建：${goal.objective.slice(0, 60)}`, "success")
      await log("info", "goal created", { sessionID: ctx.sessionID, objective: goal.objective })
      return `🎯 Goal 已创建（本会话绑定，最多自动续跑 ${goal.max_iterations} 轮）
目标: ${goal.objective}
完成条件: ${goal.done_condition || "—"}
验证方式: ${goal.verification || "—"}

→ 完成你当前的回复后，系统会在空闲时自动开始第 1 轮续跑。
→ 管理指令：/goal-status 查看 · /goal-pause 暂停 · /goal-resume 恢复 · /goal-clear 清除。`
    },
  })

  const goalStatus = tool({
    description: "查看当前会话的 Goal 状态（目标、进度、迭代数、证据/阻塞原因）。",
    args: {},
    async execute(_args, ctx) {
      const g = await loadGoal(ctx.sessionID)
      if (!g) return "当前会话没有 Goal。可用 /goal <目标> 或调用 goal_set 创建。"
      return fmtStatus(g)
    },
  })

  const goalUpdateProgress = tool({
    description:
      "记录本轮 Goal 推进情况（Goal 模式下的每轮结束前调用）。note 应包含：做了什么、结果、下一步。",
    args: {
      note: tool.schema.string().describe("本轮进展总结（做了什么/结果/下一步）"),
    },
    async execute(args, ctx) {
      const g = await loadGoal(ctx.sessionID)
      if (!g) return "当前会话没有 Goal，无需记录。"
      g.progress = g.progress || []
      g.progress.push({ iteration: g.iteration, note: args.note, at: new Date().toISOString() })
      if (g.progress.length > 200) g.progress = g.progress.slice(-200)
      await saveGoal(ctx.sessionID, g)
      return `📝 已记录第 ${g.iteration} 轮进度（共 ${g.progress.length} 条）。`
    },
  })

  const goalComplete = tool({
    description:
      "标记 Goal 已达成（必须附证据）。仅当完成条件已被客观验证时调用；证据不足时不要调用，继续推进。",
    args: {
      evidence: tool.schema.string().describe("完成证据：命令输出/文件路径/数值/产物说明（越具体越好）"),
    },
    async execute(args, ctx) {
      const g = await loadGoal(ctx.sessionID)
      if (!g) return "当前会话没有 Goal。"
      if (!args.evidence || args.evidence.trim().length < 4) {
        return "⚠️ 证据过短，无法标记完成。请提供具体证据（命令输出、文件、数值）。"
      }
      g.status = "achieved"
      g.evidence = args.evidence
      await saveGoal(ctx.sessionID, g)
      await toast(`✅ Goal 已达成：${g.objective.slice(0, 60)}`, "success")
      await log("info", "goal achieved", { sessionID: ctx.sessionID, evidence: args.evidence })
      return `✅ Goal 已标记为【已达成】，自动续跑停止。\n证据已存档：${args.evidence.slice(0, 200)}`
    },
  })

  const goalBlock = tool({
    description:
      "标记 Goal 被阻塞（停止自动续跑）。当确认无法继续推进（缺资源/缺用户输入/连续失败无新路径）时调用。",
    args: {
      reason: tool.schema.string().describe("阻塞原因 + 继续所需的关键输入"),
    },
    async execute(args, ctx) {
      const g = await loadGoal(ctx.sessionID)
      if (!g) return "当前会话没有 Goal。"
      g.status = "blocked"
      g.blocker = args.reason
      await saveGoal(ctx.sessionID, g)
      await toast(`⛔ Goal 已阻塞，自动续跑停止`, "warning")
      return `⛔ Goal 已标记为【已阻塞】，自动续跑停止。\n原因: ${args.reason}\n（用户补充输入后可用 /goal-resume 恢复）`
    },
  })

  const goalPause = tool({
    description: "暂停当前 Goal 的自动续跑（保留状态，可随时恢复）。",
    args: {},
    async execute(_args, ctx) {
      const g = await loadGoal(ctx.sessionID)
      if (!g) return "当前会话没有 Goal。"
      g.status = "paused"
      await saveGoal(ctx.sessionID, g)
      await toast(`⏸ Goal 已暂停`, "info")
      return `⏸ Goal 已暂停（迭代 ${g.iteration}/${g.max_iterations}）。用 goal_resume 或 /goal-resume 恢复。`
    },
  })

  const goalResume = tool({
    description: "恢复被暂停/阻塞/达上限的 Goal，继续自动续跑。",
    args: {},
    async execute(_args, ctx) {
      const g = await loadGoal(ctx.sessionID)
      if (!g) return "当前会话没有 Goal。"
      if (g.status === "achieved") {
        return "该 Goal 已达成。如需新目标，请用 goal_set（或 /goal）创建。"
      }
      g.status = "pursuing"
      g.fail_count = 0
      await saveGoal(ctx.sessionID, g)
      await toast(`▶️ Goal 已恢复`, "success")
      return `▶️ Goal 已恢复（从第 ${g.iteration + 1} 轮继续，上限 ${g.max_iterations}）。本回复结束后自动续跑。`
    },
  })

  const goalClear = tool({
    description: "清除当前 Goal（删除状态文件，停止一切自动续跑）。",
    args: {},
    async execute(_args, ctx) {
      await removeGoalFile(ctx.sessionID)
      await toast(`🗑 Goal 已清除`, "info")
      return "🗑 Goal 已清除，自动续跑已停止。"
    },
  })

  // ------------------------------------------------------------------
  // 生命周期 / 上下文钩子
  // ------------------------------------------------------------------

  return {
    tool: {
      goal_set: goalSet,
      goal_status: goalStatus,
      goal_update_progress: goalUpdateProgress,
      goal_complete: goalComplete,
      goal_block: goalBlock,
      goal_pause: goalPause,
      goal_resume: goalResume,
      goal_clear: goalClear,
    },

    /**
     * 事件驱动续跑：会话空闲时检查是否有活跃 Goal。
     * 防重：inflight 内存锁 + pending 持久标记（TTL 兜底进程崩溃）。
     */
    event: async ({ event }) => {
      if (!event || event.type !== "session.idle") return
      const sessionID = event.properties?.sessionID
      if (!sessionID || inflight.has(sessionID)) return

      const g = await loadGoal(sessionID)
      if (!g || g.status !== "pursuing") return

      // pending 锁：续跑在途时跳过；超 TTL（崩溃/卡死）则恢复续跑
      if (g.pending) {
        const age = Date.now() - new Date(g.updated_at || g.created_at).getTime()
        if (age < PENDING_TTL_MS) return
        await log("warn", "goal pending lock expired, resuming", { sessionID, ageMs: age })
      }

      // 迭代预算
      if (g.iteration >= g.max_iterations) {
        g.status = "budget_limited"
        await saveGoal(sessionID, g)
        await toast(`⏹ Goal 已达迭代上限 ${g.max_iterations}，自动续跑停止`, "warning")
        return
      }

      g.iteration += 1
      g.pending = true
      await saveGoal(sessionID, g)
      inflight.add(sessionID)
      await log("info", "goal continue", {
        sessionID,
        iteration: g.iteration,
        objective: g.objective,
      })

      client.session
        .prompt({
          path: { id: sessionID },
          body: { parts: [{ type: "text", text: nextRoundPrompt(g) }] },
        })
        .then(async () => {
          const cur = await loadGoal(sessionID)
          if (cur) {
            cur.pending = false
            cur.fail_count = 0
            await saveGoal(sessionID, cur)
          }
        })
        .catch(async (err) => {
          const msg = String(err?.message || err)
          const cur = await loadGoal(sessionID)
          if (!cur) return
          cur.pending = false
          if (/abort|cancel/i.test(msg)) {
            // 用户主动中断视为叫停：自动暂停而不是继续轰炸
            cur.status = "paused"
            await saveGoal(sessionID, cur)
            await toast(`⏸ 检测到手动中断，Goal 已自动暂停（/goal-resume 恢复）`, "info")
          } else {
            cur.fail_count = (cur.fail_count || 0) + 1
            if (cur.fail_count >= MAX_FAILS) {
              cur.status = "blocked"
              cur.blocker = `连续 ${cur.fail_count} 次续跑失败: ${msg.slice(0, 300)}`
              await toast(`⛔ Goal 续跑连续失败，已阻塞`, "error")
            }
            await saveGoal(sessionID, cur)
          }
        })
        .finally(() => {
          inflight.delete(sessionID)
        })
    },

    /**
     * 让目标对模型持续可见：每轮请求时注入 system 提示。
     */
    "experimental.chat.system.transform": async (input, output) => {
      try {
        if (!input?.sessionID) return
        const g = await loadGoal(input.sessionID)
        if (!g) return
        const tail =
          g.status === "pursuing"
            ? `自动续跑进行中（第 ${g.iteration}/${g.max_iterations} 轮）。每轮结束前：达成调用 goal_complete（附证据）；无法继续调用 goal_block；否则用 goal_update_progress 留痕。`
            : `当前状态：${g.status}。`
        output.system.push(
          `[GOAL MODE] 本会话绑定的持久目标：${g.objective}\n完成条件：${g.done_condition || "—"}\n约束：${g.constraints || "—"}\n${tail}`,
        )
      } catch {
        /* 注入失败不影响主流程 */
      }
    },

    /**
     * 上下文压缩时保留 Goal 状态（跨压缩不丢目标）。
     */
    "experimental.session.compacting": async (input, output) => {
      try {
        const g = await loadGoal(input.sessionID)
        if (!g) return
        const recent =
          (g.progress || [])
            .slice(-5)
            .map((p) => `- #${p.iteration} ${p.note}`)
            .join("\n") || "（无）"
        output.context.push(
          `## GOAL MODE 状态（压缩后必须保留）\n目标: ${g.objective}\n完成条件: ${g.done_condition || "—"}\n验证方式: ${g.verification || "—"}\n约束: ${g.constraints || "—"}\n状态: ${g.status} | 迭代: ${g.iteration}/${g.max_iterations}\n最近进度:\n${recent}`,
        )
      } catch {
        /* ignore */
      }
    },
  }
}
