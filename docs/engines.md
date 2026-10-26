# 四个引擎：能力、额度、以及为什么走官方 CLI

> 本文是 [README](../README.md) 中「四个引擎」一节的展开。决策依据、实测数据与取舍理由都在这里。

## 总览

全部走**官方 CLI**：不反代、不模拟 OpenAI/Anthropic 兼容接口、不读写任何凭据内容 ——
插件只负责"起进程 / 传参数 / 读 stdout"。"通道即执行目标"是 core 的模型
（`zcode` / `opencode/<model>` / `qoder/<model>` / `codebuddy/<model>`）。

| 引擎 | 官方 CLI | 登录 | 额度 / 积分 | 备注 |
|---|---|---|---|---|
| **ZCode** | `zcode.cjs`（桌面客户端自带） | 读 `~/.zcode/v2/credentials.json` | ✅ **能查**（客户端日志里的 balance 行） | 支持「套餐」与「免费额度 Start Plan」两条路由 |
| **OpenCode** | `opencode`（PATH） | 免费模型无需凭据 | 免费（无额度概念） | 十几个免费模型；并发上限默认 2（实测依据） |
| **Qoder** | `qoderclicn`（PATH） | ⚠️ **需单独登录** | ⚠️ 积分制，**无余额查询接口**；单次消耗可查（`credits`） | 与桌面应用登录**不共享**；并发默认 3（实测） |
| **WorkBuddy** | `codebuddy`（WorkBuddy 客户端内置） | ⚠️ **需单独登录** | ⚠️ 积分制，**CLI 完全不暴露** | 见下节「积分可得性」；并发默认 2（保守默认，未实测） |

**引擎自动发现**：四引擎都走 `collab-kit/engine-discover.mjs` 的五级探测
（env → 配置 → PATH → 已知安装位置 → 跨盘符扫描），**不需要手填路径**；
面板「引擎」行显示形态 / 版本 / 登录态，点悬浮看探测依据。

**四引擎的差异不会被"抹平"**：每个引擎在 `validateSpec` 里剔除自己不支持的参数
（如 Qoder/WorkBuddy 不支持 `mode` / `memoryBench`），并在面板"引擎提示"行如实说明，
不是静默忽略。

## 积分可得性（真机实测结论，不猜）

| 引擎 | 余额 | 单次消耗 | 依据 |
|---|---|---|---|
| ZCode | ✅ `giftQuota` | token | 读客户端日志（只读，零网络） |
| OpenCode | — | token | 免费模型 |
| Qoder | ❌ 官方无接口 | ✅ `credits` | `result.total_credits` **恒 0**，真值在每条 assistant 的 `message.usage.credits`（需按 `message.id` 去重累加） |
| WorkBuddy | ❌ 官方无接口 | ❌ | stream-json 只有 token；`total_cost_usd` **恒 0**；`/cost` `/stats` 无头不支持；`--serve` REST 无 usage 端点；本地存储无数值 |

⇒ 面板与 agent 工具**只显示真拿得到的数**：拿不到就**不显示**（不编数字、不猜汇率折算）。
「哪个引擎查不到」这种元数据仍完整保留在 `action=channels` 的 `creditSummary` 里给 agent 读。

## 为什么走官方 CLI，而不是反代

社区有把 WorkBuddy / Qoder 的账号登录态**反代成 OpenAI/Anthropic 兼容接口**的做法。
本项目**刻意不做**：

1. **合规**：反代本质是伪造客户端身份调官方接口，官方一收紧就会被封（WorkBuddy 已经开始限制）。
   走官方 CLI 是产品自身入口，不受这类限制影响。
2. **不碰凭据**：插件**只读**做登录态探测（凭据文件**是否存在 / 大小 / 刷新时间**），
   **从不读内容、不写、不删**。修复动作一律交给用户或官方 `/login`。
3. **能力完整**：CLI 自带完整工具链（读写文件、跑命令、MCP）；反代只能拿到"对话"，
   DSH 的工具层反而用不上。

代价：只能拿到 CLI **愿意暴露**的数据 —— 比如 WorkBuddy 的积分就查不到（见上表）。
本项目的态度是**如实标注"查不到"，不编数字**。

> 长任务在看守进程那侧还会被**温和终止**（3 秒后才兜底强杀）—— 因为真机发现强杀 WorkBuddy CLI
> 会留下 `.logged-out` 标记，导致之后一直判"未登录"（详见 [`pitfalls.md`](../pitfalls.md)）。

## 并发上限（实测，不是拍脑袋）

| 引擎 | 默认并发 | 依据 |
|---|---|---|
| ZCode（付费 + 免费额度） | 3 | 账号级并发上限 3：第 4 个起报 `3008 user concurrency limit exceeded`（模型级是 `3009`） |
| OpenCode | 2 | 并发 opencode 进程会零输出 `exit 1` |
| Qoder | 3 | 3/5 个 `qoderclicn` 并发全部 `exit=0` 且结果正确 |
| WorkBuddy | 2 | 保守默认（该 CLI 是 Electron 内置 bundle，比纯 CLI 重），**未实测** |

> **测并发数的坑**：批量间隔必须 ≥20 秒。间隔太短时，上一批 app-server 仍占着名额，
> 会把真实的 3 测成 2（本项目真的踩过，见 `pitfalls.md` ZB-106）。
