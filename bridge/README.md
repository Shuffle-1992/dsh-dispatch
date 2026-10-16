# DSH ↔ ZCode 客户端「桥」协议（用客户端额度跑任务）

> 用途：**让任务在 ZCode 客户端里执行**（客户端是宿主 → 能用账号型通道，例如免费 Start Plan / GLM-5.3-Flash），DSH 只负责派发与验收。
> 机制：客户端「自动化（定时任务）」按周期把一条**固定指令**投给 agent；指令读本目录的 inbox，执行任务包，把交付写进 outbox。

## 目录

```
bridge/
├── inbox/       # DSH 投放任务包（*.md）；客户端 agent 每次取「文件名排序第一个」
├── outbox/      # 客户端 agent 产出交付（<同名>.done.md）
└── archive/     # 已消费的任务包（客户端 agent 移动过来）
```

## 客户端 agent 的固定指令（贴进「自动化」的指令框）

```
你是 DSH 派发桥的执行端。严格按以下步骤，不要做多余的事：

1. 列出 F:\My Code\zcode-dispatch\bridge\inbox 下的 .md 文件，按文件名升序取第一个。
2. 若目录为空或不存在：只回复 NO_TASK，立即结束，不要读取或执行任何其他内容。
3. 若有任务文件：完整执行该任务包（它自带「交付物 / 禁止 / 验收方式」三段，全部是硬约束）。
4. 完成后：
   a. 把交付文档写到 F:\My Code\zcode-dispatch\bridge\outbox\<任务文件名去掉 .md>.done.md，
      内容含：交付清单 / 可复跑命令 + 原始输出 / 未决问题；
   b. 把 inbox 里的该任务文件移动到 F:\My Code\zcode-dispatch\bridge\archive\。
5. 一次只处理一个任务文件；不要改动 inbox 里其他文件；不要并行开多个任务。
6. 最终回复只给：任务文件名 + 一句话结论 + outbox 文件名。
```

## 自动化怎么配（客户端「自动化」页 → 创建定时任务）

| 字段 | 建议值 |
|---|---|
| 任务标题 | `DSH 派发桥` |
| 执行计划 | **自定义 → 每 2 分钟**（表单若只给小时级，就在会话里对 agent 说"建一个每 2 分钟跑一次的定时任务"，历史实证可行） |
| 指令 | 上文那段（可整段粘贴） |
| 项目 | `<宿主项目>`（必须是客户端已打开的本地项目；本机由 `DSP_SWITCH_FILE` 指向它的开关真值文件） |
| 权限 | **完全访问**（要能改文件、跑命令） |
| 模型 | **Start Plan / GLM-5.3-Flash**（免费额度）；或 BigModel Coding Plan / GLM-5.3-Flash |
| 推理强度 | 跟随默认即可 |

## DSH 侧用法

```bash
node F:\My Code\zcode-dispatch\tools\bridge.mjs submit <任务包路径>   # 投递
node F:\My Code\zcode-dispatch\tools\bridge.mjs status              # 看 inbox/outbox
node F:\My Code\zcode-dispatch\tools\bridge.mjs poll 600            # 等交付（秒）
```

## 纪律

- **单写者**：桥模式启用期间，**不要同时用无头派发**跑同一个仓库/记忆（会互踩）。DSH 会在派发前确认。
- 客户端必须在运行且电脑唤醒（自动化页有「保持唤醒」开关）。
- 自动化上限 20 条；本桥只占 1 条。
- 客户端跑出来的会话在客户端界面可见（有完整 provider/model/mode 记录），便于你人工查看与接管。
