# OpenCode-Goal

给 [opencode](https://opencode.ai) 的 **Goal 模式**插件 —— 会话级持久目标 + 事件驱动自动续跑 + 证据驱动完成。

> 适配 **OpenCode ≥ 2.0**（V2 插件 API）。旧版 V1 插件在 V2 下会报
> `Plugin must export a default definition with an id and an effect or setup function`，
> 用本版覆盖安装即可（见[从 V1 升级](#从-v1-升级)）。

> 复刻 OpenAI Codex `/goal` 的核心语义：给一个目标，agent 每轮回复结束后自动继续推进，直到**客观达成**、**诚实阻塞**、暂停或达到迭代上限。

```
/goal 把测试 acc 从 0.8874 提升到 0.90，最多 40 轮
```

然后你就不用管了。

---

## 特性

| 能力 | 说明 |
|------|------|
| 🎯 持久目标 | 目标/完成条件/验证方式/约束 绑定到会话，跨轮次存活 |
| 🔁 自动续跑 | 真实执行事件驱动：一轮结束（`session.execution.succeeded`）即注入下一轮；检测到仍在运行的后台任务时暂缓，任务结束 +15s 复检后继续；`session.idle` 兜底恢复 |
| ✅ 证据驱动完成 | 标记完成必须附**具体证据**（命令输出/文件/数值），短证据直接拒绝 |
| ⛔ 诚实阻塞 | 无法继续时调用 `goal_block` 说明原因与所需输入，而不是假装完成 |
| 👁 目标持续可见 | 每轮 system prompt 注入当前目标；上下文压缩时自动保留 |
| 💰 迭代预算 | 默认最多 30 轮自动续跑，超限自动停止并通知 |
| 🛡 防失控 | 跨实例注入互斥锁（`<sessionID>.inject.lock`）+ 后台任务闸门（TTL 安全阀）、pending 标记（崩溃自动恢复）、连续 3 次续跑失败自动阻塞、**手动中断 → 自动暂停** |
| 📝 进度留痕 | 每轮强制 `goal_update_progress`，续跑时携带最近 5 条进度 |

## 安装

### 方式一：拷贝整个配置目录（推荐）

把本仓库内容复制到 opencode 全局配置目录：

```bash
# macOS / Linux
cp -r plugins/* ~/.config/opencode/plugins/
cp -r command/* ~/.config/opencode/command/

# Windows (PowerShell)
Copy-Item plugins\goals.js $env:USERPROFILE\.config\opencode\plugins\
Copy-Item command\goal*.md $env:USERPROFILE\.config\opencode\command\
```

### 方式二：一行命令

```bash
mkdir -p ~/.config/opencode/{plugins,command} && \
curl -fsSL https://raw.githubusercontent.com/LBLBLBLB-XJTU/OpenCode-Goal/main/plugins/goals.js \
  -o ~/.config/opencode/plugins/goals.js && \
for f in goal goal-status goal-pause goal-resume goal-clear; do \
  curl -fsSL "https://raw.githubusercontent.com/LBLBLBLB-XJTU/OpenCode-Goal/main/command/$f.md" \
  -o ~/.config/opencode/command/$f.md; done
```

> **重启 opencode 后生效**。全局安装意味着所有项目都可以用。

依赖：零安装依赖 —— 运行时由 opencode 宿主解析 `@opencode/plugin`，无需 `npm install`（仅跑单元测试时需要，见下文）。

## 快速开始

```
/goal 修复所有失败的测试：完成条件=npm test 全绿，验证方式=运行 npm test，约束=不删除已有测试用例
```

之后：

- agent 完成当前回复 → 空闲 → **自动开始第 1 轮**
- 每轮先检查完成条件 → 未满足则继续推进 → 记录进度
- 达成（附证据）或阻塞时自动停止
- 你随时可以：

| 命令 | 作用 |
|------|------|
| `/goal-status` | 查看目标、迭代数、最近进度、证据/阻塞原因 |
| `/goal-pause` | 暂停自动续跑（保留全部状态）|
| `/goal-resume` | 恢复继续 |
| `/goal-clear` | 彻底清除（删除状态文件）|

## 模型工具

插件同时暴露 8 个工具，agent 在对话中也可自行管理（如你直接说"暂停目标"）：

| 工具 | 用途 |
|------|------|
| `goal_set` | 创建目标（活跃目标存在时拒绝覆盖）|
| `goal_status` | 查看完整状态 |
| `goal_update_progress` | 记录本轮：做了什么/结果/下一步 |
| `goal_complete` | 标记达成（**必须附证据**）|
| `goal_block` | 标记阻塞（原因+所需输入）|
| `goal_pause` / `goal_resume` / `goal_clear` | 生命周期控制 |

## 生命周期

```
                 goal_set
                    │
                    ▼
   ┌──────────── pursuing ◄─────────── goal_resume
   │                │  ▲                    │
   │      ┌─────────┤  └──────┐             │
   │      ▼         ▼         ▼             │
   │  achieved   blocked   paused ──────────┘
   │  (证据)     (原因)     (暂停/中断)
   │                │
   └────────────────┴──► budget_limited (迭代上限)
```

- **achieved / blocked / budget_limited** 后停止续跑，状态仍可查看
- 任意状态均可 `goal_resume` 重新激活（除 achieved）

## 工作原理

1. **事件驱动**：续跑 prompt 提交后，由真实执行事件收尾 —— `session.execution.succeeded`
   清锁并延迟 3 秒安排下一轮；`session.idle` 作为兜底（进程重启 / TUI 重新激活后恢复）。
   事件先落盘再发消息，不会打断你正在输入的内容。
2. **任务闸门与防重**：跟踪运行中的 shell（`shell.created/updated/exited/deleted`），任务未结束前不注入下一轮（结束 +15s 复检，12h 安全阀）；跨实例互斥锁 `<sessionID>.inject.lock`（5s 陈旧接管）保证多实例只注入一次；进程内锁 + `pending` 标记双保险；pending 超过 3 小时视为崩溃残留并自动恢复。
3. **目标始终在场**：`ctx.session.hook("context")` 每轮注入目标；
   `ctx.session.hook("compaction")` 在压缩时注入保留块，且每轮都从磁盘重读目标，压缩不丢状态。
4. **终止条件完备**：达成 / 阻塞 / 暂停 / 清除 / 迭代上限 / 连续失败 / 用户中断
   （esc → 自动暂停），任意一个都会停止续跑。

## 状态存储

每个会话一个文件：`~/.config/opencode/goals/<sessionID>.json`

```json
{
  "objective": "把测试 acc 从 0.8874 提升到 0.90",
  "done_condition": "eval 输出 acc >= 0.90",
  "verification": "运行 python eval.py",
  "constraints": "不允许多模型集成",
  "status": "pursuing",
  "iteration": 7,
  "max_iterations": 40,
  "progress": [{ "iteration": 7, "note": "试了新 lr，0.8891，下一步换调度器" }]
}
```

## 适用场景

- 🔧 性能优化 / benchmark 调参（有明确数值目标）
- 🐛 需要复现和迭代的 bug 排查
- 📦 依赖迁移 / 大重构（"测试全绿"为完成条件）
- 🔬 研究任务（多轮实验直到结论或阻塞）
- 📊 批量数据处理（直到产出全部文件）

**不适合**：一次性问答、没有可验证完成条件的主观任务。

## 文件结构

```
plugins/goals.js        # 插件主体（单文件，运行时零依赖）
command/goal.md         # /goal <目标>
command/goal-status.md  # /goal-status
command/goal-pause.md   # /goal-pause
command/goal-resume.md  # /goal-resume
command/goal-clear.md   # /goal-clear
tests/unit-test.mjs     # 单元测试（mock 插件上下文）
tests/e2e-test.mjs      # 端到端测试（真实服务 + 真实模型）
```

## 从 V1 升级

OpenCode 2.x 不再加载 V1 插件（报错 `Plugin must export a default definition with an id and an effect or setup function`）。
覆盖 `plugins/goals.js` 后重启即可，**目标状态文件格式与路径不变，已有 goal 无需迁移**。主要变化：

| | V1 | V2（本版） |
|---|---|---|
| 入口 | 具名导出 `GoalPlugin` | `export default Plugin.define({ id, setup })` |
| 续跑驱动 | prompt promise 链 | `session.execution.succeeded/failed/interrupted` 事件 + `session.idle` 兜底 |
| system 注入 | `experimental.chat.system.transform` | `ctx.session.hook("context")` |
| 压缩保留 | `experimental.session.compacting` | `ctx.session.hook("compaction")` |
| 进度提示 | TUI toast | 工具返回文本 + 服务端日志（V2 服务端插件无 toast API） |
| 工具名 / 命令 | 8 个工具、5 个命令 | 不变，配置无需改动 |

## 更新日志

### v2.2.0 — 2026-10-17 ｜「运行中不停轮」修复

- **修复：后台任务仍在运行时提前注入下一轮**（旧行为：回合结束后约 3 秒即注入，长任务未完成就开启新轮）
- **修复：多实例重复注入**（opencode 热加载 / 多工作区并存时，同一回合被两个插件实例各注入一次）
- 续跑闸门改由真实运行时事件驱动：跟踪 `shell.created / shell.updated / shell.exited / shell.deleted`（会话关联取 `info.metadata.sessionID`）；仍有未结束的 shell 时不注入，shell 结束后延迟 15s 复检再继续
- 跨实例互斥锁：`<GOAL_DIR>/<sessionID>.inject.lock`（O_EXCL 创建 + 5s 陈旧接管 + token 释放；prompt 受理失败也会释放）
- 安全阀：shell 记录存活超过 12h 视为结束事件丢失，告警后放行；轮次提示词明确要求"等任务真正结束、核对结果后再收尾"
- 单元测试重写为 25 项（main 22 + ttl 3），覆盖运行中暂缓、事件链、互斥锁、陈旧接管、TTL 等新语义

> 升级方式：覆盖 `plugins/goals.js` 即可（无状态迁移）。调试环境变量见文件头部注释（`GOAL_CHAIN_DELAY_MS` / `GOAL_SHELL_RECHECK_MS` / `GOAL_SHELL_TTL_MS` / `GOAL_DIR_OVERRIDE` 等）。

## 测试

**单元测试**（25 项 = main 22 + ttl 3，mock 插件上下文 + 真实事件形状，不触碰真实会话/模型，秒级完成）：

```bash
npm install        # 首次（仅为测试安装 @opencode/plugin）
node tests/unit-test.mjs        # 自动依次运行 main + ttl 两个套件
```

覆盖：事件链续跑、**后台任务运行中暂缓（核心回归）**、`shell.updated` 不重置、短命前台 shell、
`exited`/`deleted` 释放闸门、跨实例互斥锁（外部持有 / 释放恢复 / 陈旧接管）、双触发去重、
暂停恢复、预算上限、TTL 安全阀、context/compaction 钩子注入、完成/阻塞/受理失败路径、cleanup 中止订阅。

**端到端测试**（真实服务 + 真实模型，零 SDK 依赖，约 4 分钟）：

```bash
node tests/e2e-test.mjs
# 或指定独立实例：
OPENCODE_URL=http://127.0.0.1:4097 node tests/e2e-test.mjs
```

验证链路：目标创建 → **事件链自动续跑** → 诚实阻塞（缺输入时不编造）→ 恢复 → 完成（附证据）→
停止续跑。默认自动发现后台服务（Basic auth 自动读取 `service.json`），测试结束自动删除测试会话。

## License

[MIT](LICENSE)
