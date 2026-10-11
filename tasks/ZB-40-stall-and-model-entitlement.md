# ZB-40 事故复盘：「跑了 35 分钟、额度不动」= 上游 1005 + runner 不认 `turn.failed`

> 用户报告：「能否给进行加个显示当前工作内容的状态，可以查看派发的进程确实在工作还是可能是卡住。
> 3 个进行跑了 30 分钟了。并且，额度基本没变化。」
> 结论：**既不是"在工作"，也不是普通的"卡住"** —— 三个作业的第一轮在上游被判
> `1005 exceed quota limit` 后立刻失败，而 runner **只认 `turn.completed`**，于是一直干等 ⇒
> 外部表现就是"running 但零输出、零产物、额度不动"。已修，并补上用户要的"当前工作内容"显示。

## 一、现场证据（2026-10-11 16:00 前后）

| 观测 | 值 |
|---|---|
| `fix-U2/U3/U6` 状态 | `state=running`、已运行 2045s、`tailCount=0`、out/err 文件**不存在** |
| 进程 | runner 存活但 **CPU 0.3s/35min**；各自拉起了 `zcode.cjs app-server --stdio --surface terminal` |
| CLI 日志（3 个会话） | `startup.completed` ✓ → `turn.phase.*` → **`turn.failed` @ 07:27:05/06/07** → 之后**再无事件** |
| 上游错误 | `providerId=account:bigmodel-start-plan`、`providerCode=1005`、`providerMessage="exceed quota limit"`、`modelId=GLM-5.3`、`retryable=false` |
| 额度 | 免费额度 `giftQuota` 读数**是新鲜的**（ZCode 桌面端 35s 前刚写过日志）⇒ "没变化"是**真的没有模型调用**，不是数据陈旧 |
| 旁证 | 同期 `fix-U1-h1` **正常在跑**（它没指定 model ⇒ 用通道默认 `GLM-5.3-Flash`） |

## 二、根因（两层）

1. **模型 ⇄ 权益不匹配**：免费额度（Start Plan 活动赠送）这份权益**只授予 `GLM-5.3-Flash`**
   （`giftQuota.model` 就是它）。三个作业沿用了付费通道时代的 `--model GLM-5.3` ⇒ 上游
   `1005 exceed quota limit`（HTTP 200 包体里的业务错误，不是 429）。
2. **runner 生命周期漏洞**：`appserver-gift.mjs` 的等待循环只由 `turn.completed` 置位 `finished`；
   失败回合只发 `turn.failed` ⇒ **死等到 timeoutMin**（60/75 分钟），期间**零输出**（心跳）。

## 三、修复

| 层 | 修复 |
|---|---|
| **runner 生命周期** | 新增 `case 'turn.failed'`：立刻收尾并把上游业务错误结构化（`providerError{code,message,providerId,modelId,retryable}`）写进 `result.json`；失败归因里对 `exceed quota limit` 直接给 **pause-signature quota-exhausted** + 「权益只授予特定模型，改 model」的提示 |
| **模型 ⇄ 权益校验** | `zcode-run.mjs` 免费额度分支：读到权益授予模型（`giftQuota.model`）且与 `--model` 不一致时，**自动替换为授予模型并大声说明**（`[zcode-run] ⚠️ 模型替换：GLM-5.3 → GLM-5.3-Flash（…）`）——从源头不再撞 1005 |
| **可观测（用户诉求）** | runner 每 **10s** 打一行心跳：`[zcode-run] progress stage=… elapsed=…s chars=… tools=… [lastTool=…] stageAgo=…s [session=…]`；阶段含 `spawn-app-server / create-session / subscribe / set-mode / inject-account / set-model / send-turn / waiting-turn` |
| **派发台解析 + 判定** | `parseRunnerLine` 新增 `progress` 形状；job 落 `progress` + `lastProgressAt`；`slimJob` 带出 `progress` / `lastProgressAgoSec` / **`stalled`**（running 且 >150s 无心跳，含"从未收到心跳"） |
| **面板** | 运行中行显示「**当前：**<阶段> · <最近工具> · N 字 · 工具 N 次 ｜ 最近心跳 Ns」；超时改为**红色「可能卡住」**徽标（含排查提示） |

## 四、验证

- 新测试 `test/progress-heartbeat.test.mjs`（3 项）：心跳行完整/最小形态解析、非心跳 `[zcode-run]` 行仍为
  `null`、`slimJob` 的 `stalled` 四态（新鲜/300s 无心跳/从未心跳/终态）、runner 侧形态（turn.failed 分支、
  心跳模板与清理、模型⇄权益校验）。
- 套件 **30/30**。
- **恢复现场**：三个作业杀掉后用权益授予的 `GLM-5.3-Flash` 重派 ⇒ `fix-U2` **done exit=0**、
  `fix-U6` **done exit=0**（`GLM-5.3` 版本在同一分钟内 `turn.failed` 1005，对比鲜明）。

## 五、教训

1. **"没有输出"本身就是故障信号**：任何"等一个事件"的循环都必须有**心跳**，否则失败与"繁忙"不可区分。
2. **业务错误藏在 HTTP 200 里**（`providerCode 1005`）：不能只看 HTTP 状态码，要看包体 `code/msg`。
3. **权益是要看"授予了哪个模型"的**，不看通道声明的 `models` 列表（那个列表是通道支持的模型，不是已授予的）。
