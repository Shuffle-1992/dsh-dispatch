# ZB-50：Qoder 接入派发台 —— 方案调研与接入设计（**未实施**）

> 生成：2026-10-16 ｜ 类型：**调研 + 设计**（本轮**不写执行器**，只交付可执行方案与前置动作）
> 结论先行：**可行**，且与前两个引擎**同构**（最像 OpenCode 的 NDJSON 事件流），
> 但有一个**必须先解决的前置**：Qoder **必须登录**（账号或 PAT），本机尚未安装。

---

## 0. 一句话结论

Qoder CLI 的无头接口比 OpenCode 更完整（`-p` 非交互 + `-o json|stream-json` + `--session-id`/`--resume`/`--fork-session`），
接入方式建议**与 OpenCode 同构**：新增第三个执行器 `collab-kit/qoder-run.mjs`，按需 spawn、解析 NDJSON、复用现有行协议与 `auto` 开关。
**前置动作（需你决定）**：① 安装 Qoder CLI；② 提供一个 Qoder 账号或 PAT（这是唯一的硬门槛）。

---

## 1. 调研事实（每条给官方出处）

### 1.1 无头调用形态（与派发台模型完全匹配）
| 能力 | Qoder CLI 形态 | 出处 |
|---|---|---|
| 非交互 | `qoder -p "<prompt>"`；prompt 也可经 stdin 传入（`echo "..." \| qoder -p`） | [run-in-scripts](https://docs.qoder.com/cli/run-in-scripts) |
| 输出格式 | `-o/--output-format`：`text`(默认) / `json`（单个 JSON 对象）/ `stream-json`（**逐行 JSON 流 = NDJSON**） | [run-in-scripts](https://docs.qoder.com/cli/run-in-scripts) |
| 工作目录 | `-w/--cwd <dir>`；`--add-dir` 追加受信任目录 | [cli-reference](https://docs.qoder.com/cli/cli-reference) |
| 会话续跑 | `--session-id <id>`、`--resume/-r [id]`、`-c/--continue`、`--fork-session`、`--no-session-persistence` | [cli-reference](https://docs.qoder.com/cli/cli-reference) |
| 轮数/token 上限 | `--max-turns <n>`（防无限循环）、`--max-output-tokens <n>` | [cli-reference](https://docs.qoder.com/cli/cli-reference) |
| 工具白/黑名单 | `--tools`、`--allowed-tools`、`--disallowed-tools` | [cli-reference](https://docs.qoder.com/cli/cli-reference) |
| 模型 | `-m/--model`（如 `auto`/`lite`/`performance` 或 BYOK key）、`--list-models` | [cli-reference](https://docs.qoder.com/cli/cli-reference) |
| 思考强度 | `--reasoning-effort <lv>`（如 `high`）、`--context-window <n>` | [cli-reference](https://docs.qoder.com/cli/cli-reference) |
| 隔离执行 | `--worktree [name]`（新 Git worktree 内跑，结果合回） | [cli-reference](https://docs.qoder.com/cli/cli-reference) |
| 服务模式 | `qoder --acp`（ACP over stdio，JSON-RPC） | [acp](https://docs.qoder.com/cli/acp) |
| SDK | `@qoder-ai/qoder-agent-sdk`（TS）/ `qoder-agent-sdk`（Python） | [agent-sdk](https://qoder.com/agent-sdk) |

### 1.2 事件流结构（**关键未知项**：CLI 层字段未在文档给出）
SDK 与 `qodercli` 之间是同一套 **JSONL 协议**（"each protocol message is one JSON object on one line"），
可作为 `stream-json` 的**权威形态参考**（出处：[sdk/how-it-works](https://docs.qoder.com/cli/sdk/how-it-works)、[sdk/references-typescript](https://docs.qoder.com/cli/sdk/references-typescript)）：

- 判别字段 `type` ∈ `system | assistant | user | result | stream_event | prompt_suggestion | cloud_agent_event`
- `system/init`：`session_id`、`qodercli_version`、`cwd`、`model`、`permissionMode`、`tools[]`、`apiKeySource`、`capabilities[]`
- `assistant`：`message.content[]`（`text | tool_use | thinking`）+ `message.usage{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, credits, billable}`
- `result`：`subtype`（`success | error_max_turns | error_during_execution`）、`is_error`、`duration_ms`、`num_turns`、`result`、`session_id`、`usage`、`total_credits`、`modelUsage{...}`
- `stream_event`（需开启 partial messages）：`event.delta{type,text,partial_json,thinking}`

> ⚠️ **CLI 的 `-o json/stream-json` 是否原样含这些字段，官方文档没说** ⇒ 属于**必须真机抓一次**才能定 parser 的事项（见 §6 前置动作）。

### 1.3 权限（**接入的核心风险点**）
判定结果三态 `allow / ask / deny`，`ask` 在不同环境的消费方式**完全不同**（出处：[permissions](https://docs.qoder.com/cli/permissions)）：

| 环境 | `ask` 的结果 |
|---|---|
| TUI 交互 | 终端弹确认 |
| **Headless（`-p`）** | **自动 deny**（不会挂住等人） |
| SDK | 回调 `canUseTool` 交给宿主决定 |
| ACP | `requestPermission` RPC 交给 IDE |

模式语义（出处同上）：`default`（敏感操作要确认）/ `accept_edits`（**自动批准工作目录内的文件编辑**，shell 与敏感路径仍检查）/
`auto`（由 agent 决定）/ `bypass_permissions`＝`--yolo`＝`--dangerously-skip-permissions`（跳过确认）/
`dont_ask`（从不提示，要问的直接拒绝）。

> 🔴 **最关键的一条**：**非默认权限模式只在"受信任目录"里生效；当前目录不受信任时会回落到 `default`**
> ⇒ 在无头下等于"写文件全部被拒"。所以接入**必须**同时解决"目录受信任"（`--add-dir` 或信任配置），
> 否则会出现"任务跑完了但什么都没改"的静默失败。

### 1.4 认证与目录（决定"能不能零成本验证"）
- **必须登录**："Authentication is required before using Qoder"（出处：[authentication](https://docs.qoder.com/cli/authentication)）。
  两种形态：① 交互式浏览器登录；② **PAT**：环境变量 `QODER_PERSONAL_ACCESS_TOKEN`（PAT 在 qoder.com/account/integrations 创建，且**优先级高于** `/login` 凭据）。
- 免费额度：Credits 用尽后**仍有每日有限的 basic 模型调用**；错误码 `114 Free-trial account limit`、`115 Free-user quota`；`ModelInfo.isFree`（出处：[Credits](https://docs.qoder.com/Credits)、[sdk/errors](https://docs.qoder.com/cli/sdk/errors)）。
- 目录：用户级 `~/.qoder/`（可用 `QODER_CONFIG_DIR` 或 `--config-dir` 改）；项目级 `<project>/.qoder/`（`settings.json` / `settings.local.json` / `rules/` / `skills/` / `worktrees/`）。
- 会话落盘：`~/.qoder/projects/<project-name>/<session-id>.jsonl` + `<session-id>/state.json`（出处：[sessions](https://docs.qoder.com/cli/sessions)）。
- 平台：macOS / Linux / Windows（Windows arm64 暂不支持）；Windows 安装 `irm https://qoder.com/install.ps1 | iex`（原生 exe，具体落点文档未给，用 `Get-Command qoder` 验证）；npm 旧途径 `@qoder-ai/qodercli`，shim 在 `%APPDATA%\npm\qoder.cmd`。

---

## 2. 与前两个引擎的对照（为什么应当复用现有抽象）

| 维度 | ZCode | OpenCode | **Qoder（拟）** |
|---|---|---|---|
| 无头调用 | `zcode` + 自定义 runner | `opencode run --format json` | **`qoder -p -o stream-json`** |
| 事件形态 | 自定义前缀行 | NDJSON | **NDJSON（同形）** |
| 会话续跑 | `--resume` | `-s <sessionId>`（**按 cwd 作用域**） | **`--session-id`（按项目隔离）** |
| 权限放行 | 无（不需要） | `--auto`（默认关） | **`--permission-mode`（默认 fallback 风险）** |
| 认证 | 本机 ZCode 客户端 | 需 `opencode auth login`（本机已就绪） | **必须登录 / PAT（本机未安装）** |
| 免费额度 | Start Plan 免费通道 | 12 个免费模型 | **每日有限 basic 调用 / 免费 Credits** |

**结论**：Qoder 与 OpenCode **同构度最高** ⇒ 接入成本主要在"抓一次真实事件样本 + 权限/信任处理"，
而不是架构改动。`engine` 作为通道属性、行协议按引擎参数化、每引擎并发上限、`auto` 放行开关**全部可以直接复用**。

---

## 3. 接入设计（待批准后实施）

### 3.1 执行器：`collab-kit/qoder-run.mjs`（新建，与 `opencode-run.mjs` 同构）
- **调用**：`qoder -p <prompt> -w <cwd> -o stream-json [--model <m>] [--reasoning-effort <lv>] [--session-id <id> | --resume] [--max-turns <n>] [--permission-mode <mode>] [--add-dir <cwd>]`
- **认证隔离（满足硬约束"不碰用户 agent 配置"）**：`QODER_CONFIG_DIR` 指向**执行器私有目录**
  （如 `<workRoot>/.engines/qoder-config/`），PAT 经 `QODER_PERSONAL_ACCESS_TOKEN` 注入。
  ⚠️ 代价：失去用户既有登录态 ⇒ **必须**用 PAT（或让用户显式授权复用其 `~/.qoder`，那是另一个决策）。
- **解析**：复用 `run-line-protocol.mjs` 加 `qoder` 引擎（前缀 `[qoder-run]`），
  把 NDJSON 事件映射成既有行形状：`usage` / `context` / `progress` / `out` / `err` / `result` / `done`。
- **产物**：与 OpenCode 一致落 `collab/logs/qoder-run-{tag}-{ts}.{out,err,result.json}.log`。
- **超时**：**任何兜底都必须挂在 `--max-turns`/`timeoutMin` 之上，不得有独立的短兜底**
  （OpenCode 那个 15s 误杀慢模型的教训，见 `tasks/ZB-44-delivery.md` §4.4）。

### 3.2 权限映射（**已定稿：方案 A + 信任目录双保险**）

**用户要求「新的 Agent 开箱即用、避免各种撞墙、默认参数最优」**，故权限这块按"默认就能干活、但不过度放权"定死：

| `spec.auto` | 传给 Qoder 的参数 | 语义 |
|---|---|---|
| **`false`（默认）** | `--permission-mode accept_edits --add-dir <cwd>` | **自动批准工作目录内的文件编辑**；shell / 敏感路径 / 外部动作**仍走正常检查**（无头下会被拒） |
| **`true`（显式放行）** | `--permission-mode bypass_permissions --add-dir <cwd>` | 跳过确认（仅保留"删工作目录/家目录/根"这类极小路径保护） |

为什么默认必须是 `accept_edits` 而不是更保守的 `dont_ask`：后者在无头下"要问的一律拒绝"，
结果是**任务跑完一个文件都没改**——新 Agent 会把它误判成"执行器坏了"（正是"撞墙"）。默认能改文件才叫开箱即用。

**🔴 信任目录是必须同时解决的第二个坑**：官方明确"**非默认权限模式只在受信任目录生效；当前目录不受信任时回落到 `default`**"，
而 `default` 在无头下 = 写操作全被拒 ⇒ **静默失败**（任务显示成功、代码没变）。对策（双保险）：
1. **总是传 `--add-dir <cwd>`**（"为当前会话添加额外受信任目录"）；
2. 执行器**核对 `system/init.permissionMode` 与传入值**：不一致 ⇒ 判定"回落到 default"，
   在 `[qoder-run]` 行里**明确警告**，并把 job 标为需要关注（绝不让它静默"成功"）。
3. 兜底（**仅在用户显式同意时才做**）：项目级 `<project>/.qoder/settings.json` 支持
   "Permission rules and **Directory Trust Policies**"（官方原文）——那是团队共享、可提交的配置，
   **执行器不得擅自写用户的项目文件**，故只作为文档化的建议提供给用户。

### 3.2b 认证隔离（**已定稿：默认复用用户登录态，PAT 只是可选覆盖**）

**用户追问：「安装 IDE 登录，能不能省去 PAT？」—— 能。而且不必装 IDE。**

官方原文：**"Authentication is required before using Qoder. When you run a command for the first time, Qoder CLI will automatically prompt you to sign in."**
以及 **"User-level data (such as `settings.json`, authentication status, and plugins) is stored in the User Configuration Directory, which defaults to `~/.qoder`"**。
⇒ **CLI 自身就能完成登录**（`qoder` → `/login`，或浏览器授权，或粘贴 token），登录态落在 `~/.qoder`；
**IDE 与 CLI 共享同一套账号与同一个用户配置目录**，所以在 IDE 里登录后，CLI 直接就是"已登录"状态。
**装 IDE 不是省 PAT 的必要条件**，省 PAT 的条件是"**本地有一次有效登录**（CLI 或 IDE 均可）"。

> ⚠️ 修正一处此前的表述错误：复用登录态**必须让 Qoder 读它自己的默认用户配置目录 `~/.qoder`**
> （凭据与 authentication status 都在里面）。**不能**同时要求"复用登录态"和"把 `QODER_CONFIG_DIR` 指到隔离目录"
> —— 隔离目录里没有凭据，那样只能走 PAT。二者是**二选一的两条路**，不是叠加的。

| 路径 | 前提 | 是否要 PAT | 隔离性 | 默认 |
|---|---|---|---|---|
| **① 复用登录态（推荐，开箱即用）** | 本地登录过一次（**CLI 或 IDE 都行**） | **不需要** | 让 Qoder 用它自己的 `~/.qoder`（凭据+缓存）。我们**不写**它的 `settings.json`、不碰 plugins、不读会话内容 | ✅ **默认走这条** |
| ② PAT + 隔离目录 | 生成一个 PAT | 需要 | 最强：`QODER_CONFIG_DIR=<workRoot>/.engines/qoder/`，除 PAT 外不依赖任何本地状态（适合 CI/多机） | 可选（配了 PAT 即自动切到这条） |
| ③ 都没有 | — | — | — | 不 spawn + 可操作错误 |

**两条路的执行器行为差异（实现要点）**：
- ①：**不设** `QODER_CONFIG_DIR`（或显式设成用户的默认目录），让 Qoder 自然使用 `~/.qoder` 的登录态；
  我们唯一的写入落在自己的产物目录（`collab/logs/`）。
- ②：**设** `QODER_CONFIG_DIR` 为隔离目录 + 注入 `QODER_PERSONAL_ACCESS_TOKEN`。
- **判定逻辑**：`QODER_PERSONAL_ACCESS_TOKEN` 已设 ⇒ 走 ②；否则探测 `~/.qoder` 是否有登录态 ⇒ 有则 ①、
  没有则 ③。**探测只做"存在性判断"，不解析凭据内容**。

**"不碰用户配置"的边界（说准）**：硬约束禁止的是**写入/篡改**用户 agent 的配置与数据。
- **绝不写**：`~/.qoder/settings.json`、authentication status、plugins、`~/.qoder/projects/**`；
- **绝不读**：会话内容 `~/.qoder/projects/*/*.jsonl`（用户隐私）——只需要"是否有凭据"这一个事实；
- 路径 ① 下 Qoder 自身可能在其 `~/.qoder` 里更新缓存/会话记录，那是**它本来的正常行为**（与用户在终端里跑 `qoder` 完全一致），不是我们新增的写入。

### 3.2c 默认参数定稿（**目标：新 Agent 开箱即用、默认就是最优、不必读文档**）

执行器对**每一次** spawn 都自动带上下面这套（调用方**什么都不用传**）：

| 参数 | 默认值 | 为什么（防的哪面墙） |
|---|---|---|
| `-p` | 恒开 | 非交互模式，否则会进 TUI 挂死 |
| `-o stream-json` | 恒开 | 要 NDJSON 事件流，否则只有一段文本、拿不到 usage/工具/会话 |
| `-w <cwd>` | 取 job 的 `spec.cwd` | 工作目录必须显式，别依赖 runner 的 cwd |
| `--permission-mode accept_edits` | 默认 | 不放行就"跑完什么都没改"（见 §3.2） |
| `--add-dir <cwd>` | 恒带 | 防"目录不受信任 ⇒ 回落 default ⇒ 静默失败" |
| `--max-turns <n>` | **80**（可由 `spec.maxTurns` 覆盖） | 防无限循环烧额度；80 轮足够绝大多数改造任务 |
| `--reasoning-effort` | 不传（用上游默认） | 除非 `spec.reasoningLevel` 明确指定 |
| `--model` | 不传 ⇒ Qoder 自己选（`auto`） | 免费/basic 额度下让它自选，反而更稳 |
| `--session-id` | 仅 `resume` 时传 | 续跑；**同 cwd**（Qoder 会话按项目隔离） |
| `--config-dir` / `QODER_CONFIG_DIR` | **不设**（复用登录态路径） | 凭据在默认 `~/.qoder` 里；设成隔离目录就只能走 PAT（见 §3.2b） |
| `--no-session-persistence` | **不传** | 传了就不可续跑；续跑能力我们要留着 |
| 超时兜底 | 只挂在 `timeoutMin` 之上 | OpenCode 那个 15s 误杀慢模型的教训 |

**"避免撞墙"清单**（每条都是真机/文档确认过的坑，逐条有对策）：

| # | 会撞的墙 | 现象 | 对策 |
|---|---|---|---|
| W1 | 未登录 | 首次运行弹交互式登录（无头下挂住/失败） | §3.2b 三级降级；③ 分支**不 spawn** + 可操作错误 |
| W2 | **目录不受信任 ⇒ 回落 `default`** | 任务"成功"但**没改任何文件** | `--add-dir` + 核对 `system/init.permissionMode` 并报警（§3.2） |
| W3 | 默认不放行 | 写操作被 deny | 默认 `accept_edits` |
| W4 | 无限循环 | 烧光额度、任务永不结束 | `--max-turns 80` + `timeoutMin` |
| W5 | 进 TUI | 子进程挂住不返回 | 恒带 `-p` |
| W6 | 想续跑却换了 cwd | 找不到会话、静默开新会话 | sessionId 与 cwd **一起持久化**；续跑必须同 cwd |
| W7 | 自动更新改了输出格式 | parser 解析不到字段 | 记录 `qoder --version`；"版本变了先复验样本"写进门禁（同 OpenCode） |
| W8 | 把用户 `~/.qoder` 写脏 | 违反硬约束、污染用户环境 | 写入一律落 `QODER_CONFIG_DIR` 隔离目录（§3.2b） |
| W9 | 免费额度耗尽 | 任务中途失败 | 识别错误码 `114/115` + `ModelInfo.isFree`，给可读原因；并发默认 1 |
| W10 | 事件类型未登记 | 解析崩或丢信息 | 未登记 `type` **降级透传**进 `unknownEvents`，绝不抛（沿用 OpenCode 纪律） |

### 3.3 core / host / client 改动面（估算）
| 层 | 改动 | 量级 |
|---|---|---|
| `run-line-protocol.mjs` | `ENGINES` 加 `qoder`、前缀、`isQoderId`（`qoder/<model>`？或通道 id `qoder`） | 小 |
| `dispatch-core.mjs` | 引擎路由（`engine='qoder'`）、`buildQoderArgs()`、每引擎并发上限 `maxConcurrentQoder`（**默认 1**：Qoder 免费 basic 额度有限）、通道探测（`qoder --list-models`） | 中 |
| `wire.host.mjs` / `index.js` | `auto` 语义扩展到 qoder（不再只 opencode）、`qoderRunnerPath` 配置、`--engine qoder` | 小 |
| `client.js` / `locale` | 第三组 optgroup「Qoder 通道」+ 引擎徽标 + 引擎提示文案 | 小 |
| 测试 | `qoder-executor.test.mjs`（离线，真实抓的 NDJSON fixture）、协议/路由/UI 三处扩展 | 中 |

### 3.4 需要新增的"不可用"路径
若机器上没装 Qoder 或没登录 ⇒ **Qoder 通道为空 + 可读 warning**，**ZCode/OpenCode 照常**
（与 OpenCode 探测失败的处理完全一致，绝不让第三个引擎拖垮整份清单）。

---

## 4. 风险与对策

| # | 风险 | 影响 | 对策 |
|---|---|---|---|
| R1 | **必须登录**（本机未安装、无账号） | 无法真机验证、无法零成本跑 | 先解决账号/PAT；执行器用 `QODER_CONFIG_DIR` + PAT 隔离 |
| R2 | **非默认权限模式仅在受信任目录生效**，否则回落 `default` ⇒ 无头下写全被拒 | **静默失败**（任务"成功"但没改文件） | ① 传 `--add-dir <cwd>`；② 执行器比对 `system/init.permissionMode`，不一致就**明确报警** |
| R3 | CLI 层 `json/stream-json` **字段未文档化** | parser 可能白写 | **前置动作**：真机抓一次 `-o json` 与 `-o stream-json` 样本再定 |
| R4 | 默认开启自动更新（`general.enableAutoUpdate`） | 输出格式可能随版本漂移 | 记录 `qoder --version`，把"版本变了先复验"写进文档（同 OpenCode 的门禁） |
| R5 | 免费额度有限（每日 basic / Credits 用尽） | 任务中途失败 | 并发上限默认 1；按 `result.usage.credits`/错误码 114/115 识别并给出可读原因 |
| R6 | 会话按**项目**（非 cwd）隔离，路径含"处理过的项目路径名" | 续跑时若 cwd 变了可能找不到会话 | 与 OpenCode 同样：**把 sessionId 与 cwd 一起持久化**，续跑必须同 cwd |
| R7 | ACP 协议版本未声明 | 若走 ACP 有兼容漂移 | 本轮不走 ACP（保底方案见 ② 路径） |

---

## 5. 决策定稿（本轮已按用户要求定死，**不再待确认**）

用户的三条要求：「权限映射」「认证隔离」「**新的 Agent 开箱即用、避免各种撞墙、默认参数设置最优**」。

1. **走路径 ①**（spawn `qoder -p -o stream-json`），不走 ACP、不走 SDK —— 与 OpenCode 同构、零额外依赖、改动最小。
2. **权限映射（定稿）**：`auto:false → --permission-mode accept_edits`；`auto:true → bypass_permissions`；
   **恒带 `--add-dir <cwd>`** 并**核对 `system/init.permissionMode` 回落即报警**（详见 §3.2 + W2）。
3. **认证隔离（定稿）**：**两条路二选一**，默认走"复用登录态"（**不需要 PAT**）：
   ① 本地登录过一次（**CLI 或 IDE 都行**）⇒ 让 Qoder 用它自己的 `~/.qoder`，我们**不写**其 settings/plugins、不读会话内容；
   ② 设了 `QODER_PERSONAL_ACCESS_TOKEN` ⇒ 自动切到 PAT + `QODER_CONFIG_DIR=<workRoot>/.engines/qoder/` 全隔离（适合 CI/多机）；
   ③ 两者都没有 ⇒ **不 spawn** + 可操作的可读错误（详见 §3.2b）。
   ⚠️ 「复用登录态」与「隔离 config dir」**不可叠加** —— 凭据就在默认 config dir 里，隔离目录里没有凭据。
4. **默认参数（定稿）**：见 §3.2c 全表 —— 调用方什么都不用传即得到最优行为（`-p -o stream-json`、
   `accept_edits`、`--add-dir`、`--max-turns 80`、隔离 config dir、超时只挂 `timeoutMin`）。
5. 新增 `maxConcurrentQoder` 默认 **1**（免费额度谨慎；额度充足可调）。
6. 通道 id 形态**待抓包后定**（`qoder` 单通道 vs `qoder/<model>`／每模型一通道）——
   取决于 `qoder --list-models` 的输出粒度。

---

## 6. 前置动作（**卡在你这里，做完我就能开工**）

1. **安装**：`irm https://qoder.com/install.ps1 | iex`，然后 `qoder --version`
   （官方**没给**安装目录文档，请把 `Get-Command qoder` 的输出给我 —— 真实路径要写进 `qoderRunnerPath`）。
2. **认证**：**二选一，都不需要装 IDE**：
   - **推荐（零额外步骤）**：本地跑一次 `qoder`，在它的提示符下输入 `/login` 完成登录（浏览器授权或粘贴 token 均可）。
     ⇒ 之后执行器走"复用登录态"，**不需要 PAT**。**你的 IDE 若已登录，效果等价**（同一账号、同一个 `~/.qoder`）。
   - **可选（仅当你想给执行器完全隔离的环境，或要做 CI/多机）**：在 https://qoder.com/account/integrations 生成 **PAT**，
     我用 `QODER_PERSONAL_ACCESS_TOKEN` 注入（**不写进仓库、不落盘**），此时执行器会自动切到隔离目录模式。
   
   > 回答"装 IDE 登录能不能省 PAT"：**能**。省 PAT 的条件是"本地有一次有效登录"，**CLI 登录或 IDE 登录都算**；
   > 而且**只装 CLI 就能登录**（`qoder` → `/login`），省 PAT **不必**先装 IDE。
3. 之后我做**四件只读/极低额度抓包**，把剩余未知项一次性钉死：
   ```powershell
   qoder --version                                    # 版本（写入门禁，防输出格式漂移）
   qoder --list-models                                # 模型清单粒度 → 定通道 id 形态
   qoder -p -o json "Reply with exactly: PONG"        # 单对象结构 + 是否含 usage/session_id
   qoder -p -o stream-json "Reply with exactly: PONG" # NDJSON 事件类型逐条（**parser 的直接依据**）
   ```
4. 拿到样本后：写 `qoder-run.mjs` + 离线 fixture 测试 + 三处契约扩展，
   再由你自己跑一次真派发验收（与 OpenCode 那轮同样的门禁）。

---

## 6b. 【已完成】前置动作的执行结果（2026-10-17）

用户授权后**已由我完成**，§6 的前置动作不再是阻塞项：

| 动作 | 结果 |
|---|---|
| 安装 | ✅ `irm https://qoder.com.cn/install.ps1 \| iex`（**注意 CN 是 com.cn**）→ **Qoder CLI CN v1.1.73** |
| 落点 | `~/.qoder-cn/bin/qoderclicn/qoderclicn.exe`（稳定入口）+ `qoderclicn-1.1.73.exe`（208 MB） |
| 统一入口 | `~/.qoder-cn/entry/qoder-cn.cmd` → 现在也能用（dispatcher 自动找到 CLI） |
| 登录 | ✅ 浏览器设备码流程（`qoderclicn login`，**5 分钟有效期**）→ `Welcome, nick4893614702` |
| 模型清单 | ✅ 15 个：`Auto` / `Fast` / `Qwen3.8-Max` / `Qwen3.8-Flash` / `Qwen3.7-{Max,Plus,Flash}` / `DeepSeek-V4-Pro` / `DeepSeek-Flash` / `GLM-5.3` / `GLM-5.3-Flash` / `GLM-5.2` / `Kimi-K3` / `Kimi-K2.8-Preview` / `MiniMax-M2.7` |
| 抓包 | ✅ `json` 单对象 + `stream-json` 7 行事件谱 + 权限行为（详见 §8） |

> ⚠️ 安装器行为记录（供复现）：脚本会 SHA256 校验、解压后调 `qoderclicn install --force`，
> 安装是**版本化放置 + 稳定入口**（发现层要认 `qoderclicn.exe`，别猜版本号文件名）。

---

## 7. 本轮已完成的验证（顺带）

- **派发台实测**：把 Qoder 调研任务**真的派给了 OpenCode 免费模型**（`j-mvb3toh5-0-86e6`，`tag=QODER-RESEARCH`）：
  `state=done exit=0`、**250s / 9 轮 / 32 次工具调用（含 9 次 webfetch）**、
  `usage {requests:9, input:106693, output:6556, cacheRead:515456}`、`context 120620/200000`、`sessionId=ses_ebabc7561ffe…`。
  ⇒ 派发台不仅能派"写文件"类任务，也能派**带联网调研的多轮工具任务**（本文件 §1 的事实即来自该任务产出，并经我抽查复核）。
- 抓该任务输出时顺带验证了两件事：① `action=tail` 在**仓库内 cwd** 下正常（此前用 `%TEMP%` 沙箱会触发"越界日志路径"的预期拒绝）；
  ② 结果文件（`.result.json`）里的 `response` 是**完整交付文本**，适合做长文调研的交付载体。

---

## 9. 【T4 已实现并真机验收】Qoder 执行器落地（2026-10-17）

**交付**：`collab-kit/qoder-run.mjs`（约 630 行）+ `dispatch/test/qoder-executor.test.mjs`（**104 PASS**）
+ `dispatch/test/qoder-routing.test.mjs`（**7 PASS**）。

### 9.1 真机验收原始结果（`--model Fast`，全新 `%TEMP%` 目录）

```
[qoder-run] cli=C:\Users\Administrator\.qoder-cn\bin\qoderclicn\qoderclicn.exe
[qoder-run] permission-mode-requested=accept_edits reported=acceptEdits     ← 未回落
[qoder-run] credits total=0.37786532079999996 contextRatio=0.096725 durationMs=1477 turns=1
[qoder-run] done exit=0 elapsed=4.5s session=69ecdb5c-f32c-49ee-9886-83a865725734 model=Fast responseChars=4
```
- 回答正文 `PONG` ✓，`tools count=31` ✓，result.json 落盘 ✓，全程 7 秒。

### 9.2 🔴 两处**修正 §8 推测**的新真机事实

1. **`accept_edits` 不要求目录预先受信任**。§8.4 曾推测"目录不受信任 ⇒ 回落 default"；
   本次在**全新 `%TEMP%` 目录**（`--add-dir` 声明）下 `permissionMode` **如实回传 `acceptEdits`**。
   ⇒ 回落**可能**发生在别的条件（如策略/hook/未 add-dir），但**不能**再简单说"新目录必回落"。
   执行器的回落检测依然保留（它是**事实核对**，不是猜测）：实际不一致就报警，一致就放行。
   ⚠️ 仍成立的是：**落到 `default` 时写操作会被静默拒绝**（§8.4 实测），故默认值仍是 `accept_edits`。
2. **`assistant` 事件有两种形状**：既有顶层 `content:[…]`（§8.3 样本），也有
   **`message.content:[…]`（Anthropic 式嵌套）**，且嵌套版还带 `message.usage.credits` 与
   `context_usage_ratio`。聚合器**两种都认**（先看顶层 `content`，没有再取 `message.content`）。

### 9.3 实现中踩到并修掉的两个真机/真代码坑

1. **`.cjs` 不能直接 spawn**：Windows 下 `spawn('…\\fake.cjs', …)` → **`EFTYPE`**。
   与发现层处理 ZCode 自带 CLI（`zcode.cjs`）是同一类问题 ⇒ 抽出**唯一权威** `spawnTarget()`
   （`.cjs/.mjs/.js` 前置 `node`；`.cmd/.bat` 经 shell），探测与执行**共用**，避免一处修一处漏。
2. **`setTimeout(...).unref()` 会吞掉退出码**：入口写的是
   `setTimeout(() => process.exit(code), 300).unref()` —— `.unref()` 让定时器**不保持事件循环存活**，
   进程在 300ms 前自然退出 ⇒ `process.exit(code)` 永不执行 ⇒ **报错路径 exit 0**（core 会当成功）。
   改为同步 `process.exit(code)`。**这个坑只在"报错路径"暴露**（正常路径恰好也 exit 0），
   所以是测试里那条"失败退出"断言抓出来的。

### 9.4 真机验收顺带抓到的**路由 bug**（已修 + 已锁）

派发台里 `provider:'qoder/Fast'` 被解析成 **`engine=zcode`** —— `resolveEngineOf()` 只写了
`isOpenCodeId()` 判据、**漏了 `isQoderId()`**，于是 Qoder 通道**静默落到 ZCode 执行器**、
模型还被改写成另一引擎的默认值。**这类"静默跑错引擎"比报错危险得多**，已修并加
`qoder-routing.test.mjs` 钉死（含"执行器调用的是 qoder-run.mjs 而非 zcode-run"的子进程级断言）。

---

## 8. 【已实测】Qoder CN 真机抓包结果（2026-10-17，**替代一切文档推测**）

环境：**Qoder CLI CN v1.1.73**（`qoderclicn`），`~/.qoder-cn/bin/qoderclicn/qoderclicn.exe`；
已登录（设备码流程）。以下全部是**真机原始输出**，parser 以此为唯一依据。

### 8.1 CLI 落点与登录（修正 §1.4 / §3.2b 的两处猜测）
```
可执行      ~/.qoder-cn/bin/qoderclicn/qoderclicn.exe        ← 稳定入口（另有带版本号的同名文件）
统一入口    ~/.qoder-cn/entry/qoder-cn.cmd                    ← dispatcher 转发，现在也能用
登录态判据  **`--list-models` 是否成功**（未登录 ⇒ "Not logged in. Run `qoderclicn login`" + exit=1）
```
🔴 **修正 1**：**IDE 的登录态 CLI 用不了**。本机 IDE 明明登录着，CLI 仍报 `Not logged in`；
`~/.qoder-cn/.auth/` 里只有 `machine_id` 与 `.credential-transaction`（**都不是凭据**）。
⇒ 发现层**不能**用"`.auth/` 目录存在"判登录，必须用"CLI 真能跑通"判（也完全合规，不碰凭据内容）。
🔴 **修正 2**：`qoderclicn login` 是**浏览器设备码流程**（打印 URL + **5 分钟有效期**），没有 `--token` 旗标；
CI 场景仍需 PAT（或预置登录态）。

### 8.2 `-p -o json` 的单对象结构（真实原文）
```json
{"type":"result","subtype":"success","duration_ms":1777,"duration_api_ms":1569,
 "is_error":false,"num_turns":1,"result":"PONG","stop_reason":"end_turn",
 "total_cost_usd":0,"total_credits":0.4348942840000001,
 "usage":{"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,
   "output_tokens":0,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},
   "service_tier":"standard","cache_creation":{...},"inference_geo":"","iterations":[],
   "speed":"standard","request_id":"…","context_usage_ratio":0.097595},
 "modelUsage":{"auto":{"inputTokens":0,...,"credits":0.4348942840000001,"contextWindow":0,"maxOutputTokens":0}},
 "permission_denials":[],"fast_mode_state":"off","uuid":"…","session_id":"2d56a395-…"}
```
⚠️ **token 全是 0**（本机这次）：`input_tokens/output_tokens/cache_*` 与 `modelUsage.*Tokens` 都是 0，
`contextWindow` 也是 0。**可用的真实计量是**：`total_credits`（本次消耗）、
`usage.context_usage_ratio`（0.0976 = 上下文占用比例，可由它反推窗口）、`duration_ms`、`num_turns`。
⇒ **usage 行不能依赖 token 字段**，必须优先用 `total_credits` + `context_usage_ratio`。

### 8.3 `-p -o stream-json` 的真实事件谱（7 行 NDJSON，探查性任务）
| # | `type` | `subtype` | 关键字段 |
|---|---|---|---|
| 1 | `system` | `hook_started` | `hook_id`、`hook_name:"Initializing Qoder Security"`、`hook_event:"SessionStart"` |
| 2 | `system` | **`init`** | `qodercli_version:"1.1.73"`、**`protocol_version:"1.5.0"`**、`cwd`、`model:"Auto"`、**`permissionMode`**、`tools[]`、`agents[]`、`skills[]`、`plugins[]`、`capabilities[]`、`apiKeySource`、`slash_commands[]`、`output_style`、`mcp_servers[]` |
| 3 | `system` | `artifacts_update` | `artifacts:[]` |
| 4 | `system` | `hook_response` | `exit_code`、`duration_ms`、`outcome:"success"`、`output/stdout/stderr` |
| 5 | `assistant` | — | `message.content:[{type:"thinking",thinking:"…",signature:""}]` ← **思维链独立成事件** |
| 6 | `assistant` | — | `message.content:[{type:"text",text:"PONG",citations:null}]` + `message.usage.credits/original_credits/billable` + `context_usage_ratio` |
| 7 | **`result`** | `success` | **与 `-o json` 的整个对象逐字相同** |

- **每行都带 `uuid` + `session_id`**（会话 id 从第 1 行起就可得）。
- 与 SDK 文档的差异：**`permissionMode` 是驼峰**（文档写 `permission_mode`）；`type` 用 `system/assistant/result`，
  **没有**用 `stream_event`（那是需要 includePartialMessages 才有的形态）。
- 未登记类型必须**降级透传**（`artifacts_update`、`hook_*` 就是"文档没写但会真实出现"的例子）。

### 8.4 权限行为（**W2/W3 两面墙都实测确认**）
| 场景 | `init.permissionMode` | 写文件 | `permission_denials` | `result.is_error` | 结论 |
|---|---|---|---|---|---|
| `--permission-mode accept_edits --add-dir <cwd>` | **`acceptEdits`** | ✅ **成功**（`wtest.txt` 内容一字不差，2 轮） | `[]` | `false` | **默认映射可用**（§3.2 方案 A 成立） |
| 不加任何权限旗标 | `default` | ❌ **失败**（文件不存在） | **`[]`**（空！） | **`false`**（报成功） | 🔴 **W2 墙坐实：完全静默** —— 只有 `result` 文本里一句 "It looks like the write was denied. Would you like to allow it so I can create the file?" 可作线索 |

🔴 **修正 3（判据值）**：CLI 参数是 `accept_edits`（下划线），但 **`init.permissionMode` 回传的是 `acceptEdits`（驼峰）**。
⇒ 回落检测必须用**驼峰值**比对，否则会**永远误报"回落了"**。等价关系：
`accept_edits → acceptEdits`、`bypass_permissions → bypassPermissions`、`dont_ask → dontAsk`（推断，实施时逐个实测）。

### 8.5 由此更新 §3.2c 的默认参数（三处修正）
1. **回落判据**改为：`init.permissionMode` **不等于**传入模式的驼峰形态 ⇒ 判定回落 + 报警（并把原值写进 `[qoder-run]` 行）。
2. **`--list-models` 作为登录态与可用性的权威探测**（未登录时为 exit=1 + 明确文案）。
3. **usage 行以 `total_credits` + `context_usage_ratio` 为主**（token 字段可能全 0，不能当唯一来源）。

- **派发台实测**：把本调研任务**真的派给了 OpenCode 免费模型**（`j-mvb3toh5-0-86e6`，`tag=QODER-RESEARCH`）：
  `state=done exit=0`、**250s / 9 轮 / 32 次工具调用（含 9 次 webfetch）**、
  `usage {requests:9, input:106693, output:6556, cacheRead:515456}`、`context 120620/200000`、`sessionId=ses_ebabc7561ffe…`。
  ⇒ 派发台不仅能派"写文件"类任务，也能派**带联网调研的多轮工具任务**（本文件 §1 的事实即来自该任务产出，并经我抽查复核）。
- 抓该任务输出时顺带验证了两件事：① `action=tail` 在**仓库内 cwd** 下正常（此前用 `%TEMP%` 沙箱会触发"越界日志路径"的预期拒绝）；
  ② 结果文件（`.result.json`）里的 `response` 是**完整交付文本**，适合做长文调研的交付载体。
