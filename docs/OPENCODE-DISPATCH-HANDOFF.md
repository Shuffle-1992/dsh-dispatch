# OPENCODE-DISPATCH-HANDOFF —— 「OpenCode 派发台」交给专项 Agent 开发

> 生成：2026-10-16 18:5x ｜ 作者：标准模式 DSH 会话
> 读者：**专项开发 Agent**。你手上会有完整的开发环境；本机 OpenCode 已装好并验收通过，你可以直接复用。
> **一句话任务**：在 DSH 里做一个「OpenCode 派发台」——把任务派给**本地真实的 OpenCode 进程**，用它跑 **12 个免费模型**，把结果、进度和 token 用量带回 DSH。范式对标同目录下的 `dsh-dispatch`，只是把执行器从 ZCode 换成 OpenCode。
>
> **本方案的全部价值在于：请求真的来自 OpenCode 本体，所以不需要任何伪装。**

---

## 一、背景：为什么必须这么做

### 问题

OpenCode Zen 有一批**免费模型**（`deepseek-v4.1-flash-free`、`glm-5.3-flash-free` 等），但它们**无法从 DSH 直接调用**。用现有 Go Key 直连的结果是服务端明确拒绝：

```json
{"type":"error","error":{"type":"FreeTierError",
 "message":"OpenCode's free tier can only be used from within OpenCode."}}
```

这是 OpenCode **主动做的客户端门禁**，不是 Key 问题、也不是插件没实现。

### 生态现状（两条错误路线，别走）

| 路线 | 代表插件 | 做法 | 为什么不采用 |
|---|---|---|---|
| 伪装客户端 | `dsh-opencode-free`、`@jiesou/dsh-opencode-zen-free-provider`、`dsh-opencode-free-tier` | 伪造 OpenCode CLI 的 User-Agent、伪造时间戳格式 session id、往请求里塞假的 `bash`/`read` 工具定义骗过门禁 | **主动规避厂商访问控制**。且脆弱：上游 2026-10-11 刚迁移端点（`/zen/v1` → `/inference/v1`）并收紧门禁，这些插件被迫逆向重写 |
| 隔离运行时桥接 | `dsh-opencode-xdbridge`、`ow-bridge` | 下载官方 OpenCode 二进制，跑隔离的 `opencode serve`，本地转成 OpenAI 兼容端点 | **方向正确**，但 `dsh-opencode-xdbridge@0.1.0` 的 `engines.dsh` 是 `>=0.1.1-rc.1 <0.2.0`，与本机 **DSH 0.2.0-rc.2 不兼容**；且只有 1 个版本、2026-09-29 发布，早于 10-11 端点迁移，实际已失效 |

### 本方案

**不伪装身份，改为派发任务**：DSH 把任务交给本地真实 OpenCode 进程，由它去调免费模型。请求天然带有 OpenCode 的合法身份，门禁正常放行。

这与「ZCode 派发台」是**同一个范式**（派发 + 监视 + 回传），只是执行器不同。差别在于：OpenCode 这条路的底座**比 ZCode 更整齐**（天然有 JSON 事件流、会话 ID、token 用量、HTTP 服务）。

---

## 二、已验证的事实（**别重复验证**，均于 2026-10-16 本机实测）

### 环境

| 项 | 值 |
|---|---|
| Node | v24.14.1（`C:\Program Files\nodejs\node.exe`） |
| npm | 11.11.0，prefix `C:\Users\Administrator\AppData\Roaming\npm`（**已在 PATH**） |
| DSH | 0.2.0-rc.2，profile `desktop` |
| DSH_HOME | `C:\Users\Administrator\.dsh` |
| 安装日期 | 2026-10-16 |

### OpenCode 安装与运行

| 验证项 | 命令 | 结果 |
|---|---|---|
| 已安装 | `opencode --version` | ✅ **1.19.2** |
| 可执行入口 | — | `C:\Users\Administrator\AppData\Roaming\npm\opencode.cmd`（另有 `.ps1` / 无扩展名 shim） |
| 真实二进制 | — | `%APPDATA%\npm\node_modules\opencode-ai\node_modules\opencode-windows-x64\bin\opencode.exe`（约 173 MB） |
| 本地服务 | `opencode serve --port 4599 --hostname 127.0.0.1` | ✅ `/global/health` → `{"healthy":true,"version":"1.19.2"}` |
| OpenAPI | `http://127.0.0.1:4599/doc` | ✅ HTTP 200，479,038 bytes |
| **是否需要登录** | `opencode auth list` | ✅ **不需要** —— 0 credentials，免费模型照常可用 |
| 数据目录 | — | `~\.local\share\opencode\`（`opencode.db`、`log\`、`repos\`） |
| 配置目录 | — | `~\.config\opencode\opencode.jsonc` |

### 免费模型（**无需账号**）

`opencode models` 输出（12 个）：

```
opencode/big-pickle
opencode/cat-jam-free
opencode/deepseek-v4.1-flash-free          ← 用户明确要的
opencode/glm-5.3-flash-free                ← 用户明确要的
opencode/ll-alpha-free
opencode/longcat-2.5-preview-free
opencode/mimo-v2.6-flash-free
opencode/muse-spark-1.3-contributor-free
opencode/nemotron-3-ultra-free
opencode/nemotron-3.5-lightning-free
opencode/nemotron-3.5-super-vl-free
opencode/space-bunny-free
```

### 实弹验证（两个目标模型）

| 模型 | 命令 | 结果 |
|---|---|---|
| `deepseek-v4.1-flash-free` | `opencode run "Reply with exactly the word PONG and nothing else." --model opencode/deepseek-v4.1-flash-free` | ✅ 返回 `PONG`，**6 秒** |
| `glm-5.3-flash-free` | 同上换模型 | ✅ 返回 `PONG`，**28 秒** |
| **Agent 真实干活** | `opencode run "Create a file named hello.txt ... containing exactly: hi from opencode" --model opencode/deepseek-v4.1-flash-free --format json --auto` | ✅ **8 秒**创建成功，内容一字不差 |

> ⚠️ 结论：OpenCode 不只是能聊天，**它是一个能读改文件、跑命令的完整 agent**。这正是「派发」有意义的前提。

---

## 三、执行器接口规格

### 3.1 `opencode run` 相关参数（`opencode run --help` 实测）

```
opencode run [message..]

  -m, --model       model to use in the format of provider/model      ← 选免费模型
      --agent       agent to use                                     ← 默认 build
      --format      default (formatted) | json (raw JSON events)     ← 桥接必用 json
  -c, --continue    continue the last session                        ← 续会话
  -s, --session     session id to continue                           ← 指定会话续跑
      --fork        fork the session before continuing
      --attach      attach to a running opencode server (e.g. http://localhost:4096)
  -p, --password    basic auth password (defaults to OPENCODE_SERVER_PASSWORD)
  -u, --username    basic auth username (defaults to OPENCODE_SERVER_USERNAME or 'opencode')
      --dir         directory to run in, path on remote server if attaching  ← 工作目录
      --port        port for the local server (defaults to random port)
      --variant     model variant (provider-specific reasoning effort, e.g. high, max, minimal)
      --thinking    show thinking blocks
  -f, --file        file(s) to attach to message
      --title       title for the session
      --command     the command to run, use message for args
  -i, --interactive run in direct interactive split-footer mode
      --auto        auto-approve permissions that are not explicitly denied (dangerous!)
      --print-logs / --log-level / --pure
```

**要点**：
- `--format json` 是**每行一个 JSON 对象**（NDJSON），可直接流式解析
- `--dir` 决定 OpenCode 在哪个目录干活（派发目标仓库时必传）
- `--variant` 是思考档位（OpenCode 叫 variant，对应 DSH 的 thinking level）
- **`--auto` 会放行所有未显式拒绝的权限**（危险）。派发台**默认不要用**，应走权限审批回传机制，或仅在受控沙箱目录下使用

### 3.2 `--format json` 完整事件谱（实测）

一次「创建文件」任务的完整输出（6 个事件）：

```
type=step_start   part.type=step-start
type=tool_use     part.type=tool     tool=write   state.status=completed
type=step_finish  part.type=step-finish  reason=tool-calls
                  tokens={"total":8113,"input":7343,"output":73,"reasoning":57,"cache":{"write":0,"read":640}}
type=step_start   part.type=step-start
type=text         part.type=text     text="Created demo.txt."
type=step_finish  part.type=step-finish  reason=stop
                  tokens={"total":8134,"input":6337,"output":5,"reasoning":0,"cache":{"write":0,"read":1792}}
```

**原始样例（`step_start`）**：

```json
{"type":"step_start","timestamp":1792148041798,"sessionID":"ses_ebba727a0ffe4EMjLuZtwe3fnE","part":{"id":"prt_14458f03f001GNOKxchkWjA706","messageID":"msg_14458dc98001TCFeUB5FclM8u8","sessionID":"ses_ebba727a0ffe4EMjLuZtwe3fnE","type":"step-start"}}
```

**原始样例（`tool_use`，注意 `state.input` / `state.output` / `state.status`）**：

```json
{"type":"tool_use","timestamp":1792148042562,"sessionID":"ses_ebba727a0ffe4EMjLuZtwe3fnE","part":{"type":"tool","tool":"write","callID":"call_00_d1v6lymkv9nptt3lnlwdmjav","state":{"status":"completed","input":{"filePath":"...\\demo.txt","content":"hello"},"output":"Wrote file successfully.","metadata":{"diagnostics":{},"filepath":"...\\demo.txt","exists":false,"truncated":false},"title":"...demo.txt","time":{"start":1792148042510,"end":1792148042538}},"id":"prt_14458f2cf001lbFp95z5BEQpK9","sessionID":"ses_ebba727a0ffe4EMjLuZtwe3fnE","messageID":"msg_14458dc98001TCFeUB5FclM8u8"}}
```

**原始样例（`text`）**：

```json
{"type":"text","timestamp":1792147900707,"sessionID":"ses_ebba94ca9ffenMwnHVNcOrctmo","part":{"id":"prt_14456c906001OcJ0aVS0UO5sQf","messageID":"msg_14456b780001l3u6zaATWOKAZ7","sessionID":"ses_ebba94ca9ffenMwnHVNcOrctmo","type":"text","text":"PONG","time":{"start":1792147900678,"end":1792147900682}}}
```

**已观测到的 `type` 取值**：`step_start` / `text` / `tool_use` / `step_finish`

> ⚠️ **解析必须做成"未知类型不崩"**：上游随时可能加新事件类型（如 `reasoning`、`error`、`step_retry`）。已观测的 4 种之外一律降级为原始透传，绝不抛异常终止整轮。

**`step_finish.part.reason` 已观测取值**：`tool-calls`（本轮要调工具）、`stop`（正常结束）

**token 用量结构**（可直接喂给 `dsh-cost-meter`）：

```json
{"total":8134,"input":6337,"output":5,"reasoning":0,"cache":{"write":0,"read":1792}}
```

### 3.3 会话续跑

- 每个事件都带 `sessionID`（形如 `ses_ebba727a0ffe4EMjLuZtwe3fnE`）
- 续跑：`opencode run "..." -s <sessionID> --format json`
- 续最后一次：`-c`
- 分叉：`--fork`（需配合 `-c` 或 `-s`）

→ **DSH 侧每个派发任务应持久化 `sessionID`**，支持「继续上一轮」。

**✅ 已实测：不需要任何常驻进程，跨独立进程即可续跑**（2026-10-16 验证）

```
测试前：Get-Process opencode → ✅ 完全没有常驻进程

第 1 次调用（独立进程 A）：
  opencode run "Remember the number 42. Reply with exactly OK." -m opencode/deepseek-v4.1-flash-free --format json
  → 回复 OK，sessionID = ses_ebba2dd9cffeSi4Cbq69g3FJJU

第 2 次调用（独立进程 B，进程 A 早已退出）：
  opencode run "What number did I ask you to remember? Reply with just the number." -s ses_ebba2dd9cffeSi4Cbq69g3FJJU -m opencode/deepseek-v4.1-flash-free --format json
  → 回复 42，sessionID 相同
```

**原因**：会话持久化在 `~\.local\share\opencode\opencode.db`（SQLite），**不是内存态**。而 `opencode run` 每次会自行起一个**随机端口的临时服务**（见 `--port` 说明："defaults to random port if no value provided"），干完即退。

> **架构结论**：路线 A 与「ZCode 派发台」同构 —— **按需 spawn、用完即走、无需守护进程、无需端口管理**。只有路线 B（`opencode serve` + `--attach`）才需要常驻服务，那是 P2 的额外成本，不是必需品。
>
> ⚠️ 但这意味着**每次 spawn 都有冷启动开销**（进程启动 + 临时服务 + 目录读取）。派发台应把「一次派发」设计成尽量少 spawn：一个任务一次调用，靠 `-s` 串联多轮，而不是每轮都新开一个无会话的进程。

### 3.4 本地服务（路线 B 用）

`opencode serve [--port 4096] [--hostname 127.0.0.1] [--cors <origin>]`

- 默认 `127.0.0.1:4096`
- 保护：`OPENCODE_SERVER_PASSWORD`（用户名默认 `opencode`，可 `OPENCODE_SERVER_USERNAME` 覆盖）
- OpenAPI 规格：`http://<host>:<port>/doc`
- 官方 SDK：`@opencode-ai/sdk@1.19.2`（同时有 v1 / v2 两套 API）
- 事件流：`GET /global/event`（SSE）
- 关键端点（来自官方文档）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/global/health` | 健康与版本 ✅ 已实测 |
| GET | `/global/event` | 全局事件流（SSE） |
| POST | `/session` | 建会话，body `{parentID?, title?}` |
| GET | `/session/:id/message` | 列会话消息 |
| POST | `/session/:id/message` | **发消息并等待响应**，body `{messageID?, model?, agent?, noReply?, system?, tools?, parts}` |
| POST | `/session/:id/prompt_async` | 异步发消息（不等待），返回 204 |
| GET | `/event` | 事件流（ow-bridge 用的是这个做进度观测） |

> ⚠️ **重要限制**：`/session/:id/message` 的 `tools` 类型是 `{ [key: string]: boolean }` —— **只能开关 OpenCode 自己的工具，不能注入 DSH 的工具定义**。所以「把 DSH 当模型提供者用」这条路（xdbridge 走的）必须额外做**权限审批拦截 + 动作转交**，复杂度高得多。本项目的「派发」范式天然绕开了这个限制。

---

## 四、建议架构

### 路线 A：CLI 派发（**建议先做这个**）

```
DSH 派发台
   │  spawn: opencode run "<task>" -m <free-model> --format json --dir <repo>
   ▼
子进程 stdout（NDJSON 逐行）
   │  逐行 parse → 事件 → 面板/进度/日志
   ▼
结果聚合：text 拼接 + tool_use 列表 + token 用量 + sessionID
   ▼
回传 DSH（工具返回值 / 面板 / 通知）
```

- **优点**：实现简单、无端口管理、进程天然隔离、失败易清理、`--format json` 直接可用
- **缺点**：一次性任务，无跨轮实时流（进度只能随事件到达更新，不能中途插话）
- **适合**：本项目的 P0/P1 目标

### 路线 B：常驻服务 + SSE（**P2 再上**）

```
DSH 派发台 ──启动/复用──> opencode serve --port 4096（带 OPENCODE_SERVER_PASSWORD）
   │  POST /session  建会话
   │  POST /session/:id/prompt_async   异步发任务
   │  GET  /event    订阅 SSE → 实时进度
   ▼
完成/取消：POST /session/:id/... 或结束
```

- **优点**：多任务并发、实时流、会话复用、可中途取消
- **缺点**：要管生命周期、端口、密码、僵尸进程；`prompt_async` 后无法直接拿到返回体，得靠事件流拼

**建议**：**先 A 后 B**。A 验证价值后再决定是否值得做 B。若做 B，可让 A 作为 B 不可用时的兜底执行器（与 `dsh-dispatch` 的降级链思路一致）。

### 会话与上下文映射

- DSH 的「派发任务」↔ OpenCode 的 `sessionID`，一一对应并持久化（建议 `<插件目录>/.data/sessions.json`）
- 派发**不是**把 DSH 对话历史喂给 OpenCode。OpenCode 只有你给它的那条 task 文本 + 它自己的仓库上下文。**这一点要在 UI 上说清楚**，否则用户会以为两边共享上下文
- 若要传递额外上下文，用 `-f/--file` 附文件，或把上下文写进 task 文本

---

## 五、DSH 插件骨架（照 `dsh-dispatch` 的既有规范）

### package.json 关键字段

参考 `dispatch/package.json`：

```json
{
  "name": "dsh-opencode-dispatch",
  "version": "0.1.0",
  "type": "module",
  "engines": { "node": ">=22.12.0" },
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./package.json": "./package.json",
    "./locale/*.json": "./locale/*.json",
    "./typert": "./wire.host.mjs",
    "./remote": "./wire.client.mjs"
  },
  "dsh": {
    "manifestVersion": 1,
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "immediately": true,
                "inject": ["@deepseek-ai/dsh-client-ui-conversation"] }
  },
  "meta": { "title": "OpenCode 派发台", "description": "..." },
  "icon": "./icon.svg"
}
```

### cordis.patch.yml

```yaml
- insert:
    - id: opencode-dispatch
      name: 'dsh-opencode-dispatch'
      config:
        demo: false
        maxConcurrent: 2
```

> ⚠️ **机器专有路径不要写进 patch 文件**（runner / 数据目录等指向宿主的路径属于部署配置）。请在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 里按 id 覆盖。见 `dispatch/cordis.patch.yml` 顶部注释的既有约定。

### 注册到 profile

在 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 数组里追加 `"dsh-opencode-dispatch"`。

### 开发期安装（junction，无需反复卸载重装）

```powershell
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-opencode-dispatch" `
  -Target "<本仓库路径>\opencode-dispatch"
```

### ⚠️ 改动生效语义（**务必记住，否则会白改半天**）

- **客户端半边**（`client.js`）改完 → **刷新页面**即可
- **宿主半边**（`index.js` / `wire.host.mjs` / `core/*`）改完 → **必须完全退出 DSH 再启动**（cordis `_reload()` 复用进程内已 import 的模块，切插件开关不会重新读盘）

### 必须避开的两个已知启动事故（来自 `pitfalls.md`）

1. **插件 config 只认 Standard Schema**：cordis 读 `runtime.Config['~standard'].validate(config)`。裸 JSON Schema 会抛 `Cannot read properties of undefined (reading 'validate')` 导致插件不激活。优先用 `@deepseek-ai/schemastery`，解析不到再手写 Standard Schema 降级。
2. **客户端 `inject` 不能声明自家尚未就绪的 `remote.<ns>`**：否则 `pending (waiting for service: remote.opencodeDispatch)` → **web boot 直接失败**。用 `inject: ['slots','remote']` + 运行时探测。

> 动手前**必读** `F:\My Code\dsh-dispatch\pitfalls.md`。

---

## 六、待实现清单（按优先级）

### P0 —— 能派发、能回传（最小价值闭环）

- [ ] `index.js`：Config（Standard Schema）+ apply，注册 agent 工具 **`opencode_dispatch`**
- [ ] `core/runner.mjs`：spawn `opencode run --format json`，逐行 parse NDJSON
- [ ] 参数：`task`（必填）、`model`（默认 `opencode/deepseek-v4.1-flash-free`）、`dir`、`variant`、`sessionId`
- [ ] 聚合返回值：`{ text, tools: [...], tokens, sessionID, durationMs, exitCode }`
- [ ] 未知事件类型不崩（降级透传）
- [ ] 超时与取消（kill 子进程树）
- [ ] 启动自检：`opencode --version` 探针，缺失时给出可读错误

### P1 —— 派发台体验

- [ ] `sessionID` 持久化 → 支持 `-s` 续跑 / `-c` 续最后一次
- [ ] 进度回传（工具调用逐条出现在 DSH 侧）
- [ ] 并发上限 + 单写者约束（同一 `dir` 同时只允许一个 OpenCode 任务，避免两个 agent 同时改同一仓库）
- [ ] 面板（可选，`shell.overlay` 槽位）：任务列表 / 状态 / 耗时 / 用量
- [ ] 通知：任务落地（成功/失败/超时）唤醒发起会话

### P2 —— 与既有设施打通

- [ ] token 用量喂给 `dsh-cost-meter`（其 ledger 已存在 `~\.dsh\storages\cost-meter\ledger.json`）
- [ ] 批量派发 / 降级链（OpenCode 不可用时回退到别的执行器，对齐 `dsh-dispatch` 的 fallback 设计）
- [ ] 路线 B：常驻 `opencode serve` + SSE 实时流

---

## 七、硬约束与禁止事项

### 绝对不要做

1. **不要伪装身份**。不要伪造 User-Agent、不要伪造 `ses_*` 时间戳格式 session id、不要塞假的 `bash`/`read` 工具定义。**那是 `dsh-opencode-free` 那一类插件的做法，本项目的全部意义就是不做这个。** 一旦伪装，就变成规避厂商访问控制，风险与脆弱性同步上身。
2. **不要读写用户自己的 OpenCode 配置与数据**：`~\.config\opencode\`、`~\.local\share\opencode\`（`opencode.db`）。若需要隔离环境，用**独立 XDG 根目录**（参考 `dsh-opencode-xdbridge` 的 `dataDir` 设计）。
3. **不要默认开 `--auto`**。它会放行所有未显式拒绝的权限。派发台应在受控目录内运行，或把审批请求回传 DSH 决策。
4. **不要在免费模型上并发轰炸**。免费层**按 IP 限流**，滥用会导致全体失败。
5. **不要假设事件类型固定**。见 §3.2。

### 必须知道的上游边界

| 限制 | 值/说明 |
|---|---|
| 免费模型上下文 | 200K（`deepseek-v4.1-flash-free` / `glm-5.3-flash-free` 均为 200K 上下文 / 32K 输出） |
| 限流 | 按 IP |
| 部分模型标注 | 「限时免费」「限区域」（如 cat-jam-free / muse-spark） |
| 门禁稳定性 | ⚠️ **上游 2026-10-11 刚迁移过端点（`/zen/v1` → `/inference/v1`）并收紧门禁**。随时可能再变 |
| 依赖性质 | 依赖 **OpenCode 客户端接口**，不是官方开放 API。OpenCode 升级后可能需要跟着调整 |

---

## 八、验收标准（可复跑，缺一不可）

```powershell
# 0) 前置：OpenCode 可用
opencode --version                      # 期望 1.19.2
opencode models | Select-String 'free'  # 期望列出 12 个免费模型

# 1) 执行器直连验证（不经 DSH）
opencode run "Reply with exactly: PONG" -m opencode/deepseek-v4.1-flash-free --format json
# 期望：NDJSON 中至少含 step_start / text / step_finish，text 内容为 PONG

# 2) Agent 干活验证（在临时目录）
mkdir $env:TEMP\oc-verify; cd $env:TEMP\oc-verify
opencode run "Create a file named hello.txt containing exactly: hi from opencode" `
  -m opencode/deepseek-v4.1-flash-free --format json --auto
Get-Content .\hello.txt                 # 期望：hi from opencode

# 3) DSH 侧验收（插件）
#    - 工具 opencode_dispatch 可被模型调用并返回结构化结果
#    - 返回体含：text / tools / tokens / sessionID / durationMs
#    - 制造一个失败（不存在的模型 id）→ 返回可读错误，**不崩 DSH**
#    - 同一 dir 并发两次 → 第二次被单写者约束挡住（P1 起要求）
#    - 客户端半边改完刷新页面可见；宿主半边改完需完全重启才生效（验证这条语义）
```

**通过判据**：以上每步都有可复跑的原始输出留档（建议存 `tasks/`，与既有 `Z1..Z10-*-passed.md` 的审计链风格一致）。

---

## 九、风险与失效预案

| 风险 | 表现 | 预案 |
|---|---|---|
| 上游改门禁 | 原本可用的免费模型突然 403 / 报 `FreeTierError` | 插件应把上游**原始错误**透传给用户（不要笼统报"API Key 无效"）。此时唯一正解是升级 OpenCode 版本再看，**不要退回伪装路线** |
| IP 限流 | 间歇性失败、429 | 并发上限调低、失败重试带退避；区分「确定性拒绝」与「暂时不可达」（前者下架模型，后者保留并标"不稳定"） |
| OpenCode 版本升级 | CLI 参数或事件谱变化 | `--format json` 解析做成向后兼容；版本探针 + 不兼容时明确报错 |
| OpenCode 目录被用户改动 | 免费模型消失 | 只读探测，缺失时降级为空目录并正常挂载（不要因此让 DSH 启动失败） |
| 子进程僵尸 | 派发结束后 `opencode.exe` 残留 | 结束/取消时确保杀进程树；启动时清理上次残留 |

---

## 十、参考资产

### 本目录（范式来源，**建议大量参考**）

| 路径 | 用途 |
|---|---|
| `dispatch/core/dispatch-core.mjs`（102 KB） | 派发核心：多进程 / 双锁 / 暂停分类 / 交接重跑 / 降级链 |
| `dispatch/bin/dispatch.mjs` | CLI：`channels/quota/dispatch/kill/tail` |
| `dispatch/wire.host.mjs` + `wire.client.mjs` | typert Remote 宿主/客户端传输层 |
| `dispatch/client.js`（204 KB） | 客户端入口 + 悬浮面板（约 1450 行） |
| `dispatch/test/*.mjs`（40 个） | 测试范式（锁、降级、面板、通知、超时…） |
| `pitfalls.md` | **开工必读**，含两次启动事故 |
| `CREATOR-HANDOFF.md` | 交接文档写法参考 |
| `refs/dsh-slots.md`、`refs/dsh-theme-tokens.md` | 槽位与主题令牌 |
| `refs/SKILL.md` + `references/` | 官方技能 |
| `refs/dsh-typert/`、`refs/dsh-plugin-manager/` | 官方 typert / 插件管理页实现（asar 提取） |
| `tools/verify-plugin.mjs` | 常驻探针（20 项） |

### 外部

| 资源 | 地址 |
|---|---|
| OpenCode 文档 | https://opencode.ai/docs |
| CLI 命令 | https://opencode.ai/docs/cli |
| Server / HTTP API | https://opencode.ai/docs/server |
| SDK | https://opencode.ai/docs/sdk |
| Windows 说明 | https://opencode.ai/docs/windows-wsl |
| Go 订阅（付费，非本项目目标，但同网关） | https://opencode.ai/docs/go |
| 模型目录（含 126 个 Zen 模型与免费标记） | https://models.dev/api.json |
| 隔离运行时桥接参考实现（不同范式） | https://github.com/XDTrees/dsh-opencode-xdbridge |
| 同上（WorkBuddy 版，196★，有 Windows 实机验证） | https://github.com/louchi1984-coder/ow-bridge |

---

## 附一：本机实测原始输出留档

### `opencode --version`
```
1.19.2
```

### `opencode auth list`（证明无需登录）
```
Credentials ~\.local\share\opencode\auth.json
—  0 credentials
```

### `opencode models`（12 个免费模型）
```
opencode/big-pickle
opencode/cat-jam-free
opencode/deepseek-v4.1-flash-free
opencode/glm-5.3-flash-free
opencode/ll-alpha-free
opencode/longcat-2.5-preview-free
opencode/mimo-v2.6-flash-free
opencode/muse-spark-1.3-contributor-free
opencode/nemotron-3-ultra-free
opencode/nemotron-3.5-lightning-free
opencode/nemotron-3.5-super-vl-free
opencode/space-bunny-free
```

### `opencode serve` 健康检查
```
GET http://127.0.0.1:4599/global/health
{"healthy":true,"version":"1.19.2"}

GET http://127.0.0.1:4599/doc
HTTP 200, 479038 bytes
```

### 完整事件谱（创建文件的 6 个事件）
```
type=step_start   part.type=step-start
type=tool_use     part.type=tool     tool=write  state.status=completed
type=step_finish  part.type=step-finish  reason=tool-calls
                  tokens={"total":8113,"input":7343,"output":73,"reasoning":57,"cache":{"write":0,"read":640}}
type=step_start   part.type=step-start
type=text         part.type=text  text="Created demo.txt."
type=step_finish  part.type=step-finish  reason=stop
                  tokens={"total":8134,"input":6337,"output":5,"reasoning":0,"cache":{"write":0,"read":1792}}
```

---

## 附二：环境复现（若换机器）

```powershell
# 1) 安装 OpenCode（Windows 原生，推荐；WSL 为官方推荐但本机只有 docker-desktop 发行版，需先装 Ubuntu）
npm install -g opencode-ai

# 2) 验证
opencode --version
opencode models

# 3) 若要在脚本里跑，用 .cmd 或 .ps1 shim
& "$env:APPDATA\npm\opencode.cmd" run "hi" -m opencode/deepseek-v4.1-flash-free --format json
```

**为什么不选其它装法**（本机实测）：

| 方式 | 结论 |
|---|---|
| npm | ✅ 采用。prefix 已在 PATH，10 秒装完 |
| WSL（官方推荐） | ❌ 本机 WSL 仅有 `docker-desktop` 且已停止，需先装 Linux 发行版 |
| winget | ⚠️ 有 `SST.opencode` 但版本停在 **1.19.0**，旧于 npm 的 1.19.2 |
| choco / scoop / mise | ❌ 均未安装 |
| Docker | ⚠️ 可用但多一层，且非持久 |
