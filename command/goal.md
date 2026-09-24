---
description: 设置 Goal 模式目标（自动多轮推进直到完成条件满足）
---
用户希望设置一个 Goal 模式目标。

目标描述：
$ARGUMENTS

请调用 goal_set 工具创建目标。要求：
- objective = 上述目标描述的核心结果（如果用户写得很长，提炼出"想要达成的结果"）
- 如果描述中包含可验证的完成条件/数值/产物，填入 done_condition
- 如果提到了验证方法（命令、检查文件），填入 verification
- 如果提到了约束（不能破坏什么），填入 constraints
- 如果用户提到轮数上限（如"最多20轮"），填入 max_iterations

若当前会话已有活跃 Goal，如实告知用户并建议 /goal-clear 后再建。
