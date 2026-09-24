# OpenCode-Goal

给 [opencode](https://opencode.ai) 的 **Goal 模式**插件 —— 会话级持久目标 + 事件驱动自动续跑 + 证据驱动完成。

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
| 🔁 自动续跑 | `session.idle` 事件驱动：每轮回复结束即注入下一轮，不需要反复说"继续" |
| ✅ 证据驱动完成 | 标记完成必须附**具体证据**（命令输出/文件/数值），短证据直接拒绝 |
| ⛔ 诚实阻塞 | 无法继续时调用 `goal_block` 说明原因与所需输入，而不是假装完成 |
| 👁 目标持续可见 | 每轮 system prompt 注入当前目标；上下文压缩时自动保留 |
| 💰 迭代预算 | 默认最多 30 轮自动续跑，超限自动停止并通知 |
| 🛡 防失控 | 并发锁 + pending 标记（崩溃自动恢复）、连续 3 次续跑失败自动阻塞、**手动中断 → 自动暂停** |
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

依赖：无额外依赖（使用 opencode 自带的 `@opencode-ai/plugin`）。

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

1. **事件驱动**：监听 `session.idle`。会话空闲且存在 `pursuing` 目标时，通过 SDK 注入下一轮
   （`session.prompt`），而不是简单死循环 —— 不会打断你正在输入的内容。
2. **防重**：进程内锁 + 状态文件 `pending` 标记双保险；pending 超过 3 小时视为崩溃残留并自动恢复。
3. **目标始终在场**：`experimental.chat.system.transform` 每轮注入目标；
   `experimental.session.compacting` 保证长会话压缩后目标与进度不丢失。
4. **终止条件完备**：达成 / 阻塞 / 暂停 / 清除 / 迭代上限 / 连续失败，任意一个都会停止续跑。

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
plugins/goals.js        # 插件主体（单文件，零依赖）
command/goal.md         # /goal <目标>
command/goal-status.md  # /goal-status
command/goal-pause.md   # /goal-pause
command/goal-resume.md  # /goal-resume
command/goal-clear.md   # /goal-clear
```

## 测试

**单元测试**（18 项，mock client，不触碰真实会话）：

```bash
node tests/unit-test.mjs
```

覆盖：工具集完整性、重复创建拒绝、idle 触发续跑、续跑消息内容、进度记录、短证据拦截、完成后停止、暂停恢复、迭代上限、清理等。

**端到端测试**（真实 server + 真实模型，验证完整生命周期）：

```bash
opencode serve --port 4097   # 另开终端
node tests/e2e-test.mjs
```

验证链路：目标创建 → **自动续跑** → 诚实阻塞（缺输入时不编造）→ 恢复 → 完成（附证据）→ 停止续跑。

## License

[MIT](LICENSE)
