# DSH 派发台（dispatch）

> 一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件：
> 把任务派发给本机 **四个 AI 编程 CLI**（ZCode / OpenCode / Qoder / WorkBuddy）的无头进程，
> 并在 DSH 页面右下角的悬浮面板里监视它们。

DSH 自带的 `subagent` 跑的是 DSH 自己的 agent；**本插件跑的是你自己的 CLI** —— 独立进程、
独立额度、独立会话。任务行出现在「DSH 派发台」面板里，可查输出、可终止、可续跑、可换通道重跑。

## 四个引擎

全部走**官方 CLI**：不反代、不模拟 OpenAI/Anthropic 兼容接口、不读写任何凭据内容 ——
插件只负责"起进程 / 传参数 / 读 stdout"。四个引擎**自动发现**（env → 配置 → PATH →
已知安装位置 → 跨盘符扫描），**不需要手填路径**。

| 引擎 | 官方 CLI | 登录 | 额度 / 积分 |
|---|---|---|---|
| **ZCode** | `zcode.cjs`（桌面客户端自带） | 读客户端凭据 | ✅ 能查（含**免费额度 Start Plan** 通道） |
| **OpenCode** | `opencode`（PATH） | 免费模型无需凭据 | 免费（无额度概念） |
| **Qoder** | `qoderclicn`（PATH） | ⚠️ 需单独登录 | ⚠️ 积分制，无余额接口；单次消耗可查 |
| **WorkBuddy** | `codebuddy`（客户端内置） | ⚠️ 需单独登录 | ⚠️ 积分制，CLI 完全不暴露 |

**拿不到的就不显示**（不编数字、不猜汇率）—— 详见 [四个引擎详解](docs/engines.md)。

## 它做什么

| 能力 | 说明 |
|---|---|
| **派发（四引擎）** | 把 `prompt` / 任务文件 / 目标描述交给任一引擎跑；`build/edit/plan/yolo` 四种模式仅 ZCode 支持 |
| **单写者互斥** | `repo` / 文件锁 + 进程内 FIFO 队列：同锁任务串行，冲突只排队不报错 |
| **实时监视** | 状态、耗时、**Token 用量**、上下文占用、**积分/费用**、退出码、锁持有者；可 tail 最近输出 |
| **续跑 / 重跑** | 同会话 `--resume` 重发原提示词，或发新指令（仅 ZCode 支持 resume） |
| **通道与降级链** | 切换通道 / 模型 / 思考强度；额度耗尽时按降级链自动交接重跑到下一个可用通道 |
| **分流模式** | 主通道名额满时把新任务自动改派到降级通道（两条通道并发名额叠加） |
| **思考强度核对** | 记录请求档位 vs 实际生效档位，不符时给出向上改档建议 |
| **引擎登录助手** | WorkBuddy 登录态四态显示 + 一键登录；登录服务**温和终止**、残留标记自动诊断 |
| **免费额度通道** | ZCode **Start Plan**：托管官方 app-server 走逐请求签名，与付费通道复用同一套流水线 |
| **用量聚合** | 本地台账 5 小时滚动 / 本周 / 今日，外加套餐剩余额度 |
| **派发总开关** | 一个跨会话真值文件：`false` = 任何会话都不得派发（runner / 插件 / 桥接三处强制生效） |
| **agent 工具** | 注册 `dispatch` 工具，与面板共用同一套动作实现（一操作两调用方） |
| **落地自动唤醒** | 任务落地（done/failed/killed/paused）时唤醒发起会话，与 DSH 后台任务同款 |

## 快速开始

**安装**（本项目不发布 npm，只从 GitHub 仓库装）：

```bash
dsh plugin --profile <你的profile> add "github:Shuffle-1992/dsh-dispatch#path:dispatch"
```

> `#path:dispatch` **不能省** —— 本仓库是 monorepo，插件本体在 `dispatch/` 子目录。

**配置**（`runnerPath` 与 `workRoot` 任一为空则不创建 dispatcher，面板走 demo 降级）：
机器专有路径放 `~/.dsh/profiles/<profile>/cordis.patch.yml`，按 id 覆盖。

完整步骤、配置字段全表、常见安装问题见 **[安装与配置](docs/install.md)**。

## 文档

| 文档 | 讲什么 |
|---|---|
| [安装与配置](docs/install.md) | 两种安装方式、字段全表、profile patch、常见安装问题 |
| [四个引擎](docs/engines.md) | 各引擎能力/额度、**为什么走官方 CLI 而不是反代**、实测并发上限 |
| [使用](docs/usage.md) | 悬浮面板、agent 工具动作表、**派发优先级与三条硬规则**、免费额度通道 |
| [凭据与 401](docs/credentials.md) | ZCode 报「身份验证失败」的根因与修法 |
| [架构](docs/architecture.md) | 目录结构、设计取舍、复跑证据、第三方材料声明 |
| [踩坑总账](pitfalls.md) | 每个真机坑的现场、根因、修法（最厚的一份，问题排查先查它） |
| [引擎细节与验收](dispatch/teaching.md) | 引擎协议细节、登录、额度、验收清单 |
| [DSH 0.2.1 兼容性审查](docs/DSH-0.2.1-COMPAT-REVIEW.md) | 上游 API 兼容面 |
| [项目全面审查报告](docs/项目全面审查报告-2026-10-26.md) | 外部审查的 13 项问题与修复记录 |
| [代码审查 2026-10-17](docs/CODE-REVIEW-2026-10-17.md) | 历史审查留档 |

交接与历史留档：[`docs/CREATOR-HANDOFF.md`](docs/CREATOR-HANDOFF.md)、
[`docs/NEXT-SESSION-HANDOFF.md`](docs/NEXT-SESSION-HANDOFF.md)、
[`docs/OPENCODE-DISPATCH-HANDOFF.md`](docs/OPENCODE-DISPATCH-HANDOFF.md)。

## 许可

MIT（见 [`LICENSE`](LICENSE)）。`refs/` 下的第三方材料沿用其各自许可
（详见 [架构文档的第三方材料声明](docs/architecture.md#第三方材料声明)）。
