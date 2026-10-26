# dsh-dispatch — DSH 0.2.1-rc.1 兼容与优化评估

> 生成：2026-10-17 ｜ 作者：标准模式 DSH 会话
> **基线**：DSH `0.2.0-rc.2`（当前运行，**尚未更新**）→ **目标**：`0.2.1-rc.1`
> 排查方式：静态代码扫描（排除 `node_modules` / `test` / `.data`）+ 官方包对比（npm `0.2.1-rc.1` vs 当前 `app.asar` 内 `0.2.0-rc.2`）+ 本机实测
> **项目更名说明**：本项目原为 `zcode-dispatch`，现已更名为 **`dsh-dispatch`**，代码移入 `dispatch/` 子目录。

---

## 一、结论速览

| 项 | 结论 |
|---|---|
| 破坏性冲突 | **0 项已确认**；**1 项待实测**（`agent/inbox/claimed` 事件） |
| 必须处理 | **2 项** —— ① 缺 `engines.dsh`；② **profile link 路径过期**（独立隐患，与 0.2.1 无关但会咬人） |
| 建议优化 | **7 项**，其中「Agent Team 直投 Inbox」「子代理 Agent Preset」最相关 |
| 更新后风险 | **中低**。已内置**激活信标**可直接读字段判定，无需猜 |

---

## 二、插件现状（含证据）

### 包与注册

| 项 | 值 | 证据 |
|---|---|---|
| 仓库根 | `F:\My Code\dsh-dispatch\` | 实测 |
| 根 `package.json` | `name: dsh-dispatch`, `v0.1.0`；`exports` 全部映射到 `./dispatch/*` | 仓库根 `package.json` |
| **实际生效的插件包** | `dispatch/package.json`（`name: dsh-dispatch`, `v0.1.0`） | `dispatch/package.json` |
| 解析路径 | `node_modules/dsh-dispatch` → `F:\My Code\dsh-dispatch\dispatch`（junction） | 实测 |
| 入口 | `.` → `./index.js`（61 KB） | `dispatch/package.json` exports |
| 客户端 | `./client` → `./client.js`（321 KB） | 同上 |
| 远端面 | `./typert` → `./wire.host.mjs`（68 KB）；`./remote` → `./wire.client.mjs`（39 KB） | 同上 |
| `engines` | **仅 `node: ">=22.12.0"`** —— 无 `dsh` | `dispatch/package.json` |
| `dsh` | `manifestVersion: 1`；`bundle.patch: ./cordis.patch.yml`；`client.inject: ["@deepseek-ai/dsh-client-ui-conversation"]` | 同上 |
| 无 `peerDependencies` | — | 同上 |

### 关键接口清单

| 接口 | 位置 | 说明 |
|---|---|---|
| `ctx.tools.register(defineTool({ name, description, parameters, output, execute }))` | `dispatch/index.js:431` | 注册 `dispatch` agent 工具；`ctx.tools` 由 `inject=['tools']` 取得 |
| `defineTool` 解析 | 信标 `defineToolSource: "resourcesPath/app.asar\|import"` | **直接 import asar 内文件**：`D:\DeepSeek\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-tools\lib\index.js` |
| **唤醒投递** | `dispatch/index.js:600+`（`agentsFacade`）、`dispatch/notify.mjs:15` | `ctx.get('agents')` → `agents.get(sessionId)` → **`status === 'idle' ? followup(msg) : inject(msg)`** |
| **事件订阅** | `dispatch/notify.mjs:160` | `ctx.on('agent/inbox/claimed', ({ agent, message }) => …)` —— 用于**复位唤醒预算** |
| 消息形态 | `dispatch/notify.mjs:15` 注释 | `role:'user'` + `source:{ kind, form:'notice', summary }`（客户端渲染成"本轮由通知触发"的可展开卡片，**不冒充用户发言**） |
| system prompt 注入 | `dispatch/index.js:607+` | `ctx.inject(['systemPrompt'])` → `spCtx.systemPrompt.section({ name: 'tool:dispatch', order: TOOL_JOBS+5, text })` |
| **激活信标** | `dispatch/.data/state/activation.json` | 16 个诊断字段，见 §六 |

### 当前运行基线（2026-10-17 15:12 实测，**更新后用于对照**）

```json
{
  "at": "2026-10-17T07:12:29.766Z",
  "dispatcherReady": true,
  "ctxToolsRegisterAvailable": true,
  "defineToolResolved": true,
  "defineToolSource": "resourcesPath/app.asar|import",
  "toolRegistered": true,
  "remote": { "available": true, "strategy": "ctx.provide", "ok": true, "visibleAfter": false, "matchedFace": false },
  "switchEnabled": true,
  "notifyOnSettle": true,
  "maxConsecutiveWakes": 0,
  "systemPromptHint": true,
  "wakeActive": true,
  "wakeNote": null,
  "agentsVisible": true,
  "systemPromptHintActive": true,
  "configIssues": [],
  "configIssueCount": 0
}
```

---

## 三、兼容性排查（逐条对照 0.2.1 开发者变更）

| # | 0.2.1 变更 | 是否命中 | 证据 / 结论 |
|---|---|---|---|
| 1 | 移除 `./invariant` 导出 | ❌ | 0 命中 |
| 2 | 子路径插件不再读独立 `package.json` | ❌ | 按**包名**注册（`dsh-dispatch`）。⚠️ 但注意本项目有**两份** `package.json`（仓库根 + `dispatch/`），生效的是 `dispatch/` 那份 |
| 3 | 兼容性优先按 `engines.dsh` 判断 | ⚠️ **命中** | 只有 `engines.node` → P0-① |
| 4 | 输入区统计拆为 `activity` / `usage` | ❌ | 0 命中（`seqUseBoth` 等是它自己的 i18n 文案） |
| 5 | 移除工具展示 `both` 模式 | ❌ | 7 处命中**全部是它自己的锁模式** `lock: repo\|memory\|both`（ZB-16 已删除 memory/both，代码里还留着"默认由 both 改为 repo"的注记）与用量枚举 `usageState = 'both'`。**与 DSH 的工具展示模式无关** |
| 6 | **Agent Team 消息直投目标 Inbox（移除 outbox / 自动重试 / 重发去重；相关配置与结果字段需迁移）** | ⚠️ **可能命中，待实测** | 本插件用 `ctx.get('agents')` 投递唤醒，并订阅 **`agent/inbox/claimed`**。见 §三-A |
| 7 | 统一子代理执行与完成通知，工具立即返回 child ID；自定义 SDK runtime 需支持 session/wait | ❌ | 扫描 `ctx.subagent` / `subagentProvider` **0 命中**（它自己管 job，不用 DSH 子代理）。⚠️ 但 `defineTool` 的 **output 契约**属工具结果范畴，见 §三-B |
| 8 | Python PTC 沙箱服务 | ❌ | 0 命中 |
| 9 | 移除 agent-instructions 逐行 `dshHome` | ❌ | 0 命中 |
| 10 | pi-ai 更新至 1.0.2 | ❌ | **无 `peerDependencies`** |
| 11 | Azure provider 改名 | ❌ | 0 命中 |
| 12 | API Key 读取优先级变更 | ❌ | 不读凭据 |

### §三-A：`agent/inbox/claimed` 是本插件**唯一**的实测风险点

**0.2.1 原文**：

> Agent Team 消息改为直接投递目标 Inbox，移除独立 outbox、自动重试和重发去重；**相关配置与结果字段需迁移**。

**本插件用法**（`dispatch/notify.mjs:118` 注释 + `:160` 代码）：

```js
* @param {object} [options.ctx] 插件上下文（仅用于订阅 agent/inbox/claimed 复位唤醒预算）
...
const offInbox = typeof ctx?.on === 'function'
  ? ctx.on('agent/inbox/claimed', ({ agent, message } = {}) => { … })
```

**影响判定**：
- 投递路径 `agents.get(id).followup/inject` 是**会话唤醒**语义，与"Agent Team 队友互发"不同，**大概率不受影响**
- 但 `agent/inbox/claimed` 是 **Agent Team 事件**，恰在变更范围内 → **事件名或载荷可能变化**
- **兜底设计已就位**：插件把唤醒定位为"有就更好"的增强，任何失败只 warn 不抛；即便事件订阅失效，**派发本身不受影响**（只影响"连续唤醒预算复位"）

**判定方式**：更新后读 `activation.json` 的 `wakeActive` / `agentsVisible`，并做一次真实唤醒测试（见 §六）。

### §三-B：`defineTool` 从 asar 加载的契约风险

信标记录 `defineToolSource: "resourcesPath/app.asar|import"`，即**直接 import `app.asar` 内的 `@deepseek-ai/dsh-tools`**。更新会替换该文件。

0.2.1 **未列出 `dsh-tools` 的 API 变更**；但「工具立即返回 child ID」属于工具输出契约范畴，`defineTool` 的 `output` 必填（同 `dsh-browser-kit` 的注释：`defineTool` 无条件读 `options.output.render` / `.schema`）。**建议更新后跑一次工具调用冒烟。**

---

## 四、需要处理的项

### P0-① —— 补 `engines.dsh`

官方原文：

> 第三方插件的版本兼容性优先按 `engines.dsh` 判断；未声明时沿用原有规则。**插件作者需检查声明是否覆盖支持的 DSH 版本。**

在 **`dispatch/package.json`**（生效的那份）增加：

```json
"engines": {
  "node": ">=22.12.0",
  "dsh": ">=0.2.0-rc.2 <0.3.0-0"
}
```

### P0-② —— 修复 profile 的过期 link 路径（**独立隐患，优先级很高**）

**现状**（三者不一致）：

| 处 | 内容 | 是否有效 |
|---|---|---|
| `profile/package.json` 依赖 | `"dsh-dispatch": "link:F:/My Code/zcode-dispatch/dispatch"` | ❌ 该路径**不存在** |
| `profile/pnpm-lock.yaml` | `dsh-zcode-dispatch: specifier: link:F:/My Code/zcode-dispatch/zcode-dispatch` | ❌ **旧名 + 旧路径** |
| 实际 junction | `node_modules/dsh-dispatch` → `F:\My Code\dsh-dispatch\dispatch` | ✅ 正确 |

**风险**：插件管理器增删插件会触发 `pnpm install`，届时可能**按 package.json 里的旧路径重建链接** → 派发台直接失效。

**改法**：

```powershell
# 1) 改 profile/package.json 第 13 行为：
#    "dsh-dispatch": "link:F:/My Code/dsh-dispatch/dispatch"
# 2) 重跑 pnpm install 刷新 lockfile（同时会清掉 dsh-zcode-dispatch 的旧记录）
```

### P2 —— 一条无害的死条目（可留可清）

`profile/cordis.patch.yml` **line 56** 有一行 `name: "@local/dsh-connect-zcode"` 指向不存在的包；但它**被 line 583 同 id 条目覆盖**（文件注释已说明"同 id 时后一条整体覆盖前一条"）。生效的是 `dsh-connect-zcode` ✅。与本插件无关，但在同一 profile 内，顺带记录。

---

## 五、0.2.1 新功能带来的优化机会

### 1. 唤醒投递改走「Agent Team 直投 Inbox」

**现状**：`ctx.get('agents')` → `agents.get(sessionId)` → `status === 'idle' ? followup(msg) : inject(msg)`。

**0.2.1 变更**：消息**直接投递目标 Inbox**，不再经独立 outbox。

**可做的改造**：唤醒投递路径可简化，去掉对 outbox 时序/去重的隐含假设。

**⚠️ 前提**：需先确认 `agents.get(id)` 上的 `followup` / `inject` 是否仍在（这是本插件**唯一**的实测风险点，见 §三-A）。

---

### 2. 派发任务支持指定「Agent Preset」

**0.2.1 原文**：

> 子智能体可通过配置选用独立 Agent Preset 预设，统一设置角色和工具。

**本插件现状**：`dispatch` 工具的 spec 支持 `model` / `provider` / `engine` / `mode` / `variant` 等，但**没有"角色 + 工具成套"的概念**。

**可做的改造**：给派发的子任务指定 Agent Preset。

**收益**：比现在只能逐个传 model/参数更结构化；可复用官方预设体系而非自建。

---

### 3. 对齐「工具立即返回 child ID」

**0.2.1 原文**：

> 统一子代理执行与完成通知，工具立即返回 child ID；自定义 SDK runtime 需支持 session/wait。

本插件的 `dispatch` 工具已经有自己的 job id / `resume` / `action=wait` 体系（与 ZCode 派发台同构）。若官方统一了 child ID 语义，可评估**对齐**，减少"自建 job id ↔ 宿主 child id"的映射负担。

---

### 4. 评估用官方「自动化任务 + 提醒工具」替代自制唤醒

**0.2.1 原文**：

> 自动化任务改为 Web 内置能力，提醒工具按模式提供：**标准、创造和 PTC 模式可用，极简模式和子代理不可用**；旧实验组合包选择会自动清理，已有任务保留。

**本插件现状**：自建 `notify.mjs`（13 KB）+ `maxConsecutiveWakes` 预算 + `notifyOnSettle` 开关。

**可做的改造**：评估把"任务落地唤醒"接官方提醒工具，省掉一部分自制逻辑。

**⚠️ 前提**：需要确认提醒工具**能否携带结构化载荷**（本插件的唤醒消息带 `source:{kind,form:'notice',summary}`，并要渲染成可展开卡片）。若官方提醒工具只支持纯文本提示，则**不值得替换**。

---

### 5. Session 菜单支持复制会话 ID

本插件的 `resume` 参数、唤醒投递、`action=wait` 全靠 `sessionId`。0.2.1 起会话菜单可直接复制 ID，**排障与手工续跑更方便**。零改造成本。

---

### 6. 插件热重载 + 依赖同步

**0.2.1 原文**：

> 支持插件启用、停用、卸载及更新后的依赖同步；启用热重载时，更新或重新安装的可替换插件直接生效，无法热重载时提示重启。

对本插件（宿主半边 `index.js` 61 KB + `wire.host.mjs` 68 KB）的开发循环有直接帮助。注意既有语义：**客户端半边改完刷新页面即可，宿主半边必须完全退出 DSH 再启动**。

---

### 7. ⚠️ 不要指望「Session 状态记录接口」

0.2.1 新增 `appendPluginRecord(session, type, data)`，但官方文档明确：

> appends one plugin record for a package under **`packages/experimental/`**; … **Plugins outside this repository must not call it either**.

**它是给 DSH 自家 `packages/experimental/` 内部插件的接口，外部插件不应调用。** 本插件的 job 状态继续自己落盘（`.data/state/jobs.json`，实测 689 KB）。

**替代**：如需在会话日志里写自己的事件并投影成模型可见消息，用 **`ctx.sessions.registerMessageProjection()`**（`@messageProjection`）—— **你当前 0.2.0-rc.2 里已有该接口**（实测命中 `dsh-session/lib/index.js`）。

---

## 六、更新后验证清单（可复跑）

### 核心探针：一句话判定

```powershell
# 更新后立刻执行，与本文件 §二 的基线逐字段对比
Get-Content "F:\My Code\dsh-dispatch\dispatch\.data\state\activation.json" -Raw
```

| 字段 | 基线 | 不达标的含义 |
|---|---|---|
| `dispatcherReady` | `true` | 派发核心未装配 |
| `ctxToolsRegisterAvailable` | `true` | `ctx.tools` 不可用 → 工具不注册 |
| `defineToolResolved` + `defineToolSource` | `true` / `resourcesPath/app.asar\|import` | **asar 内 `dsh-tools` 解析失败**（更新后最可能出问题的一项） |
| `toolRegistered` | `true` | `dispatch` 工具未注册 → 模型看不到派发台 |
| `remote.available` | `true` | 面板远端面不可用 |
| `agentsVisible` | `true` | `agents` 服务解析不到 |
| `wakeActive` | `true` | **唤醒未启用** ← **本插件唯一实测风险点** |
| `systemPromptHintActive` | `true` | 系统提示段未注入 |
| `configIssueCount` | `0` | 配置被拒 |

### 端到端验证

```powershell
# 1) 工具可见：新会话里让模型列出工具，应含 dispatch
# 2) 派发冒烟：派一个最小任务，确认 job 落地并出现在面板
# 3) 唤醒测试（覆盖 agent/inbox/claimed）：
#    派一个**秒级完成**的任务，然后**不要碰会话**，观察是否被自动唤醒
#    期望：会话被唤醒并收到"本轮由通知触发"的可展开卡片
#    若未唤醒但 activation.json 的 wakeActive=true → 说明事件订阅失效，需查 0.2.1 的 Inbox 事件名
# 4) 面板：确认悬浮面板可见且显示真数据（非"演示数据"）
# 5) 单写者约束：同一目录并发派发两次，第二次应被挡
```

---

## 附：证据来源与不确定性

| 结论 | 证据强度 |
|---|---|
| 12 项变更中仅 `engines.dsh` 确认命中 | **强**（全库扫描 + 逐项读码） |
| `both` 的 7 处命中全是自身锁模式 | **强**（逐处读码：`dispatch.mjs:156`、`client.js:1514/1825/4271`、`wire.client.mjs:746`、`wire.host.mjs:211`） |
| 唤醒用 `agents.get(id)` + `followup/inject` | **强**（`notify.mjs:15` 注释 + `index.js:600+`） |
| 订阅 `agent/inbox/claimed` | **强**（`notify.mjs:160`） |
| `agent/inbox/claimed` 在 0.2.1 是否变更 | **未确认**（**必须实测**，这是本插件唯一风险点） |
| profile link 路径过期 | **强**（三处比对：package.json / pnpm-lock.yaml / 实际 junction） |
| `appendPluginRecord` 对外部插件禁用 | **强**（0.2.1 README 原文） |
| `registerMessageProjection` 当前版本已有 | **强**（当前 asar 实测命中） |
| 官方提醒工具能否替代自制唤醒 | **弱**（能力已确认，**结构化载荷能力未确认**） |

### 未做改动声明

本文档**只做排查**，未修改任何插件代码或配置。

---

## 七、独立复核与补充（2026-10-17 16:20，由**另一个 DSH 会话**追加）

> 复核方式：不采信本文档结论，**逐条回本地验证**；并补上本文档**未覆盖的客户端侧风险面**
> （本文档成稿于 15:59，而客户端在 13:00–15:50 之间新增了「插件详情页配置卡」等集成点）。

### 7.1 已独立验证（原文档结论成立）

| 原结论 | 我的复核 | 结论 |
|---|---|---|
| P0-① `engines.dsh` 缺失 | `package.json` 与 `dispatch/package.json` 的 `engines` 均只有 `{"node":">=22.12.0"}` | ✅ **成立** |
| P0-② profile link 过期 | `profile/package.json` = `"dsh-dispatch": "link:F:/My Code/zcode-dispatch/dispatch"`（**旧路径，实测不存在**）；`pnpm-lock.yaml` = `dsh-zcode-dispatch: link:F:/My Code/zcode-dispatch/zcode-dispatch`（**旧名+旧路径**）；实际 junction → `F:\My Code\dsh-dispatch\dispatch`（✅ 有效） | ✅ **成立，且比文档描述更危险**（见 7.3） |
| 订阅 `agent/inbox/claimed` | `dispatch/notify.mjs:160` 确实 `ctx.on('agent/inbox/claimed', …)` | ✅ **成立** |
| 当前 DSH = 0.2.0-rc.2 | `DeepSeek Harness.exe` 文件版本 = `0.2.0-rc.2` | ✅ **成立** |

### 7.2 本文档**漏掉**的风险面：客户端半边的更新契约（建议补为 P1）

本文档的排查是**宿主半边导向**（engines / notify / defineTool），但本项目在 13:00–15:50 之间新增了
**三个依赖 DSH 客户端契约**的集成点，全部未在原文中出现：

| 新增集成点 | 依赖的 DSH 契约 | 若 0.2.1 改名/移除的后果 | 现有兜底 |
|---|---|---|---|
| **插件详情页配置卡** | 槽位 `plugins.bundle.config`（**keyed，按包名派发**）+ `package.json` 的 `dsh.client.inject` 含 `@deepseek-ai/dsh-client-ui-settings-plugins` | 详情页配置卡**静默消失** | ✅ 注册包在 `try/catch` 里，只 `console.warn`；**派发台浮窗不受影响** |
| **会话标题行入口** | 槽位 `conversation.session.header.actions` | 派发台入口消失（功能基本不可达） | ❌ 无替代入口 |
| **主题令牌** | 14 个 `--dsw-alias-*`（全部 `requiresLightAndDark: true`） | 面板配色错乱/不可读 | 有 `var(..., fallback)` 兜底 |

**关键判断**：**最低风险的破坏点是「配置卡消失」，不是「插件坏掉」**——因为配置卡注册有 try/catch，
且浮窗那条路径独立。**最高风险**其实是 `conversation.session.header.actions`（那是唯一入口，无降级）。

**更新后的验证方法（可复跑，已实测当前版本可用）**：
```
cordis_inspect_query { platform:'client', provider:'Slots', method:'listSubTree', input:{ root:'plugins.bundle.config' } }
# 期望：slot 存在；且其 occupants 里能看到 key='dsh-dispatch'
# 再查 root:'conversation.session.header.actions' ⇒ 期望有 id='dispatch' 的 occupant
```
若任一槽位消失 ⇒ 需按 0.2.1 的新槽位名调整 `client.js` 的常量（`BUNDLE_CONFIG_SLOT` / `HEADER_SLOT`）。

### 7.3 对 P0-② 的**升级意见**：优先级应高于「更新前修复」

原文把它列为"独立隐患"。我认为**它才是更新过程中最可能真正弄坏插件的一项**，理由：

1. DSH 更新会替换 `app.asar`，**很可能触发 profile 依赖重装**；而 `profile/package.json` 里指向的是
   **已不存在的旧路径** ⇒ `pnpm install` 会失败或把 junction 重建到无效目标。
2. 现状之所以还能跑，是因为**junction 此刻仍然指向正确位置**（我实测 Target 存在）。
   **这是一份"正在消耗的运气"**：任何一次 install 都可能把它抹掉。
3. 修复只需改 1 行 + 重跑 `pnpm install`，成本极低、收益是"避免插件直接消失"。

**建议：把它从 P0-② 提升为「更新前必须完成」的第 0 项（在更新 DSH 之前做）。**

### 7.4 对 P0-① 的**降级意见**：从 P0 降为 P1（除非实测确认硬拒）

原文称"兼容性优先按 `engines.dsh` 判断"。但**"优先判断"不等于"缺失即拒绝"**——多数包管理器
在字段缺失时走保守回退。目前**没有证据表明 0.2.1 会因缺 `engines.dsh` 而拒绝加载本插件**。

- **建议**：仍应补（成本 2 行），但**不必因此推迟更新**；补的时候注意**补在生效的那份**——
  实际生效包是 **`dispatch/package.json`**（junction 指向 `dispatch/`），不是仓库根；
  为避免混淆，**两份都加**（根那份是仓库包装层）。
- **实测判定法**：更新后读激活信标 `activation.json` 的 `configIssues` / 插件是否出现在插件列表。

### 7.5 本文档**未列出的优化机会**（第 8 项）

| # | 机会 | 价值 | 依据 |
|---|---|---|---|
| 8 | **插件热重载 + 依赖同步**（原文第 6 项）对本项目**收益最大** | ⭐⭐⭐ 今日任何 Host 半边改动（`index.js` / `wire.host.mjs` / `core/*`）都**必须完全重启 DSH**；本轮开发因此反复重启。若 0.2.1 支持插件热重载，开发/调试闭环大幅缩短 | 原文 §五-6 |

⚠️ 但需注意：**热重载可能掩盖"重启才能复现"的问题**（如本项目的 `defineTool` from asar、模块级缓存）。
建议热重载**只用于开发**，验证仍以完整重启为准。

### 7.6 复核结论（一句话）

> 原文档的**排查是可信的**（我逐条回验，未发现误报）；但它**低估了 P0-②**（应提到更新前第一位）、
> **高估了 P0-①**（缺字段通常是警告不是硬拒）、且**完全没覆盖客户端侧契约**（配置卡/标题行入口/主题令牌）。
> 执行顺序建议：**① 修 profile link → ② 补 engines.dsh（两份）→ ③ 更新 DSH → ④ 按 §7.2 验槽位 + 按 §六 验唤醒**。

---

## 八、更新后实测结果（2026-10-17 17:48–17:56，**用户已完成更新**）

> 执行人：同一 DSH 会话（承 §七 复核者）。方法：§六 信标逐字段对比 + §7.2 槽位探针（`cordis_inspect_query`）+ 宿主事件/服务契约目录 + **真机派发冒烟 + 自动唤醒观察** + 48 项回归测试。

### 8.1 版本与信标

| 项 | 值 |
|---|---|
| 桌面外壳 `@deepseek-ai/dsh-desktop` | **0.2.1-rc.2**（`dshBuildCommit 332895e0f7c9d4dbfb29729f5eb367fa263ff986`） |
| 运行时 `@deepseek-ai/dsh-desktop-runtime` | **0.2.1-rc.2**（内含 `@deepseek-ai/dsh` 0.2.1-rc.2 全套） |
| `engines.dsh` 是否覆盖 | ✅ `>=0.2.0-rc.2 <0.3.0-0` 对 `0.2.1-rc.2` 成立（插件正常加载，`configIssues: []`） |
| 是否需改代码 | **否 —— 0 项必改**；本轮**未产生任何代码改动** |

`dispatch/.data/state/activation.json`（17:48:14，DSH 17:48:09 启动后 5 秒写入）与 §二 基线**逐字段一致**：

| 字段 | §二 基线 | 更新后 | 判定 |
|---|---|---|---|
| `dispatcherReady` | true | true | ✅ |
| `ctxToolsRegisterAvailable` | true | true | ✅ |
| `defineToolResolved` / `defineToolSource` | true / `resourcesPath/app.asar\|import` | true / 同 | ✅ asar 内 `dsh-tools` 仍可 import |
| `toolRegistered` | true | true（`toolRegisterError: null`） | ✅ |
| `remote.available` / `strategy` / `ok` | true / `ctx.provide` / true | 同（`visibleAfter: false`、`matchedFace: false` 亦同基线） | ✅ 无回归 |
| `switchEnabled` / `notifyOnSettle` / `maxConsecutiveWakes` | true / true / 0 | 同 | ✅ |
| `wakeActive` / `agentsVisible` | true / true | true / true | ✅ |
| `systemPromptHintActive` / `configIssueCount` | true / 0 | true / 0 | ✅ |

### 8.2 客户端契约（§7.2 的方法，实测）

| 槽位 | 结果 |
|---|---|
| `plugins.bundle.config` | 存在；occupants 含 **`key: dsh-dispatch`，`active: true`** ✅（详情页配置卡正常注册） |
| `conversation.session.header.actions` | 存在；occupants 含 **`id: dispatch, order: -25, active: true`** ✅（唯一入口在） |
| `shell.overlay`（降级浮层） | 存在但 **occupants 里没有 dispatch** ✅ ⇒ 说明走的是主入口，**未降级** |
| 主题令牌 | 仍为 **14 个同名 `--dsw-alias-*`**，全部 `requiresLightAndDark: true` ✅ 无改名 |

### 8.3 §三-A「唯一实测风险点」：**已实测通过**

- 事件目录（`cordis_inspect_query` host `Event.listEvents`）：**`agent/inbox/claimed` 仍在**，签名 `(this: Scoped<Agent>, payload: { agent; message; turn })` —— 与 `dispatch/notify.mjs:160` 的解构一致。
- 真机链路：派发 `j-mvc7vmki-0-ad17`（`opencode/deepseek-v4.1-flash-free`，免费模型，`--variant disabled`）→ `done exit=0 elapsed=18.4s responseChars=12` → **本会话在未被触碰的情况下被自动唤醒**，收到「[dispatch] 派发任务 … 已落地」notice。
  ⇒ `agents.get(sessionId)` → `status==='idle' ? followup(msg) : inject(msg)` 在 0.2.1-rc.2 **语义未变**（`agents` 服务目录仍含 `get(id)`）。

### 8.4 回归测试

`48/48 全部通过`：44 个 `dispatch/test/*.test.mjs` ＋ `z2-verify.mjs`（85 PASS/0 FAIL）＋ `z4-token-check.mjs`（0）＋ `tools/verify-plugin.mjs`（0）＋ `tools/verify-opencode.mjs`（0）。
（runner 脚本：`%TEMP%\dispatch-suite.mjs`，逐文件 spawn，可复跑。）

### 8.5 对前文的修正

1. **§五-2「Agent Preset」价值需下调**：0.2.1 确实新增了 `agentPresets` 服务（`list/resolve/select/mount/readDocument`）、`agent-preset/selected` 事件与 `conversation.hero.agentPreset` 槽位 —— 但它们作用于 **DSH 自己的 Agent**；本插件的派发对象是**外部 CLI**（ZCode/OpenCode/Qoder），接不上。除非决定新增「DSH 原生子代理」作为第 4 引擎（成本高，且会消耗 DSH 账号额度，与「只用免费模型」约束冲突）。
2. **生效包与根包的 `dsh.client.inject` 不一致**：根 `package.json` = `[ui-conversation, ui-settings-plugins]`，生效的 `dispatch/package.json` = `[ui-conversation]`。**不影响运行**（配置卡 occupant 已 active），但两份不一致会造成"按根包判断"的误读 —— 建议对齐（§九 P3）。
3. §五-6 的 HMR 结论**当时判断错了，已在 §十纠正**：base 组合包默认启用 `hmr`（本机 `live: include:hmr` = schema），profile 里没有该条目 ≠ 未启用；实测宿主改动**无需重启 DSH** 即可生效（见 §10.1）。

---

## 九、更新后重排的下一步建议（**由你决定执行顺序**）

| 优先级 | 建议 | 依据（均已在 0.2.1-rc.2 本机实测） | 成本 / 风险 |
|---|---|---|---|
| **P1** | 给 `dispatch` 工具做**会话内专属卡片**：`tool.call.toolview`，`key: 'dispatch'` | 槽位 live；`dispatch` 键**未被占用**（occupants 里没有）；目录原文：允许"你自己包注册的工具" | 纯客户端（改完刷新页面即可），不动宿主 |
| ~~P1~~ | ~~HMR `root` 显式化~~ ⇒ **结论反转：不要做（见 §10.1）**：HMR 本机已启用，且 0.2.1 的重组合会自动替换已变化的 link 包；把插件目录加进 `hmr.root` = **存盘即 kill running job**（卸载清理），是负向优化 | 0.2.1 base 组合默认挂 `hmr`（`live: include:hmr`）；今天实测两次"未重启就换成了新代码"（信标 + 活体工具 schema 双证） | 只改文档纪律：**改宿主文件前先确认没有 running/queued job**；验收判据用信标/活体 schema |
| **P2** | 第二入口：会话行菜单 `sidebar.workspaces.session.menu.item` / 输入区 `conversation.input.left` | 两槽位 live；现状只有 header 单入口、**无降级**（§7.2 的最高风险项） | 客户端 |
| ~~P2~~ | ~~唤醒投递确认：订阅 `agent/inbox/inserted`~~ ⇒ **已落地（ZB-62，§10.2）** | 事件目录确有该事件（`claimed`/`discarded` 同族） | 宿主小改（**实测免重启**） |
| **P3** | 一致性清理：两份 `package.json` 的 `dsh.client.inject` 对齐；关键文档补 0.2.1 基线（本 §八 即基线） | §8.5-2 | 极低 |

**明确不建议做**（省时间）：

- **用官方提醒工具（`schedule_*`）替代自制唤醒** —— 官方提醒**不支持** `source:{kind,form:'notice'}` 结构化载荷，替换会丢掉「本轮由通知触发」的可展开卡片（§五-4 的"弱证据"现在可以判死）。
- **对齐"工具立即返回 child ID"** —— 本插件 `dispatch` 已是"入队即返回 job id"，无缺口。
- **`appendPluginRecord` / Session 状态记录接口** —— 官方明确禁止外部插件调用（§五-7），继续自落盘。
- **Agent Preset** —— 见 §8.5-1。

---

## 十、用 0.2.1 新功能做正向优化：落地记录与判定（2026-10-17 晚）

> 方法：先做一份**证据化**的 0.2.1 能力清单（只读调研，6 条「未验证」如实标注，全文见 `%TEMP%\dsh-021-research.md`），
> 再只挑「证据充分 + 收益明确 + 风险可控」的项落地；每条落地都带回归测试与真机验证。

### 10.1 重大纠正：**HMR 已经启用，宿主半边的改动不需要重启 DSH**

§8.5-3 当时判断"profile 里没有 hmr 条目 ⇒ 未启用"是错的 —— base 组合包**默认**挂 `hmr`
（活体 `include:hmr` = schema），profile 不写该条目不代表没启用。

实测证据（本轮我自己撞上的）：

| 时刻 | 事件 |
|---|---|
| 17:48:09 / 18:08:36 / 18:12:03 | `activation.json` **被重写 3 次**，而 DSH 主进程自 17:48:09 起**从未重启**（`Get-Process` StartTime 未变）⇒ 插件被 HMR 就地替换 |
| ~17:57–18:07 | 我改了 `dispatch/index.js`（工具 schema 加 `limit`/`full` 两个参数）与 `dispatch/wire.host.mjs`（`action=list` 紧凑形状） |
| 18:10 | 真机 `dispatch action=list` 返回 **`shape:"brief"` + `total/counts/note`** ⇒ wire 新代码在跑 |
| 18:16 | 活体 `cordis_inspect_query` host/Tool：`dispatch` 工具的 parameters **已含 `limit`/`full`** ⇒ index.js 新代码也在跑（**两条都是"没重启就生效"的硬证据**） |
| 18:11:31 → 18:12:03 | 只 `touch` 了 `index.js` 的 mtime（内容一字未改）⇒ 约 30s 后插件又一次替换。**但 18:18 复现失败**（同样的 touch，等满 2 分钟毫无反应）⇒ 可见那次是"恰好赶上一轮重组合"，**落盘本身不触发**（见下） |

**机制（实测 + 官方 README 对照）**：0.2.1 的 HMR 在**重组合（recomposition）**时会替换
「磁盘上已变化的 link 包目标」—— 这是 0.2.0 没有的能力（0.2.0 时代重组合只会**重新 apply 已缓存的模块**，
所以那时"改 host 必须重启"是对的，见 `pitfalls.md` 2026-09-30 第 3 条）。**但落盘本身不触发重组合**：
我 18:18 只 touch 了 `index.js`，等满 2 分钟信标毫无变化。

⇒ 正确表述：**host 代码改动会在"下一次重组合"时生效（不必重启）**，而重组合由 profile patch/manifest 变更
与插件管理器操作触发；**落盘不会自己触发**。所以验收判据始终是信标/活体 schema，要**确定性**生效就重启。

**但不要据此把"热重载"当成纯收益**，有两个必须知道的前提：

1. **替换 = 卸载 + 重新 apply，而卸载清理会 kill 掉所有 running/queued job**
   —— `dispatch/index.js:694-717` 的 `disposeAll()`：`dispatcher.kill(j.id, 'plugin unloading: dispatcher disposed')`。
   ⇒ **纪律：改宿主半边文件之前先确认没有 running/queued job**（`action=list` 或面板一眼可见）；
   否则"改了代码 → 谁顺手碰了下插件开关触发重组合"就能干掉一个跑了半小时的任务。
2. 因此**不要**把插件目录写进 `hmr.config.root`（`pitfalls.md` 2026-09-30 已有同样告诫）：
   「存盘即重载」在本插件等于「存盘即杀 job」，是**负向**优化。

⚠️ 随之更新的旧纪律：
- "宿主半边改完必须完全退出 DSH 再启动"→ 改为："**下次重组合**时会自动生效（今天实测两次，均未重启）；
  落盘不触发重组合，判定用信标 `at` / 活体工具 schema，必要时重启"。
- **客户端半边（`client.js` / locale）仍以刷新页面为准**：`dsh-client-hmr` 的 bundle 重建入口是 `pnpm run dev:web`，
  手写无构建的 client.js 能否免刷新自动重载**未验证**（本轮不赌）。

### 10.2 已落地（都带回归测试）

| 编号 | 内容 | 为什么是"正向" | 证据 / 验证 |
|---|---|---|---|
| **ZB-61** | `action=list` 默认**紧凑 + 有界**（默认 50 条，`limit`/`full` 可调） | 旧形状 96 条 job = **212 KB**，超宿主 spill 预算（`maxInlineTokens: 12500`，按 `chars/4` 估算）⇒ 被**从中间截断**，模型只拿到首尾两段 + "Omitted …"；新形状 **22 KB ≈ 5.6K token** ⇒ 不再 spill，且 `total/counts/note` 让"省略"可见 | 提交 `f85d416`；`test/list-compact.test.mjs`（40 断言）；真机 `action=list` 已返回 `shape:"brief"` |
| **ZB-62** | 唤醒投递**可观测**：用 0.2.1 新增的 `agent/inbox/inserted` / `discarded` 按消息 id 对账，健康度落盘 `state/wake-stats.json` | 旧代码 `delivered++` 只证明"没抛错"，消息被宿主静默丢弃时完全不可见；现在"送没送到"可事后查证 | 提交 `82644ff` + 修复 `03afb7c`；`test/notify-inbox-observe.test.mjs`（8 用例）。**真机验证逮到一个只有真机才暴露的顺序 bug**：`agent.inject()` 内部的 inbox splice 是**同步**的 ⇒ `inserted` 在调用栈内就发出来，而第一版"先投递、后登记消息 id"导致事件被 `has()` 判掉，计数器永远 0（wake-stats.json 实测 delivered=1/insertAcked=0/unconfirmed=1）。修法＝**先登记 id、再投递**（与 ZB-25 的 kill 顺序同一个坑），并新增"同步 emit"用例钉死 |
| **ZB-63** | `dispatch` 工具的**会话内专属卡片**：0.2.1 新增 keyed 槽位 `tool.call.toolview`（`key:'dispatch'`） | 派发调用不再是一坨原始 JSON，而有状态/模型/耗时/exit 的可展开卡片（`list` 结果直接给 `total/counts/note` 概览） | 提交 `cc1243f`；`test/toolview-card.test.mjs`（91 断言）；活体槽位 occupants 已出现 `key:"dispatch", active:true` ⇒ 客户端半边已重载并注册成功；**排版观感需用户目视** |

### 10.3 调研后**明确不采纳**（附证据，省下以后重复讨论）

| 项 | 不采纳的理由（证据） |
|---|---|
| `dispatch` 工具开 `deferLoading: true` | 官方语义是"**声明延迟 ≠ 激活**"：mount 期注册的基线工具永远拿不到 `tool-addition` 激活块（`dsh-agent-loop` 只在工具集相对 baseline 增长时产生）；且 `llm-pi-ai` 路由会**直接过滤**延迟工具（`tools.filter(t=>!t.deferLoading)`，本机 pi-ai 已启用）⇒ 唯一工具可能整体不可见。**不可赌。** |
| 调大 `maxInlineTokens` 来"治"list 过大 | spill 是**全局策略、无 per-tool 阈值注记**（`ToolOutputDefinition` 只有 schema/render/presentationMeta）。病根是返回体积，调阈值只会让所有工具结果一起挤占上下文。 |
| 用 `claimed` 反推"唤醒是否真的开了 turn"并据此退预算 | 官方语义：`claimed` 之后 turn 仍可能因 proposed step 被拒而**无 step 关闭**（既不算 discarded 也不再重发）⇒ 语义不可区分，会引入错账。既有 `claimed`（只按 `source.kind==='user'` 复位）保持不动。 |
| Agent Presets | 作用于 **DSH 自己的 Agent**；本插件派发对象是外部 CLI，接不上（除非新增"DSH 原生子代理"引擎，成本高且吃账号额度）。 |
| Agent Teams / workflow / schedule / terminal / worktree / session-query / plugin-manager | 与"派发给外部 CLI + 自己的 job/锁/唤醒模型"职责不重叠（多数在本机还是 inactive 或没有 UI）；接入只增加表面积，无实际收益。 |
| `dsh.client.inject` 里加 `@deepseek-ai/dsh-client-ui-tool` / `ui-settings-plugins` | 调研建议"属主包行依赖"，但**实测反证**：本机 profile 里 `ui-settings-plugins` 是 absent，而我们的 `plugins.bundle.config` 配置卡 occupant 照样 `active` —— 说明 `ctx.slots.inject` 会等槽位声明，**不强依赖** `dsh.client.inject` 顺序。加错一个不存在的包反而可能让整个客户端半边 pending（入口一起消失）。**保持最小清单**，只有真出问题再加。 |

### 10.4 0.2.1 新增能力 × 本插件（一句话判定）

`spill/output-retention` **现在就用**（自己少返回，已做）；`typert`/`remote` **已在用**（自定义 face）；
`tool.call.toolview` **在做**（ZB-63）；`hmr` **已在用**（见 10.1）；`plugins.row.config` / `settings.plugins.tab`
**可评估**（把配置卡挂到插件行内，见 10.5）；其余（presets/teams/workflow/schedule/jobs/terminal/worktree/
session-query/market/attachments/tool presentation）**不适用或以后再说**。

### 10.5 待你决定（我不擅自做）

1. **HMR 相关（已定论，不建议动）**：**不要**把插件目录写进 `hmr.config.root` —— 卸载清理会 kill running/queued job（§10.1），"存盘即重载"对本插件等于"存盘即杀任务"。保持不变、只更新文档纪律即可。
2. **配置卡位置**：是否把派发台配置卡从插件详情页（`plugins.bundle.config`）再挂一份到插件行内（`plugins.row.config`）/ 搬去 `settings.plugins.tab`？现状可正常用，属于体验取舍。
3. **两份 `package.json` 的 `dsh.client.inject` 对齐**（根那份多一个 `ui-settings-plugins`）：只影响"从 npm 安装"的情形，属一致性清理。

