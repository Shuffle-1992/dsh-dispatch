# CREATOR-HANDOFF —— 「DSH 派发台」插件交给创造模式收尾

> 生成：2026-09-30 14:2x ｜ 作者：标准模式 DSH 会话（无 `plugin_manager` / `cordis_inspect_*`，只能靠静态证据摸索）
> 读者：**创造模式（creator preset）会话**。你拥有本会话缺的两样东西：`plugin_manager` 与 `cordis_inspect_query` —— 本单 P1/P2 基本都要靠它们定论。
> **一句话任务**：插件**已安装、已启用、DSH 能正常启动，但页面上看不到悬浮面板**；请把它变成「面板可见 + 显示真数据」，并留下可复跑证据。

---

## 一、当前状态（先建立事实基线）

| 项 | 值 |
|---|---|
| 插件源码 | `F:\My Code\zcode-dispatch\dispatch\`（独立 git 仓库 `main`；最近提交 `e4cdb4c`） |
| 安装方式 | GUI 插件页「添加插件」→ 填本地目录路径；profile 里是 **Junction 软链**：`~/.dsh/profiles/desktop/node_modules/dsh-dispatch → F:\My Code\zcode-dispatch\dispatch` |
| 启用状态 | ✅ `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` **含** `dsh-dispatch` |
| DSH 启动 | ✅ 14:12:56 重启后**无崩溃报告**（`%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*.log` 最新仍是 14:05 的两条旧记录） |
| **面板** | ✅ **已可见**（2026-09-30 14:2x 用户确认）。根因 = `createWire()` 渲染期抛错且当时无 ErrorBoundary → 整块浮层静默消失；修复见提交 `e4cdb4c`（createWire 兜底 + DEAD_WIRE + PanelBoundary），用户刷新页面后可见 |
| 面板数据 | ⚠️ 仍是**演示数据**（`conn='demo'`）→ 真数据卡在 **P2（Remote 命名空间）**，是本单主要剩余项 |
| 宿主半边 | ❓ 未确认激活：`dispatch\.data\` 自 14:04:41 起**无新写入**（该目录由派发核心按 `config.workRoot` 创建） |
| 客户端半边 | ❓ client entry 是否 activated 待你用 inspection / `plugin_manager` 查 |
| 常驻探针 | `node tools/verify-plugin.mjs` → **20/20**（带 `Z2_ALLOW_PROFILE_WRITE=1`；那是"用户已安装插件"导致的 profile 写入，属预期） |
| 单测 | `cd dispatch && node test/core.test.mjs`（11/11）、`node test/channel-retry.test.mjs`（8/8） |

**改动生效语义（务必记住）**：
- 客户端半边（`client.js`）改完 → **刷新页面**即可；
- 宿主半边（`index.js` / `wire.host.mjs` / `core/*`）改完 → **必须完全退出 DSH 再启动**（cordis `_reload()` 复用进程内已 import 的 `runtime`，切插件开关不会重新读盘）；
- 因为是软链，**不需要卸载重装**。

---

## 二、资产地图

| 路径 | 内容 |
|---|---|
| `dispatch/index.js` | 宿主入口：Config（Standard Schema）+ apply（建 dispatcher、注册 agent 工具 `dispatch`、挂 wire） |
| `dispatch/client.js` | 客户端入口：`window.__ModuleLoader__.load` 工厂 → `inject` + `apply` + 悬浮面板组件（~1450 行） |
| `dispatch/wire.host.mjs` | 宿主 Remote 面：`createRemoteFace` / `TYPERT` / `attachHostWire`（含 `ctx.provide(FACE_NAME, face)`，`FACE_NAME='dispatch'`） |
| `dispatch/wire.client.mjs` | 客户端传输层：`createClientWire` / `TYPERT_REMOTE` |
| `dispatch/core/*.mjs` | 派发核心（多进程 / repo+memory 双锁 / 暂停分类 / 交接重跑 / 降级链）、用量聚合、app-server RPC |
| `dispatch/bin/dispatch.mjs` | CLI（`channels/quota/dispatch/kill/tail/...`） |
| `dispatch/cordis.patch.yml` | bundle 自己的插入行（id `dispatch`；config：demo/maxConcurrent/runnerPath/ledgerPath/workRoot） |
| `refs/` | **证据库**：`dsh-slots.md`、`dsh-theme-tokens.md`、`SKILL.md`+`references/`（官方技能）、`dsh-typert/{protocol,loader,registry,plugin-manager}`（官方 typert 实现，asar 提取）、`dsh-plugin-manager/`（官方插件管理页整包） |
| `tools/verify-plugin.mjs` | 常驻探针（20 项：boot 安全 / Standard Schema / 槽位注册 / 浅渲染） |
| `tools/bridge.mjs` + `bridge/` | **另一条独立路线**：客户端「自动化」桥（用客户端宿主额度跑任务，**不需要本插件**） |
| `tasks/Z1..Z10-*`、`*-passed.md` | 完整审计链（任务包 / 交付单 / 放行单） |
| `profile-backup/` | profile 三态留档 + `README-RECOVERY.md`（被救援按钮重置后的还原命令） |
| `pitfalls.md` | 踩坑记录（**开工必读**，含两次启动事故） |

---

## 三、已证实的事实（带证据位置，别重复验证）

1. **cordis 读插件 config 只认 Standard Schema**：`runtime.Config['~standard'].validate(config)` —— `@deepseek-ai/cordis/lib/index.js:956-962`。裸 JSON Schema → `Cannot read properties of undefined (reading 'validate')` → 插件不激活。**已修**（`index.js`：首选 `@deepseek-ai/schemastery`，解析不到则手写 Standard Schema 降级）。
2. **cordis 重载语义**：`_resolveConfig` 用 `this.runtime`（进程内已 import 的模块对象），`_reload()` 不重新读盘 —— `lib/index.js:1345-1356`。
3. **客户端 `inject` 不能声明自家尚未就绪的 `remote.<ns>`**：否则条目 `pending (waiting for service: remote.dispatch)` → **web boot 直接失败**（`crash-2026-09-30T06-04-42-974Z-web-boot.log`）。**已修**为 `inject: ['slots','remote']` + 运行时探测。
4. **`shell.overlay` 真实存在**，官方用法（`@deepseek-ai/dsh-client-ui-chat/lib/client.js +563756`）：
   ```js
   ctx.slots.inject("shell.overlay", () => ctx.slots.register({
     name: "shell.overlay", id: "chat.quota-notice", locale: NS,
     children: { "shell.quota-notice": { kind: "chain", ... } },
   }, ChatView));
   ```
   我们的注册：`ctx.slots.register({ name: SLOT, id: 'dispatch.console', order: 20 }, () => h(PanelBoundary, null, h(FloatingPanel)))`。
5. **客户端↔宿主 = typert Remote**：`ctx.remote.<service>.<method>()`（官方插件管理页 `refs/dsh-plugin-manager/lib/client.js:1130`）；`TYPERT` / `TYPERT_REMOTE` 是**纯数据**描述符；信封 `{ok:true,value}` / `{ok:false,error}`；推送 `ctx.remote.$on("<区域>/<事件>", cb)`。
6. **GUI 手动安装入口**：插件页「添加插件」支持**本地目录路径**（客户端包源码文案实证）→ 安装不需要创造模式；**创造模式是"接线 + 验证"需要的**。
7. **救援按钮副作用**：崩溃对话框的「禁用第三方插件、备份 profile patch 并重启」会**重置** `cordis.patch.yml` 与 bundles 为出厂默认（自定义项全丢，但它自己留了备份）→ 还原见 `profile-backup/README-RECOVERY.md`。

---

## 四、待解决（按优先级，含具体验证方法）

### P0（**已完成，存档**）：面板不可见 —— 2026-09-30 14:2x 用户确认已解决
根因：`createWire()` 在渲染期抛错 + 当时没有 ErrorBoundary → React 整块渲染失败 → 浮层静默消失（页面无报错）。
修复（提交 `e4cdb4c`）：`createWire` 全程 try/catch、`DEAD_WIRE` 兜底、`PanelBoundary`（渲染异常 → 屏幕上一张可见的失败卡片 + 重试）。
→ 若将来又"看不见面板"，现在页面会给出可见原因；把那段文字带回即可定位。

### P1（本单核心）：让面板显示**真数据**（徽标从「演示数据」变「已连接」）

> ⛔ **写者占用状态（2026-09-30 15:4x 更新：已放行 ✅）**：Z12（总开关）/ Z13（工具注册）/ Z14（pointer-events）均已收尾并通过 DSH 独立验收；交接单此前要求的「阶段 A 只读侦查」已由创造模式完成（交付 `tasks/CREATOR-RECON.md`，568 行，结论见其 §4）。
> **→ 现在可以进入阶段 B 实施，写者为创造模式会话（独占）。**

**阶段 A（现在就能做，只读）**：
1. `cordis_inspect_query` → **Slots**：导出本版本槽位表（尤其 `shell.overlay` 的 kind/scope/children）与**当前已注册项清单**；确认 `dispatch.console` 是否在其中。
2. `cordis_inspect_query` → **Service**：导出服务表，查 `dispatch` 是否由本插件 fiber 提供（`wire.host.mjs` 的 `ctx.provide(FACE_NAME, face)`）。
3. `cordis_inspect_query` → **Event** + Tool：记录官方工具注册面（`ctx.tools.register` 的实际可见性与 `defineTool` 契约位置），作为 Z13 的交叉验证。
4. 结论落 `tasks/CREATOR-RECON.md`（含原始查询输出），**不改任何源码**。

**阶段 B（已放行：Z12/Z13/Z14 均已收尾，当前无其他写者）**：

> 🎁 **现成可用的第三方插件模板**（本轮最重要的发现）：profile 里已安装并正常工作的 **`dsh-plugin-whale-pet`**（v0.2.8，GitHub 开源）做的是**和我们完全一样的事** —— 自定义 `remote.<ns>` 命名空间 + typert。
> 已归档为只读参考：`refs/plugin-whale-pet/{package.json,cordis.patch.yml,lib_index.js,lib_typert.host.js,lib_remote.js}`（gitignored）。

| 步骤 | 官方可用形态（whale-pet 实证） | 我们的现状 |
|---|---|---|
| ① 宿主暴露远端面 | `service.typertRemote = Object.freeze({ service, serviceKey: name, namespace: name }); ctx.provide(name, service);`（`refs/plugin-whale-pet/lib_index.js:101-109`） | ✅ `ctx.provide` 已有；❌ **缺 `typertRemote` 标记**（这极可能就是 H1/H2 之争的答案） |
| ② 宿主描述符 | `exports["./typert"]` → `{ package, face:'host', schemas:[{name,create}], invocations:[…], model:{ services:[{ key, exportName, description, summary, tags, members:[{kind:'method',name,signature}], types:[] }], events:[], objects:[] } }`（`refs/plugin-whale-pet/lib_typert.host.js`，仅 847B） | ⚠️ 我们 Z7 手写的 `TYPERT` 需按此对齐（尤其 `model.services[].members`） |
| ③ 客户端调用命名空间 | 顶层 `inject: ['slots','sessions','connection','locale','remote']`，再用 **子 fiber**：`ctx.inject(['remote.whalePet'], scope => …)`（`refs/plugin-whale-pet/lib_client.js`） | ❌ 我们现在是"运行时探测" —— 正解是改成子 fiber 注入（**既有序又不阻塞条目激活**，这正是此前 boot 死锁的解） |
| ④ 客户端侧制品 | `exports["./remote"]` → 携带 descriptor/schema 的客户端制品（whale-pet `lib/remote.js`，41KB，内含 Zod） | ⚠️ 我们的 `wire.client.mjs` 需按此形态产出/对齐 |

- `.data\{locks,logs,state}` 已创建 → 宿主半边**激活成功**；无 `jobs.json` 只是因为还没有 job 落盘。
- 判据（不变）：徽标「演示数据」→「**已连接**」。
- 若 ① 完成后仍不通：做侦查报告 §6 的 **E1 实验**（在 `attachHostWire` 的 catch 里补 `log('warn', …)` + 把 `wire.registered` 写进启动日志），重启后读日志即可分 H1/H2。

**阶段 C（已由标准模式完成，供参考）**：agent 工具注册的官方契约已挖到并存档于 `refs/dsh-tools/`：
`import { defineTool } from '@deepseek-ai/dsh-tools'` + 插件导出 `inject = ['tools']` + `ctx.tools.register(defineTool({name, description, parameters, output, execute}))`（样例：`refs/dsh-tools/tool-fs-example/index.js:261`、`:1176`、`:1212`；契约：`refs/dsh-tools/schema.js:274-330`）。Z13 已据此改造完成，DSH 独立复现 **13/13**（`tools/` 内的探针 + 桩模块路径）。

> ⚠️ **留给创造模式核实的一个真机风险**：`@deepseek-ai/dsh-tools` 是**裸 import**，而我们的包位于 `F:\My Code\zcode-dispatch`（不在 DSH 安装目录内），profile 的 `node_modules` 里也**没有** `@deepseek-ai` 作用域 —— 本地复现必须用解析钩子把它指向桩模块才能走通。
> whale-pet 的宿主半边**不 import 任何 `@deepseek-ai/*`**（只用注入的 `agents` 服务），所以第三方插件能否裸 import 宿主包**没有先例证据**。
> 请用 `Tool.listTools` 核实 `dispatch` 是否真的出现；若**缺席**，修法是给 `loadDefineTool()` 增加**绝对路径回退**（候选：`process.resourcesPath`、`D:\DeepSeek\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-tools\lib\index.js`、env 覆盖），而不是继续猜。

本地已加两道"可见化"防护（提交 `e4cdb4c`）：`createWire()` 全程 try/catch、`DEAD_WIRE` 兜底、以及 **`PanelBoundary`（ErrorBoundary）** —— 任何渲染异常会显示一张「DSH 派发台渲染失败：<msg>」卡片，而不是静默消失。

**按序判定**：
1. `cordis_inspect_query` → **Slots**：确认本版本 `shell.overlay` 的声明（kind/scope/children）与真实名字；确认我们的注册项（id `dispatch.console`）是否出现。**若没出现** → `ctx.slots.inject` 回调未触发或注册被拒，按注册 API 的真实约束对照我们的调用。
2. `plugin_manager`（`list_plugins` / bundle 详情）：确认 `dsh-dispatch` **客户端条目**是否 `activated`；pending/failed 的错误是什么。
3. 若已注册但无内容：看渲染是否抛错（刷新后如出现"渲染失败"卡片，把那行消息带回即可精确定位）；必要时把 `client.js` 顶部先换成**极简 `<div>`**（不依赖 wire/CSS）二分定位"槽位→组件"这条路，再逐步加回。
4. 参考 `refs/SKILL.md`、`refs/references/practices.md`（`wire.view`）、`refs/references/ui-plugin.md`（其中明确：只有需要 overlay 且位置已知时才用 `shell.overlay`）。

### P2（可选）：UI 第二轮（Z11 正在做，创建者会话只需验收）
用户 14:2x 提的四项：① 去掉内置演示数据、改诚实空态；② 通道/派发分区可折叠（默认折叠）；③ 暂停进程可"关闭"；④ 点击进程行展开看派发内容（多进程区分）。已派 Z11 落地；创建者会话只需在页面上点一遍确认（§六 现场判据），有问题按 `tasks/Z11-delivery.md` 清单微调。
另：Z9 修的"布局挤 + 右上角折叠/最小化点不动"也需真机点击确认（`tasks/Z9-delivery.md`）。

---

## 五、硬约束（违反会让 DSH 卡启动、用户丢配置）

1. 客户端 `inject` **绝不**出现自家 `remote.*`；只允许宿主必定提供的 `['slots','remote']`；
2. 客户端 `apply` 全 try/catch（已做，别拆）；
3. 宿主注册失败必须**降级不抛**；
4. 宿主半边改动后**必须完全重启 DSH**（不是刷页面、不是切开关）；
5. **启动失败不要慌**：救援按钮会重置 profile → 用 `profile-backup/README-RECOVERY.md` 两条命令还原（`cordis.patch.yml.USER-ORIGINAL` + `package.json.RESTORED-20260930`）；
6. 不改 宿主仓库（`<HOST_REPO>`）、不写 `$DSH_HOME`（除用户明确要求）、不 npm 依赖、不 `git push`。

---

## 六、验收（可复跑，缺一不可）

```powershell
# 1) 常驻探针（20 项；profile 写入那条按预期放行）
$env:Z2_ALLOW_PROFILE_WRITE='1'; node "F:\My Code\zcode-dispatch\tools\verify-plugin.mjs"
# 2) 单测
cd "F:\My Code\zcode-dispatch\dispatch"; node test/core.test.mjs; node test/channel-retry.test.mjs
# 3) 语法
node --check index.js; node --check client.js; node --check wire.host.mjs; node --check wire.client.mjs
```

**现场判据**（用户在页面上看）：
- 能看到「DSH 派发台」浮层（或至少看到"渲染失败"卡片 = 已定位到渲染期）；
- 徽标 = 「**已连接**」（真数据）／「演示数据」（仅 UI）；
- 宿主 `dispatch\.data\state\jobs.json` 出现（= 派发核心真跑起来）。

---

## 七、交付与沟通

- 交付写 `tasks/Z11-delivery.md`：**改动清单 / 你确定下来的形态（贴代码 + 来源文件:行号）/ 复现命令 + 原始输出 / 未确定项（如实写，宁缺毋编）**；
- 仓库 `F:\My Code\zcode-dispatch` 是独立 git 仓库，一轮一个 conventional commit（`fix(dispatch): ...`）；
- 历史教训：Z7 曾按"看起来对"的形态写 Remote 接线，Z8 才补真实证据 —— **凡涉及宿主/客户端 API 形态，必须以 inspection 或官方包源码为准，不许猜**。

---

## 八、与插件无关的另一条价值路线（参考，不属本单）

只想尽快拿到"ZCode 用免费额度干活、DSH 验收"的结果，可完全不碰本插件：
- `bridge/` + `tools/bridge.mjs`：在 ZCode 客户端「自动化」建一条定时任务（指令复制 `bridge/AUTOMATION-PROMPT.txt`），任务即在**客户端**执行（可用 Start Plan 免费额度），DSH 只读 `bridge/outbox/` 验收；
- 已就绪、待用户点一下；与本单无依赖。

---

## 附：历史进度（Z1–Z10，均已 passed）

| 单 | 内容 | 结论 |
|---|---|---|
| Z1 | 派发核心（dispatcher/quota/CLI/test） | ✅ 真套餐派发实测 |
| Z2 | 插件包（manifest/patch/Host/UI/wire/locale/icon） | ✅ 探针 20/20 |
| Z3 | 套餐额度接入（app-server RPC） | ✅ RPC 打通；**"剩余额度"判定为 CLI 面不可得**（`usage/stats` 语义=本地已用） |
| Z4 | 槽位/主题令牌定证 | ✅ `shell.overlay` 官方浮层标准位；16 个不存在的令牌已换 |
| Z5 | 安装前收尾（文案/额度并入/清产物） | ✅ |
| Z6 | 通道切换 / 暂停 / 续跑 / 交接重跑 / 降级链 | ✅ 探针 22/22（修复了 `parentJobId/attempts` 克隆缺陷） |
| Z7 | `wire.*` 接成真实通道（静态证据） | ⚠️ 传输层/描述符/面方法完成；**最后一跳未定**（如实申报） |
| Z8 | 补最后一跳（typert 三件套证据） | ✅ inject + `$mount` + `bindTypertRemote` 形态落地；运行时终验待装配 |
| Z9 | UI 两处硬 bug（按钮点不动 / 布局顶满） | ✅ 守卫 + 8 条 CSS；真机点击待验 |
| Z10 | Config 改 Standard Schema（修宿主激活失败） | ✅ 主路径 + 降级路径双证 |

**两次启动事故（都在本仓库 `pitfalls.md`）**：① 裸 JSON Schema 导致宿主不激活；② `inject` 自声明 `remote.dispatch` 导致 web boot 死锁。均已修复并加了常驻判据。
