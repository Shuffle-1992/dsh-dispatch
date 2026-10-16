# 交接：DSH 派发台 —— 下一步（OpenCode 双引擎已落地，待生效验收）

> 生成：2026-10-16 ｜ 上一会话：**ZB-44（双引擎）＋ ZB-45（显式 auto 放行）交付完成**，
> 工作树**未提交**（13 个改动 + 13 个新增，见 §2）。
> **给下一个会话的 Agent**：先读本文 §0/§1/§2，再动手。
> 执行器实测细节见根目录 `OPENCODE-DISPATCH-HANDOFF.md`；本轮完整交付说明见 `tasks/ZB-44-delivery.md`。

---

## 0. 一分钟上手（路径与名字）

| 项 | 值 |
|---|---|
| GitHub 仓库 | `https://github.com/Shuffle-1992/dsh-dispatch` |
| 本机仓库根 | `F:\My Code\dsh-dispatch` |
| 插件目录 | `dispatch/`（npm 包名/bundle id = `dsh-dispatch` / `dispatch`） |
| agent 工具名 | `dispatch` |
| ZCode 执行器 | `collab-kit/zcode-run.mjs`（**未改**） |
| **OpenCode 执行器（新）** | `collab-kit/opencode-run.mjs`（+ `.cmd` shim） |
| **行协议唯一权威（新）** | `collab-kit/run-line-protocol.mjs` |
| OpenCode CLI | `1.19.2`，`%APPDATA%\npm\opencode.cmd`；`opencode models` ⇒ 12 个免费模型（0 凭据） |
| profile | `C:\Users\Administrator\.dsh\profiles\desktop` |

---

## 1. 这一轮做完了什么（**别重做**）

### ZB-44 双引擎（渠道内集成，**不做双 tab**）
- 「通道」抽象升级为**执行目标（带 `engine`）**：`zcode` / `opencode`。
- 通道清单：zcode 10 条 + **opencode 12 条**（**探测式**，不写死枚举；探测失败 ⇒ OpenCode 为空、
  ZCode 照常），顶层带 `engines` / `opencodeVersion`。
- 引擎路由判据（`run-line-protocol.mjs`，core/CLI 共用）：显式 `spec.engine` > `provider` 形如
  `opencode/<model>` > 默认 `zcode`（**既有调用方零改动**）。
- **行协议参数化**：zcode=`[zcode-run]` / opencode=`[opencode-run]`；除前缀与两条引擎差异字段
  （`reasoning-levels`/`reasoning-level` vs `variants`/`variant`）外**逐字相同** ⇒ core 的解析、
  暂停分类、心跳、思考强度回显对两个引擎同时生效。
- **每引擎并发**：`maxConcurrentOpenCode`（默认 2，与 `maxConcurrent` 全局上限并存），
  OpenCode 满员**不阻塞** ZCode 队列（有专门断言）。
- 跨引擎降级链可混排；**换引擎＝新会话**（不 resume 原引擎 session）。
- 客户端：通道下拉按引擎 **optgroup** 分组 + 引擎专属动态提示 + 进程行引擎徽标。

### ZB-46 面板两个通道过滤开关（用户要求）
- 「**仅看可用**」（默认**开**）/「**仅看免费**」（默认**关**），落在「通道」分区，作用于
  「通道」与「自动降级目标」两处下拉；**纯展示层**（不发 remote 调用、不改调度）。
- 「免费」判据 = `engine==='opencode'`（12 个免费模型）或 `account:<family>-start-plan`；
  **不含** `personal`（个人 Key = 用户自己的付费额度）。
- 关键不变量：**当前选中值始终可渲染** —— 掉线标「不可用：原因」，仅被过滤标「当前选择」（不谎报）。
- 真实清单实测：默认 17/22 条；两个都关 22/22；仅看免费 13/22（= Start Plan + 12 个 OpenCode 免费模型）。
- 开关状态存 `localStorage`，刷新保留。

### ZB-47 面板「进程」有时空白 / 卡在「连接中」（真机事故）
- 根因：宿主 `snapshot()` **内联 await 通道探测**（spawn 子进程，实测 **6.7s**，缓存仅 5s），
  而面板 wire 是 `await snapshot` 之后才 emit ⇒ 那一拍整包快照发不出去 ⇒ 进程/用量/开关一起空白。
- 修：宿主新增 `cachedChannels()`（**同步只读缓存 + 后台刷新 + 在途去重**），快照路径**绝不 await 探测**；
  客户端 `tick` 加 8s 兜底超时 + **沿用上一包好快照**（不再被一次抖动刷成「暂无进程记录」）。
- 实测：`snapshot()` 冷启 **39ms**（原 ≈3s）、连续 20 次最慢 **4ms**；同份快照带 **47 条 job + 开关状态**。
- 复跑：`node tasks/snapshot-latency-check.mjs`

### ZB-48 通道清单加载失败被静默吞掉（真机事故）
- 根因：`channels()` 只在挂载时拉一次，失败被 `{ok:false}` 静默丢弃、且无重试 ⇒ 三个下拉全「不可用：-」。
- 修：失败**可见**（显示 wire 原始错误）+ **`snapshot.channels` 兜底回填**（仅空清单时采纳）+ 空态显示"加载中"；
  宿主侧失败结果走 **1s 短 TTL**（成功 5s）⇒ 每秒轮询自动重试。

### ZB-49 分区顺序：用量移到最末（用户要求）
- 顺序：**通道 → 进程 → 单写者/文件锁 → 用量**。分区 id 不变 ⇒ 折叠状态与持久化键不受影响。

### ZB-45 显式权限放行（用户拍板"方案 B"）
- `spec.auto`（工具参数 `auto`，默认 **false**）⇒ 只有显式 `true` 才给执行器加 `--auto`；
  `job.autoApproved` + 面板「已放行权限」徽标 + 执行器 `auto=on` 行 ⇒ **放行永远可见**。
- `retry`（同通道 resume 与交接重跑）**沿用**放行级别，`opts.auto` 可显式覆盖。
- `auto:true` 配 zcode 引擎 ⇒ 可读 TypeError（不静默）。

---

## 2. 当前工作树（**未提交**）

**改动 11 个文件**（`git diff --stat`：+902 / −135）：
`.gitignore`、`dispatch/README.md`、`dispatch/bin/dispatch.mjs`、`dispatch/client.js`、
`dispatch/core/dispatch-core.mjs`(+671)、`dispatch/index.js`、`dispatch/locale/{zh,en}.json`、
`dispatch/test/core.test.mjs`、`dispatch/test/fallback-ui.test.mjs`、`dispatch/wire.host.mjs`

**新增 13 个文件**：
`collab-kit/run-line-protocol.mjs`、`collab-kit/opencode-run.mjs`、`collab-kit/opencode-run.cmd`、
`dispatch/test/{line-protocol,engine-routing,engine-ui,wire-engine,opencode-executor,host-config}.test.mjs`、
`dispatch/test/fixtures/fake-opencode-runner.mjs`、`tools/verify-opencode.mjs`、
`tools/oc-concurrency-probe.mjs`、`tasks/e2e-opencode-dispatch.mjs`、`tasks/zb45-auto-gate.mjs`
（+ `tasks/ZB-44-delivery.md`、本文件）

> ⚠️ 未提交原因：本轮所有改动**只在本机工作树**，请与用户确认后再 `git add/commit`
> （建议 commit message：`feat(ZB-44/45): 派发台接入 OpenCode（双引擎）+ 显式 auto 放行`）。

---

## 3. 下一步（按优先级，**用户侧动作优先**）

### ZB-51 产品决策（**用户定死，别再改回去**）

1. **ZCode 只留 2 条通道**：`plan`（默认套餐）与 `account:bigmodel-start-plan`（免费额度）。
   其余 8 条（`personal` / `builtin:*` ×6 / 一个 UUID 路由）**从清单里彻底剔除**。
   实现：`dispatch-core.mjs` 的 `ZCODE_CHANNEL_ALLOWLIST` **白名单**（用白名单而非黑名单 ——
   清单来自 runner 解析、随账号/版本变化，白名单保证"新路由不会自己冒出来"），
   剔除会在 `warnings` 里**留痕**（不静默）。
   ⚠️ 只过滤**派发台清单**，**绝不改用户 ZCode 自己的配置文件**（`~/.zcode/v2/config.json`）。
   ⚠️ 白名单只约束"清单里列什么"，**不拦截显式调用**（显式传 `provider:'personal'` 仍可用）。
2. **通道下拉按引擎折叠**（"通道选引擎、模型里选模型"）：
   · `opencode`（12 个模型）/ `qoder`（15 个模型）⇒ 各折叠成 **1 条引擎通道**，模型进「模型」下拉；
   · `zcode` ⇒ **不折叠**（它的 2 条是不同计费路由）。
   最终「通道」下拉 = **4 条**：`ZCode·plan` / `ZCode·免费额度` / `OpenCode` / `Qoder`。
   实现：`client.js` 的 `foldChannels()`（**只在展示层折叠，core 的"每模型一通道"数据不变**；
   工具 / 降级链 / 快照都不受影响）。旧存值 `opencode/xyz` 由 `resolveFoldedChannel()` 映射回折叠条目。

### P0 —— 让改动**真的生效**（否则用户看不到任何变化）
| 改动位置 | 生效方式 |
|---|---|
| `dispatch/client.js`、`dispatch/locale/*` | **刷新页面** |
| `dispatch/index.js`、`wire.host.mjs`、`core/*` | **完全退出 DSH 再启动**（cordis `_reload` 不重新 import） |
| `collab-kit/*` | 下次派发即生效（每次 spawn 新进程） |

> 本会话**没有**重启 DSH、**也没有**验证浏览器里的真实面板渲染（DSH GUI 无法被内置浏览器自动化驱动——
> 它是宿主应用本身）。客户端改动由 `dispatch/test/engine-ui.test.mjs`（114 项源码锁 + 双语文案）
> 离线兜住；**真机目视仍未做**，这属于下一个会话的第一件事。

### P0 补充（ZB-51 之后）—— 重启后应能立刻看到

> ⚠️ **本会话改了两批 host 代码，分两次重启才都生效**：
> · 第一批（01:54 重启后生效）：`wire.host.mjs` 透传 `engineDetail`、`ENGINES` 加 qoder、通道清单含 qoder。
> · **第二批（尚未生效，需再重启一次）**：`dispatch-core.mjs` 的 **provider/model 错配修复**（坑 15）、
>   **Qoder 行协议补充**（坑 16：credits / contextRatioLine / knownInfo）。
>   判据：DSH 进程启动时间 < 该文件 mtime ⇒ 该批未生效。

重启 DSH + 刷新页面后，通道分区**两个下拉之上**会出现一条「**引擎**」状态条，形如：

```
引擎： ● ZCode · 客户端自带 · v0.16.9 · 已登录   ● OpenCode · CLI · v1.19.2 · 登录态未知   ● Qoder · CLI · v1.1.73 · 已登录
```

（`●` 可用 / `○` 找到但未登录 / `×` 未找到；悬停显示完整 `summary` + `reason` + 登录依据。）
通道下拉会多出第三组「Qoder 通道」（15 个模型，`qoder/<模型名>`）。
**若这条状态条没出现**：多半是 DSH 未真正重启（`wire.host.mjs`/`core/*` 改动必须**完全退出再启动**），
或宿主把 `engineDetail` 丢了（`wire.host.mjs` **四处**透传点已加：`cachedChannels` / `channelsCached` / 快照 / 工具 `case 'channels'`）。

### P1 —— 真机验收清单（建议逐条留档）
1. 重启 DSH → 打开派发台面板 → 通道下拉应出现两组：`ZCode 通道` / `OpenCode 免费模型`。
2. 选中一条 `opencode/<model>` → 引擎提示行应显示 OpenCode 专属说明（不支持 mode/memoryBench、`--variant`、默认不放行）。
3. `dispatch action=channels` ⇒ 22 个通道、每个带 `engine`、顶层 `engines`/`opencodeVersion`。
4. **真派发一次**：`dispatch action=dispatch { provider:'opencode/deepseek-v4.1-flash-free', prompt:'Reply with exactly: PONG', lock:'none', timeoutMin:3 }`
   ⇒ job 变 `done`、面板显示引擎徽标、`token` 用量有数字。
   ⚠️ 派发**需要总开关打开**（2026-10-16 21:03 查是**关**的：`dispatch action=status` 先看）。
5. 面板进程行：`auto` 任务显示「已放行权限」徽标（可造一个 `auto:true` 的派发验证）。

### P2 —— 可选增强（**没做，但地图已铺好**）
- **profile 显式配置**（机器专有路径**不要**进 `cordis.patch.yml`）：如需固定路径，在
  `~/.dsh/profiles/desktop/cordis.patch.yml` 的 `dispatch` 条目加
  `opencodeRunnerPath: 'F:\My Code\dsh-dispatch\collab-kit\opencode-run.mjs'`（留空也能工作）。
- **路线 B（常驻 `opencode serve` + SSE）**：`OPENCODE-DISPATCH-HANDOFF.md` §4 有设计；当前路线 A（按需 spawn）
  已闭环，路线 B 是性能/实时性优化，不是必需品。
- **token 用量喂 `dsh-cost-meter`**：OpenCode 的 `usage` 已进 job（`job.usage`），接线尚未做。
- **`engines` 派生**：当前顶层 `engines` 是静态 `['zcode','opencode']`（即使 OpenCode 探测失败）。
  若面板想只显示"实际有通道的引擎"，改派生即可（core 一行）。
- **`auto=on` 正式登记为协议行**：目前作为未登记行透传（靠 `job.autoApproved` 交叉核对）。
  若将来面板要直接依赖它，需**同时**改 `run-line-protocol.mjs` 与 core 解析器（协议文件里写明了这条义务）。

---

## 4. 本轮踩到/修掉的坑（防复发）

| # | 坑 | 教训 |
|---|---|---|
| 1 | **执行器 15s 兜底误杀慢模型** | `glm-5.3-flash-free` 冷启 ~14.2s，而执行器原有一段**独立于 `--timeout-min`** 的 15s 强制收尾 ⇒ 慢而正常的调用被判成挂死（exit=1、零输出，像"静默失败"）。**兜底必须与 `--timeout-min` 挂钩**，且 `forced` 与"真超时"要在 result/done 行分开表达。教训：**任何短于被测对象真实耗时的兜底都是误杀** |
| 2 | **"并发 opencode 会静默失败"是半对的结论** | 独立实测 2/2 并发**成功**；真实危险是**同一进程链里在 run 中再起一个 opencode（比如探测）**。执行器已把元数据探测改成**顺序+缓存**。教训：对照实验要**单变量**，否则会把"自己的 bug"记成"上游行为" |
| 3 | **wire 的 spec 白名单会静默吞参数** | 工具 schema 加了 `engine`，但 `wire.host.mjs` 的 `for (const k of [...])` 白名单没加 ⇒ 参数被静默丢弃（工具文档承诺了却不生效）。**加工具参数必须同时过 wire 白名单**，并加断言（`wire-engine.test.mjs` 已钉） |
| 4 | **异步 persist 与测试收尾竞态** | dispatcher 的 `persist()` 是异步写盘（`jobs.json.<pid>.<ts>.tmp` + rename）；测试 `test.after` 直接删 workRoot ⇒ ENOENT ⇒ uncaughtException ⇒ **断言全绿但退出码 1**（既有 `$LASTEXITCODE` 判定误报）。**收尾要先 kill 未落地 job、等落地、再删目录** |
| 5 | **optgroup 会打破"平铺 option"测试** | 分组改动让 `(sel.children).filter(type==='option')` 取不到 option。`fallback-ui.test.mjs` 新增 `flattenOptions()` 统一展开 optgroup（单一源 helper） |
| 6 | **自派发/测试会把运行期产物写进仓库** | 执行器把日志落在**工作目录**下的 `collab/logs/`；已加 `.gitignore: collab/logs/`、`dispatch/collab/logs/` |
| 7 | 老坑仍在（详见 §5） | 改名保护串四种形态、BOM、junction、PowerShell 读 UTF-8 乱码 |

### 重启后真机验收又抓到的四个问题（**只有"真的派一次"才暴露**）

> ⚠️ 另加 **TDZ 类**（面板白屏级）：见下方 21–23。

| # | 坑 | 教训 |
|---|---|---|
| 15 | **换通道时注入了默认通道的 model**（最危险） | 用户在面板把默认通道设成 `opencode/<model>`，然后 `dispatch({provider:'qoder/Fast'})` ⇒ provider 换成了 qoder，`dispatch()` 却仍把**默认通道的 opencode 模型**塞进 spec ⇒ **provider/model 错配**。Qoder 收到不可用的模型后**静默退回 `Auto`**（只有一行 stderr，任务照样 `done`，`model` 字段还回显 `Auto`）——**用户以为用的是 Fast**。修法：**模型必须与 provider 同属一个通道**（`providerChanged` 判据）。已加回归锁。**通用教训：任何"用默认值补齐"的地方，都要问"用户是不是已经换了上下文"** |
| 16 | **执行器新加的行没进 core 的行协议** | `permission-mode-requested=` / `tools count=` / `credits` / `context used=- (-% of ?)` 落进 `parseWarnings`（显示成 "unparsed line"，像解析失败，其实是**已知信息**）。已补 `credits` / `contextRatioLine` 正则 + 扩充 `knownInfo`，并把 `credits`/`contextRatio`/`durationMs` 落到 job。**教训：新增输出行必须同步 core 的 `RES` 表**（协议文件注释里已写"新增引擎时的义务"，我只做了一半） |
| 17 | **`createActionHandler` 与 `createRemoteFace` 是两个作用域** | 在 action 处理器里写 `channelsCache = …`（那是 `createRemoteFace` 的局部变量）会**运行时** ReferenceError，而 `node --check` **查不出来**（闭包内引用语法合法）。已加花括号配平的作用域契约锁。**教训：改 `wire.host.mjs` 先确认自己在哪个函数里** |
| 18 | **同一份数据的"两条出口"要各自检查** | `engineDetail` 修了面板路径（`impl.channels()` / 快照）却**漏了工具路径**（`case 'channels'`）—— 只有"重启后真的调用一次 `action=channels`"才暴露。凡"同一份数据两条出口"，两条都要断言 |
| 19 | **测试夹具复制了"真执行器"⇒ 挂死** | `qoder-routing.test.mjs` 的假包把**真的 `opencode-run.mjs`** 复制了进去，而 core 真探测 OpenCode 时会 spawn 它 ⇒ 它去起**真的 opencode**（临时服务）⇒ 进程卡在 `opencode-run.mjs --`，**整个测试挂死不退**（实测：后台全量跑 10+ 分钟无输出）。改为写入**假 opencode 执行器**。**通用教训：测试夹具里任何一个"会被 spawn 的脚本"都必须是假的**，否则既违反"不碰真 CLI"的纪律，又会挂死测试 |
| 20 | **`-` ⇒ `null` 是行协议契约，不能被新正则破坏** | 我给 Qoder 加 `contextRatioLine` 时用了"非 null 才带上字段"的写法 ⇒ `turnCount` 从 `null` 变成 `undefined`，`core.test.mjs` 立刻失败。**`-` 必须被显式记为 `null`**（"上报为空"与"没上报"是两件事）。教训：**加宽正则时必须保持既有行的返回契约逐字不变** |

### TDZ（"声明前使用"）—— **面板白屏级**，一个晚上踩了两次 + 发现一处既有 latent bug

`client.js` 是**普通脚本**（无模块系统、不能拆文件），大量逻辑在组件函数体内用 `const` 定义。
在定义之前调用它 ⇒ `ReferenceError: Cannot access 'X' before initialization` ⇒ **面板直接白屏**。
**`node --check` 只查语法，查不出来**；`grep` 也难查。已加**永久门禁** `dispatch/test/client-tdz.test.mjs`。

| # | 坑 | 教训 |
|---|---|---|
| 21 | **`sel` 用了后置定义的 `foldChannels`** | 我把折叠 helper 写在使用点之后（第 2168 行定义、2039 行就用）⇒ 面板必白屏。**新增 helper 时先想"它在哪一行、谁先谁后"** |
| 22 | **`foldChannels` 内部用了组件内后置的 `engineOf`** | 组件内的 `const` 只在该次调用内有效，而 `foldChannels` 定义在前、`engineOf` 定义在后 ⇒ 仍 TDZ。**解法：把跨组件复用的 helper 提升到模块级**（`KNOWN_ENGINES` / `engineOf` / `engLabel` / `jobEngineOf` 已移到 605–615 行）。这次是 `fallback-ui.test.mjs` 的**真 DOM 渲染**抓到的 —— 说明"真渲染测试"不可省 |
| 23 | **既有 latent TDZ：`normTargets` / `fallbackShape`** | 它们定义在 1820/1839 行，却被 `demoWire()` 的 `fallbackGet`/`fallbackSet`（1597 行）引用 ⇒ **demo 模式一旦调用降级接口就 ReferenceError**。这是**本会话之前就存在**的 bug，被新门禁顺带抓出。已上移到 `demoWire()` 之前 |

### ZB-51（三引擎自动发现 + Qoder 接入）本会话新踩的坑

| # | 坑 | 教训 |
|---|---|---|
| 8 | **加引擎必须同步所有"按引擎分支"的地方** | 给 `ENGINES` 加 `qoder` 后，`APPLIED_RE_OF[e](p)` 在**热路径**抛 `is not a function`（漏同步 `LEVELS_KEYWORD`/`APPLIED_RE_OF`/`APPLIED_MAPPER`）⇒ 整条通道清单与解析全废。同类漏项还有：客户端二元分组 `c.engine === 'opencode' ? … : 'zcode'`、`resolveEngineOf()` 漏 `isQoderId()`（⇒ **Qoder 通道静默落到 ZCode 执行器**，模型还被改写）、host 忘记透传 `engineDetail`。**这些都"不报错、只是行为错"**，已全部补契约锁。完整同步点清单见 `tasks/ZB-51-engine-autodiscovery.md` |
| 9 | **`.cjs` / `.cmd` 不能直接 spawn** | Windows 下直接 spawn `.cjs` → `EFTYPE`；`.cmd` → 也 `EFTYPE`（须经 shell）。ZCode 自带 CLI（`zcode.cjs`）与 Qoder 测试假 CLI 都踩过。已抽 `spawnTarget()` 作为**唯一权威**（`.cjs/.mjs/.js` 前置 `node`；`.cmd/.bat` 经 shell） |
| 10 | **`setTimeout(...).unref()` 会吞掉退出码** | `setTimeout(() => process.exit(code), 300).unref()` —— `.unref()` 让定时器**不保持事件循环存活**，进程在 300ms 前自然退出 ⇒ `process.exit(code)` 永不执行 ⇒ **报错路径 exit 0**（core 会当成功收尾）。改为同步 `process.exit(code)`。**只在"报错路径"暴露**（正常路径恰好也是 0），靠测试里那条"失败退出"断言抓出 |
| 11 | **PATH 同名多命中 + 登录态误判** | Windows npm 目录里 `opencode`（无扩展名 shell 脚本）会先命中 ⇒ spawn `EINVAL`；须让**可执行扩展名优先**。另：`~/.local/share/opencode/` 里**没有** `auth.json`（只有 `opencode.db`）而 CLI 正常 ⇒ 不能据此断言"未登录"；Qoder 更不能看 `.auth/` 目录（里面只有 `machine_id`），唯一可靠判据是 **`--list-models` 能否跑通** |
| 12 | **用 PowerShell `Set-Content` 改文件会毁掉中文** | UTF-8 被按 GBK 重读再存 + 加 BOM + **吞换行** ⇒ 乱码**不可逆**（部分字节被换成 `?`）。本会话把 `engine-routing.test.mjs` 弄坏后只能通读原逻辑重写。**改文件一律用 Node `writeFileSync`**，绝不用 PowerShell 重定向/Set-Content |
| 13 | **免费层不要并发派多个长任务** | 两个 opencode 长任务并发时**双双卡在 `spawn`、`chars=0`**；且**完全绕过派发台**直接手跑 `opencode run` 同样挂住 ⇒ 是**上游限流**，与派发台无关（`opencode --version` 仍秒回）。建议 `maxConcurrentOpenCode` 判 1–2，不要用并发"提速" |
| 14 | **派发台对卡死任务的观测是有效的** | 上述卡死表现为 `stage=spawn` / `elapsed` 持续增长 / `chars=0` / 无 session ⇒ **能一眼看出"没起来"而不是"在思考"**。这本身是平台能力的正向验证 |

---

## 5. 老坑速查（前几轮的真事故，**依然成立**）

1. **保护串四种形态**：源码里是双反斜杠（`'F:\\My Code\\…'`），改名脚本必须覆盖 双反斜杠/单反斜杠/正斜杠/URL 四种。
2. **GitHub URL 与包名是两件事**，别一起改。
3. **BOM 会让 JSON.parse 抛 ⇒ 安全开关 fail-open**；写 JSON 一律用 Node `writeFileSync`（不要 PowerShell `Set-Content -Encoding UTF8`）。
4. **Windows junction 不能 `rmSync`**：用 `cmd /c rmdir`，删后立刻验证目标仍在。
5. **改根目录名会打断 `node_modules` 里的 junction**，要全量扫悬空链接。
6. **校验中文 JSON/YAML 一律用 Node**（PowerShell 按 ANSI 读会乱码、解析失败）。
7. **闸门位置**：只读探测必须能过闸（冻结时面板仍要看得到通道）；真实派发必过闸；闸门在凭据读取之前。
8. **改 bundle id 要同步四处**（profile package.json bundles + 依赖 link + `cordis.patch.yml` 的 id/name + junction 目录名）。

---

## 6. 验证命令（可复跑）

```powershell
# 0) 前置
opencode --version                                                                   # 1.19.2
node 'F:\My Code\dsh-dispatch\collab-kit\opencode-run.mjs' --list-models              # 12 行裸 id

# 1) 离线全量（期望 37 文件 0 失败）
cd 'F:\My Code\dsh-dispatch\dispatch'
$fail=0; $files=0
Get-ChildItem test -Filter '*.test.mjs' | ForEach-Object { $files++; node $_.FullName *> $null; if ($LASTEXITCODE -ne 0) { $fail++; Write-Host "FAIL($LASTEXITCODE) $($_.Name)" } }
Write-Host "文件=$files 失败=$fail"

# 2) 常驻探针
cd 'F:\My Code\dsh-dispatch'
node tools/verify-plugin.mjs        # 23 项 0 失败
node tools/verify-opencode.mjs      # 10 项：PASS 9 / SKIP 1（加 --live 才真调免费模型）

# 3) 端到端实弹（**真调免费模型**，约 1 分钟：通道清单 + PONG + 写文件 + 失败路径 + 降级目标）
node tasks/e2e-opencode-dispatch.mjs

# 4) auto 行为门禁（离线，假执行器抓 argv）
node tasks/zb45-auto-gate.mjs       # 11 PASS / 0 FAIL

# 5) 通道过滤开关判据（真实清单：22 条 ⇒ 默认 17 / 两个都关 22 / 仅看免费 13）
node tasks/filter-check.mjs

# 6) 快照延迟门禁（ZB-47：snapshot() 不得在通道探测上阻塞）
node tasks/snapshot-latency-check.mjs

# 7) 并发实验（回答"上限该设几"）
node tools/oc-concurrency-probe.mjs 2

# 6) 总开关（动手前先查）
#    dispatch action=status
```

**最近一次全绿记录（2026-10-16 22:1x）**：离线 37 文件 0 失败；`verify-plugin` 23/0；
`verify-opencode` 9 PASS/0 FAIL/1 SKIP；e2e 全绿（`glm-5.3-flash-free` 写文件在那个 15s BUG 修复后已通过）；
`tasks/filter-check.mjs` 判据全 PASS；`tasks/zb45-auto-gate.mjs` 11 PASS。

---

## 7. 必读文档

| 文档 | 用途 |
|---|---|
| `tasks/ZB-44-delivery.md` | **本轮完整交付说明**（决策、改动清单、证据、硬约束逐条、残留风险） |
| `OPENCODE-DISPATCH-HANDOFF.md` | OpenCode 执行器实测细节（CLI 参数、事件谱、路线 A/B、禁做事项） |
| `collab-kit/run-line-protocol.mjs` | **行协议唯一权威**（新增引擎/新增行格式必须先改它） |
| `pitfalls.md` | DSH 插件两次启动事故（config 必须 Standard Schema；客户端 inject 不能自声明自家 remote 命名空间） |
| `dispatch/README.md` | 插件自身文档（配置表、双引擎节、总开关契约、思考强度、降级链） |

---

## 8. 给下一个会话的第一句话（可直接复制）

> 仓库在 `F:\My Code\dsh-dispatch`。上一轮已完成 **OpenCode 双引擎（ZB-44）+ 显式 auto 放行（ZB-45）**，
> 改动**未提交**（13 改 + 13 新）。先读根目录 `NEXT-SESSION-HANDOFF.md` 与 `tasks/ZB-44-delivery.md`，
> 然后按 §3 做**生效验收**：重启 DSH（宿主半边改动要完全重启）、刷新页面看通道下拉是否分成
> `ZCode 通道` / `OpenCode 免费模型` 两组，并在总开关打开后真派发一次 `opencode/deepseek-v4.1-flash-free`。
> 离线全量测试当前 37 文件 0 失败，可先复跑确认基线。
