# ZB-44 / ZB-45 交付：派发台接入 OpenCode（**双引擎**）

> 生成：2026-10-16 ｜ 依据：根目录 `NEXT-SESSION-HANDOFF.md` §3、`OPENCODE-DISPATCH-HANDOFF.md`
> 一句话：把「通道」这个既有抽象升级为**执行目标（含引擎）**，新增本地真实 OpenCode 执行器，
> 让派发台能派 ZCode **和** OpenCode 的 12 个免费模型，并保持进程列表 / 文件锁 / 队列 /
> 用量 / 唤醒通知 / 暂停分类 / 降级链**全部与引擎无关**。

---

## 0. 结论（先说结果）

| 项 | 状态 | 证据 |
|---|---|---|
| 通道清单带引擎（zcode 10 + opencode 12） | ✅ 真机 | `listChannels()` ⇒ `engines=[zcode,opencode]`、`opencodeVersion=1.19.2`、warnings=[] |
| 派发 → 真实 OpenCode → 回传（prompt） | ✅ 真机 | `state=done` `engine=opencode` `sessionId=ses_…` `usage{in:6296,out:3}` `context 8091/200000`，result.response=`PONG`，cost=0 |
| 派发 → 真实 OpenCode → 改文件（Agent 真干活） | ✅ 真机（deepseek 模型） | 经执行器写文件成功、内容一字不差（见 §4.3） |
| 慢模型（glm-5.3-flash-free，冷启 ~14.2s） | ⚠️ 抓到并修复一个**误杀** BUG | 执行器原 15s 兜底会把慢而正常的调用判成挂死（ZB-45 修复，见 §4.4） |
| 失败路径（不存在的模型） | ✅ | exit 1、上游原始错误**原样透传**、不崩、记 `unknownEvents` |
| 跨引擎降级链可混排 | ✅ | `setFallbackTarget({provider:'opencode/…'})` 落盘为单目标，可用性来自同一份探测清单 |
| 离线测试全量 | ✅ 见 §4.1 | 37 个测试文件 0 失败（含 4 个新增契约测试） |

---

## 1. 方案决策（**已与用户确认，别再改**）

1. **渠道内集成，不做双 tab**（用户已定）：引擎是「通道」的属性。进程列表 / 锁 / 队列 / 用量 /
   唤醒 / 通知 / 降级链全部与引擎无关，拆两个 tab 会把进程列表与降级链割裂，
   **丢掉「跨引擎降级」这个最大增量**。引擎专属设置靠「按选中通道动态显示」解决。
2. **只用免费模型**（用户已定）：12 个 `opencode/*` 免费模型（0 凭据可跑）。
3. **免费模型清单探测式获取**（不是写死枚举）：每次经执行器 `--list-models` 探测；
   探测失败 ⇒ OpenCode 通道为空 + 可读 warning，**ZCode 通道照常**（绝不让 OpenCode 不可用拖垮整份清单）。
   —— 这条纪律来自 ZB-31 的教训（档位表变了但代码写死）。
4. **`--auto`（权限放行）默认关，只有显式 `auto: true` 才开**（用户拍板方案 B，ZB-45）。
   即使实测"写文件在非交互下不需要放行"，仍保留显式开关：需要时能放行，默认**不放行**才是安全默认。

---

## 2. 架构：行协议参数化（**本轮的地基**）

原 core 把执行器输出行写死成 `[zcode-run] …`。接入第二个执行器时，若让 OpenCode 也打
`[zcode-run]`，日志与面板会把两个引擎混为一谈。故新增**零依赖叶子模块**：

| 文件 | 作用 |
|---|---|
| `collab-kit/run-line-protocol.mjs` | **行协议唯一权威**：引擎枚举、前缀（zcode=`[zcode-run]` / opencode=`[opencode-run]`）、`inferEngine` / `normalizeEngineSpec` / `isOpenCodeId`、行语法全量说明 |

- 除**前缀**与两条**引擎差异字段**外，两种引擎的行语法**逐字相同** ⇒ core 的解析、暂停分类、
  进度心跳、思考强度回显对两个引擎同时生效，不需要分叉实现。
- 引擎差异字段：
  - zcode：`reasoning-levels <model>=<a,b,c>`（档位表）、`reasoning-level=<lv> target=<p>/<m>`（注入确认）
  - opencode：`variants <model>=<a,b>`（= `--variant` 档位表）、`variant=<v> model=<m>`（生效确认）
- **未知事件/未知行不崩**：OpenCode 的 NDJSON 里未观测到的 `type` 一律降级为原始透传；
  带已知前缀但认不出的行返回 `null`（记 `parseWarnings`）；无前缀普通行返回 `{}`（语义与改造前一致）。
- 防漂移：`dispatch/test/line-protocol.test.mjs` 断「core 的前缀集合恰好覆盖协议文件的前缀」，
  并断「同一组行加两种前缀 ⇒ 解析结果逐字段相等」。

### 2.1 引擎路由（谁决定用哪个执行器）

判据顺序（**不猜**，实现在协议模块里、core 与 CLI 共用同一函数）：

1. 显式 `spec.engine`（合法值 `zcode|opencode`）；
2. `spec.provider` 形如 `opencode/<model>` ⇒ opencode（「通道即执行目标」的落点）；
3. 都没命中 ⇒ 默认 `zcode`（**既有调用方零改动**）。

`normalizeEngineSpec()` 把 `provider='opencode/glm-5.3-flash-free'` 规整成
`{engine:'opencode', provider:'opencode', model:'opencode/glm-5.3-flash-free'}`
（显式 `model` 优先）。通道→引擎的同步查询靠 `<workRoot>/state/channels.json` 快照
（`startJob()` 是同步函数，必须能在不 await 的情况下把用户选的通道映射到引擎；解析失败 fail-open = zcode）。

---

## 3. 改动清单（按文件）

### 3.1 新增

| 文件 | 说明 |
|---|---|
| `collab-kit/run-line-protocol.mjs` | 行协议唯一权威（见 §2） |
| `collab-kit/opencode-run.mjs` | OpenCode 执行器：spawn `opencode run --format json`、NDJSON 聚合、按协议打行、产物落盘、超时/取消、只读探测子命令（`--list-models` / `--with-variants` / `--version`） |
| `collab-kit/opencode-run.cmd` | Windows shim（`%~dp0` 范式，纯 ASCII） |
| `dispatch/test/line-protocol.test.mjs` | 协议契约锁（39 项） |
| `dispatch/test/engine-routing.test.mjs` | core 引擎路由/并发上限 |
| `dispatch/test/engine-ui.test.mjs` | 客户端分组/徽标契约（46 项，源码锁 + 双语文案） |
| `dispatch/test/wire-engine.test.mjs` | **wire ⇒ core ⇒ 执行器**全链路（6 项，含真实 spawn 假执行器 + argv 形态断言） |
| `dispatch/test/opencode-executor.test.mjs` | 执行器离线测试（25 项，含真实抓取的 NDJSON fixture） |
| `dispatch/test/host-config.test.mjs` | Host 侧配置/契约（59 项） |
| `dispatch/test/fixtures/fake-opencode-runner.mjs` | 假 OpenCode 执行器（env 开关矩阵） |
| `tools/verify-opencode.mjs` | 可复跑自检 CLI（10 项，默认离线，`--live` 才真调） |
| `tools/oc-concurrency-probe.mjs` | 并发实验脚本（回答"并发上限该设几"，见 §4.5） |
| `tasks/e2e-opencode-dispatch.mjs` | 端到端实弹脚本（真实免费模型，见 §4.2） |

### 3.2 修改

| 文件 | 改动 |
|---|---|
| `dispatch/core/dispatch-core.mjs` | 行协议按引擎参数化；`engine` 落 job；OpenCode 通道探测（`--list-models`）；通道→引擎快照持久化；`buildOpenCodeArgs()`；`startJob()` 按引擎选执行器（缺执行器 ⇒ 可读失败，不 spawn 不崩）；**每引擎并发上限**（`maxConcurrentOpenCode` 默认 2，与 `maxConcurrent` 全局上限并存，且 OpenCode 满员**不阻塞** ZCode 队列）；`validateSpec` 对 opencode 拒绝 `mode`/`memoryBench`；`spec.auto` ⇒ 执行器 `--auto`（默认关）+ `job.autoApproved` 可审计；`retry` 沿用 `auto`/跨引擎不带 engine |
| `dispatch/wire.host.mjs` | dispatch 的 spec 白名单补 `engine`、`auto`（**曾漏 ⇒ 工具新参数被静默丢弃**）；`retry` 透传 `engine`/`auto`；快照路径改为**只读缓存**的通道清单（见 §3.4 真机事故）；失败结果短 TTL（1s） |
| `dispatch/index.js` | 配置新增 `maxConcurrentOpenCode`(2) / `opencodeRunnerPath`('')；工具 schema 新增 `engine`、`auto`（**都不用 enum**，ZB-37 纪律）；工具描述/教学文本补双引擎、`--variant`、跨引擎降级、探测式免费模型；system prompt 提示段补一句 |
| `dispatch/bin/dispatch.mjs` | CLI 补 `--engine` / `--opencode-runner`（+`DSP_OPENCODE_RUNNER`）；`channels` 输出加 `engine` 列与 `引擎:` 行 |
| `dispatch/client.js` | 通道下拉按引擎 **optgroup** 分组（单一源 `groupedChannelOptions`，主通道与降级目标共用）；引擎专属提示按选中通道动态显示；进程行**引擎徽标**；**「已放行权限」徽标**；demo 通道面补 `engine` 与 3 条 OpenCode 示例；**通道过滤开关「仅看可用 / 仅看免费」**（见 §3.3）；**通道清单失败可见 + 快照兜底自愈**（见 §3.5）；**tick 超时 + 保留上一包好快照**（见 §3.4）；**分区顺序：用量移到最末**（见 §3.6） |
| `dispatch/locale/zh.json` / `en.json` | 11 个新键（中英逐键逐值一致，`single-source.test.mjs` 哨兵守住） |
| `dispatch/test/core.test.mjs` | 追加双引擎断言（既有断言一条未改） |
| `dispatch/test/fallback-ui.test.mjs` | 适配 optgroup：新增 `flattenOptions()` helper（**这是分组改动唯一破坏的既有测试**，已修） |
| `.gitignore` | 忽略 `collab/logs/`、`dispatch/collab/logs/`（执行器把产物落在**工作目录**下的 collab/logs；自派发/测试时会在仓库里生成） |

**刻意没做**（避免过度设计，且都有理由）：
- **不给 `run-line-protocol.mjs` 加 `auto=on` 正式行**：执行器把它作为未登记行透传，
  靠 `job.autoApproved`（core 按 `spec.auto` 置位）+ 执行器确认行交叉核对。若将来要让面板
  依赖它，再登记（协议文件里写了"新增行必须两边一起改"的义务）。
- **runner 侧不实现派发总开关闸门**：闸门是 core/宿主契约（`wire.host` + `bin` + `bridge`
  三入口）；执行器由 core 按 `engine` 选中，开关关时 core 根本不会 spawn。
- **不自动加 `--auto`**：见 §1.4。

---

### 3.3 ZB-46：面板新增两个通道过滤开关（用户要求）

用户要求「面板新增 2 个开关，仅看可用 / 仅看免费，用于过滤」。落在 `dispatch/client.js` 的
「通道」分区（三个下拉之后），**纯展示层**（不发任何 remote 调用、不写 core 状态、不影响调度，离线可用）：

| 开关 | 默认 | 作用 |
|---|---|---|
| **仅看可用** | **开** | 只列当前可用的通道。**关掉后连不可用通道也一并列出**（置灰 + 标注原因）—— 这正是它存在的意义；若永久为开就是个死开关（改造前下拉本来就只列可用项） |
| **仅看免费** | **关** | 只列**不需要付费额度**的通道：`account:<family>-start-plan`（免费额度）与全部 `opencode/*`（OpenCode 免费模型）；隐藏 `personal`（个人 Key）与付费套餐 |

要点（都写进了代码注释与测试）：
- **两个开关都作用于两处下拉**：主「通道」与「自动降级目标」共用同一个 `applyChanFilters`（单一源）。
- **"免费"的判据**：`c.engine === 'opencode'`（依据：core 的清单来自 `opencode models`，该命令在本机
  0 凭据下只返回免费模型 —— 见 `OPENCODE-DISPATCH-HANDOFF.md` §2）或 `account:*-start-plan`。
  **刻意不把 `personal` 算作免费**（那走用户自己的付费额度）。OpenCode 若将来在目录里混入付费模型，这条判据要跟着改。
- **当前选中值必须始终可渲染**：被过滤掉的当前值仍补进下拉，且**区分两种情形**——
  本身掉线 ⇒ 标「不可用：原因」；本身可用、仅被过滤 ⇒ 标「当前选择」（**不谎报成不可用**）。
  否则 `<select value>` 匹配不到 option，浏览器显示首项，与真实存值不符（ZB-31/ZB-33b 同类坑）。
- 开关状态存 `localStorage`（`dispatch:filter:available` / `dispatch:filter:free`，键名集中在 `filtStorageKey` 单源），
  刷新/重开面板保留。
- 过滤生效时明说「过滤已隐藏 N 个通道（共 M 个）」，避免用户以为通道清单坏了。

**真实清单验证**（`node tasks/filter-check.mjs`，22 条真实通道）：

| 组合 | 结果 |
|---|---|
| 仅看可用=开（默认） | **17/22**（滤掉 5 条不可用：`builtin:zai`、`builtin:bigmodel-start-plan`、`builtin:zai-coding-plan`、`builtin:zai-start-plan`、`7438da80-…`） |
| 两个都关 | **22/22**（证明开关不是死的） |
| 仅看可用=开 + 仅看免费=开 | **13/22** = `account:bigmodel-start-plan` + 12 个 `opencode/*` 免费模型（`personal` 与付费套餐被隐藏） |

**契约锁**：`dispatch/test/engine-ui.test.mjs` 第 ⑤ 组（18 项）钉住：双语文案键、单一源
`applyChanFilters`、两个判据、默认值、`pinnedReasonText` 的两种标注、过滤**纯展示层**（该代码块内不得出现
`remote.call`/`channelSet`/`fallbackSet`）。另：`fallback-ui.test.mjs` 的"找降级开关"由"第一个 `.dsp-toggle`"
改为**按标签文本**取（面板现在有 3 个 `.dsp-toggle`，靠"第一个"会拿到过滤开关 —— 这正是本次改动的现场坑）。

---

### 3.4 ZB-47：面板「进程」有时空白 / 卡在「连接中」（真机事故，用户报告）

**现象**：面板「进程」分区有时显示「暂无进程记录」（明明有 job），标题栏停在「连接中 / 派发：未知」，
「用量」全区空白 —— 同时「通道」分区却正常（下拉有值）。**时好时坏**。

**根因（我复现并测量过）**：面板的 remote wire 是
`const snapshot = await remote.call('snapshot')` **之后**才 `emit()` 的；
而宿主 `snapshot()` **内联 `await channelsCached()`** —— 那个探测会 **spawn 一个 runner 子进程**
（冷启实测 **6.7s**，而缓存只有 5s ⇒ 每 5 秒就有一拍要等它）。
于是那一拍里：整包快照发不出去 ⇒ 进程列表、用量、总开关状态**一起**空白，界面卡在「连接中」。
「有时正常」= 那一刻恰好命中缓存。

**修法（两端各一刀，且都快照路径彻底与探测解耦）**：
- 宿主 `wire.host.mjs`：新增 **`cachedChannels()`**（**同步**只读缓存 + 后台刷新 + **在途去重**），
  `snapshot()` 改为**只读**它、**绝不 await 探测**；权威取数仍在 `channelsCached()`（面板挂载/`action=channels` 才 await）。
- 客户端 `client.js`：`tick()` 的两处 `remote.call` 加 **8s 兜底超时**（最坏发一包快照、轮询继续）；
  失败时**沿用上一包好快照**（`lastGoodSnapshot`）——否则一次抖动就会把进程列表刷成「暂无进程记录」，
  这正是用户看到的"有时没有"。

**实测证据**（`node tasks/snapshot-latency-check.mjs`，真实 dispatcher + 真实探测）：

| 项 | 修复前 | 修复后 |
|---|---|---|
| 冷缓存 `snapshot()` | ≈3s（要等探测） | **39ms** |
| 连续 20 次 `snapshot()` | 每 5 秒一拍是秒级 | **最慢 4ms / 平均 1ms** |
| 缓存过期那一拍的 `snapshot()` | 再次秒级 | **8ms** |
| 同一份快照 | — | **带 47 条 job + 开关状态**（进程分区不再空） |
| `channels()`（权威取数，会 await） | 6.7s | 6.7s（不变，合理） |

**契约锁**：`engine-ui.test.mjs` 第 ⑧ 组（11 项）钉住「快照路径不得出现 `await channelsCached()`」
「后台刷新 + 在途去重」「客户端 8s 超时」「沿用上一包好快照」。

### 3.5 ZB-48：通道清单加载失败被静默吞掉（真机事故，用户报告）

**现象**：面板三个下拉全部显示「不可用：-」，通道分区空。

**根因**：① `channels()` 只在**挂载时拉一次**；② `wire.client` 把失败包成 `{ok:false}`（**不抛**），
而客户端的 `.then` 只处理 `ok` ⇒ **失败被静默丢弃、清单永远为空**；③ 没有任何重试。

**修法**：① 失败时把 wire 的 error **显示出来**并注明"会自动重试"；② **用 `snapshot.channels` 兜底回填**
（扫描轮询，只在"当前清单为空"时采纳，不覆盖用户刚切的值）；③ 空清单且无错时显示「加载中…」；
④ 宿主侧失败结果走 **1s 短 TTL**（成功 5s）⇒ 每秒轮询自动重试。

### 3.6 ZB-49：分区顺序 —— 用量移到最末（用户要求）

顺序改为 **通道 → 进程 → 单写者/文件锁 → 用量**。
理由：通道/进程/锁是"当下要看"的操作面，用量是"回头看"的统计；放最后既不挡进程列表，
也不用为了看用量先滚过它。分区 id 未变 ⇒ 各分区折叠状态与持久化键不受影响。
（`section-order.test.mjs` 的期望顺序已同步更新，`frozen-probe.test.mjs` 里那条"参数列表逐字全等"
的脆弱断言改成**包含式**，只钉"sw 确实传进来了"。）

---

## 4. 验证证据（可复跑）
### 4.1 离线测试全量（**0 失败**）

```powershell
cd 'F:\My Code\dsh-dispatch\dispatch'
$fail=0; $files=0
Get-ChildItem test -Filter '*.test.mjs' | ForEach-Object { $files++; node $_.FullName *> $null; if ($LASTEXITCODE -ne 0) { $fail++; Write-Host "FAIL($LASTEXITCODE) $($_.Name)" } }
Write-Host "文件=$files 失败=$fail"
```

结果：**文件=37 失败=0**（改造前 31 个文件全绿，本轮 +6 个文件）。

单项：
```powershell
node dispatch/test/line-protocol.test.mjs      # 39 项 PASS 39 / FAIL 0 / SKIP 0（DSP_OC_STRICT=1 同样全绿）
node dispatch/test/wire-engine.test.mjs        # 6 项
node dispatch/test/engine-ui.test.mjs          # 46 项
node dispatch/test/host-config.test.mjs        # 59 项
node dispatch/test/opencode-executor.test.mjs  # 25 项
node tools/verify-opencode.mjs                 # 10 项：PASS 9 / FAIL 0 / SKIP 1（唯一 SKIP = 未传 --live）
node tools/verify-plugin.mjs                   # 23 项 0 失败（既有常驻探针）
```

> ⚠️ `wire-engine.test.mjs` 的 `test.after` 里必须**先 kill 未落地 job 再删临时目录**：
> dispatcher 的 `persist()` 是异步写盘（`jobs.json.<pid>.<ts>.tmp` + rename），
> 写盘途中删目录会抛 ENOENT ⇒ uncaughtException ⇒ 即使断言全绿、**进程退出码仍是 1**
> （既有 `$LASTEXITCODE` 判定会误报失败）。这条已写进测试注释，别退回旧写法。

### 4.2 端到端：真实 OpenCode（`tasks/e2e-opencode-dispatch.mjs`）

```
=== 1) 通道清单（真实探测） ===
  engines=["zcode","opencode"] zcode=10 opencode=12 opencodeVersion=1.19.2
=== 2) 派发：prompt（免费模型，真实调用） ===
  spec: {"kind":"prompt",...,"provider":"opencode","engine":"opencode","model":"opencode/deepseek-v4.1-flash-free"}
  state: done   engine: opencode   wall=7.7s
  sessionId: ses_ebb0f8b4fffe10rDaaYM49EAQe
  usage: {"requests":1,"inputTokens":6296,"outputTokens":3,"cacheReadTokens":1792}
  contextUsed/Window: 8091/200000    autoApproved: false
  result.response: PONG   result.cost: 0   result.eventCounts: {"step_start":1,"text":1,"step_finish":1}
  result.unknownEvents: []
=== 4) 失败路径：不存在的模型 ===
  state: failed  exitCode: 1  pauseReason: unknown（上游原始错误原样透传，不崩）
=== 5) 跨引擎降级链 ===
  target: {"provider":"opencode/deepseek-v4.1-flash-free","model":null,"reasoningLevel":"agent"}
```

### 4.3 执行器直连（不经 DSH）

```
node collab-kit/opencode-run.mjs --prompt "Reply with exactly: PONG" --tag lead-smoke
  [opencode-run] provider=opencode model=opencode/deepseek-v4.1-flash-free
  [opencode-run] usage requests=1 in=6244 out=2 cacheRead=1792
  [opencode-run] context used=8039 (4.0% of 200000) turnCount=1
  [opencode-run] done exit=0 elapsed=7.3s session=ses_… responseChars=4
  result.json: text=PONG, cost=0, eventCounts={step_start:1,text:1,step_finish:1}, unknownEvents=[]
```
写文件（Agent 真干活）：`Create a file named hello.txt containing exactly: hi from opencode` ⇒
exit 0、`hello.txt` 内容一字不差。

只读探测（**0 额度**）：`--version` ⇒ `1.19.2`；`--list-models` ⇒ stdout **只有 12 行裸模型 id**
（无前缀行，供 core 逐行解析）；`--list-models --with-variants` 追加 8 行真实档位
（其余 4 个模型 `variants` 为空对象 ⇒ **如实不打**，判据 `opencode models --verbose`）。

### 4.4 ZB-45：抓到一个"误杀慢模型"的 BUG 并修复

**现象**：`glm-5.3-flash-free` 经派发台**必然失败**：`done exit=1 elapsed=15.0s responseChars=0`，
out/err 日志各 0 字节，看起来像"静默退出"。
**定位**（对照实验，同机同目录同 argv，只换 spawn 方式）：

| 形态 | 结果 |
|---|---|
| `spawnSync(opencode.exe, …, stdio:['ignore','pipe','pipe'], timeout:60000)` | **exit=0，14181ms，out=925B** |
| 同上 stdio=pipe | exit=0，9884ms，out=925B |
| `deepseek-v4.1-flash-free` 同法 | exit=0，6365ms |

**根因**：执行器原有一段**独立于 `--timeout-min` 的 15s 兜底**
（`Promise.race([closed, 15_000ms forced])`）。glm 冷启要 ~14.2s ⇒ 兜底把"慢但正常"
判成"挂死"，取 `settled.code ?? 1` ⇒ exit=1；而 stdout/stderr 由 readline 异步消费，
所以表现为"零输出"。**这不是防挂死，是误杀**。
**修法**：兜底改为与 `--timeout-min` 挂钩（`timeoutMin*60_000 + SETTLE_GRACE_MS(120s)`），
新增 `resolveExitCode()`（超时 124 最高优先 → 透传真实码 → 兜底用**子进程真实码** → 拿不到才 1），
`settleForced` / `settleForcedAfterSec` / `settleForcedKilled` 落 result.json，
`forced` 收尾的 done 行**不带** `(超时)`；诊断改为先报客观事实（`stdout=<B>B stderr=<B>B`…）再列**可能**原因。
**修复后实测**：glm PONG `exit=0 elapsed=17.7s`（**已超过旧的 15s 掐断线**）；
glm 写文件 `exit=0 elapsed=49.9s` 且文件内容一字不差 —— 两条都证明不再被误杀。
**顺带**：旧版 race 败者的 `setTimeout` 没 `clearTimeout`，吊住事件循环（`WALL` 总比 `elapsed` 多 ~2s），一并修掉。

> ⚠️ 同一次验证里还观测到一次**免费层 429**（`Endpoint is unavailable / statusCode 429 / isRetryable:true`，
> 首跑文件其实已正确写出、随后上游限流导致 exit 1、耗时 151.5s）。**那是 IP 限流，不是本 BUG**：
> 上游原始错误逐字透传，停 100s 重跑即 exit 0。派发免费模型时请预期这种间歇失败（`paused/failed` 都可续跑）。

### 4.5 并发上限该设几（**实测回答**）

`tools/oc-concurrency-probe.mjs 2`（两个独立 `opencode run` 并发、各自独立工作目录、同免费模型）：

```
  [1] exit=0 8.3s  done: exit=0 elapsed=6.2s session=ses_ebb0f3e2… responseChars=6
  [2] exit=0 9.2s  done: exit=0 elapsed=7.2s session=ses_ebb0f3e2… responseChars=6
结论：2/2 成功 ⇒ 并发 OpenCode 进程【未】互相破坏
```

⇒ `maxConcurrentOpenCode` 默认 **2** 成立（也与用户确认过的 handoff 建议一致）。
**真正的危险源**是"同一进程链里在 `run` 进行中又起第二个 opencode（例如探测）"——
执行器已把元数据探测改成**顺序 + 缓存**（`%TEMP%\dsh-opencode-model-meta.json`，TTL 6h、
按 CLI 路径失效），正常路径不再产生并发探测。

---

## 5. 硬约束遵守情况（`OPENCODE-DISPATCH-HANDOFF.md` §7 逐条）

| 约束 | 落实 |
|---|---|
| ① 不伪装身份 | 真机调用 `opencode` 本体；**无**伪造 UA / **无**伪造 `ses_*` session id / **无**假工具定义。测试里也有源码锁断言 |
| ② 不读写用户 OpenCode 配置与数据 | 只**执行** `opencode` 命令 + 读其 stdout；不读 `~\.config\opencode\`、不写 `~\.local\share\opencode\opencode.db`。执行器的元数据缓存写在 `%TEMP%` |
| ③ 默认不开 `--auto` | 默认关；只有 `spec.auto === true`（用户显式）才透传 `--auto`，且 job 上 `autoApproved` + 面板徽标 + 执行器 `auto=on` 行三重可见 |
| ④ 免费层不并发轰炸 | `maxConcurrentOpenCode` 默认 2、与 ZCode 分开计数；探测串行化 + 缓存 |
| ⑤ 未知事件不崩 | 未登记 `type` 降级透传进 `unknownEvents`，绝不抛；带已知前缀但认不出的行只记 warning |

---

## 6. 已知限制 / 残留风险（如实登记）

1. **`glm-5.3-flash-free` 冷启 ~14s**：属上游排队/冷启动，不是我们的问题，但**派发这类模型要给足 `timeoutMin`**（默认 45 分钟足够）。
2. **会话按工作目录作用域**：同一 `sessionID` 必须在其创建时的 `--dir` 下续跑（换目录会挂）。
   core 的 `retry` 同通道 resume 会沿用原 `spec.cwd` ⇒ 已对，并有断言；调用方**显式**用
   `dispatch({resume, cwd})` 时须自带同一个 cwd。
3. **免费层按 IP 限流**：间歇失败/429 可能；不要靠调大并发来提速。
4. **通道清单依赖 `opencode` CLI 在 PATH**（npm prefix）。CLI 缺失/升级 ⇒ OpenCode 通道为空
   （ZCode 不受影响）；`opencode --version` 已随通道清单返回（`opencodeVersion`）。
5. **上游随时可能改门禁/端点**（2026-10-11 刚迁移过）：失败时执行的**上游原始错误**会原样透传，
   不要改写成"API Key 无效"。正解是升级 OpenCode 再看，**不要退回伪装路线**。
6. **CI 里不要跑 `--live`/e2e**：它们真调免费模型（消耗额度 + 受 IP 限流）。`tools/verify-opencode.mjs` 默认离线就是为此。
7. **`opencode-run.cmd` 故意纯 ASCII**：中文 `rem` 在 cmd.exe 下会吐 `'xxx' is not recognized` 噪声（既有 `zcode-run.cmd` 有同样噪声，功能不受影响，未动）。

---

## 7. 生效语义（改完怎么让它真的生效）

| 改动位置 | 生效方式 |
|---|---|
| `dispatch/client.js`、`dispatch/locale/*` | **刷新页面** |
| `dispatch/index.js`、`wire.host.mjs`、`core/*` | **完全退出 DSH 再启动**（cordis `_reload` 不重新 import） |
| `collab-kit/*`（执行器） | **下次派发即生效**（每次 spawn 新进程，不用重启） |

profile 侧若要显式指定 OpenCode 执行器，可加（**机器专有路径不进 `cordis.patch.yml`**）：
```yaml
- id: dispatch
  config:
    maxConcurrentOpenCode: 2
    opencodeRunnerPath: 'F:\My Code\dsh-dispatch\collab-kit\opencode-run.mjs'
```
（留空也能工作：core 默认 env `DSP_OPENCODE_RUNNER` → 仓库内 `collab-kit/opencode-run.mjs`。）

---

## 8. 复跑清单（一条条可复制）

```powershell
# 0) 前置：OpenCode 在位
opencode --version                     # 期望 1.19.2
node 'F:\My Code\dsh-dispatch\collab-kit\opencode-run.mjs' --list-models   # 期望 12 行裸 id

# 1) 离线测试（0 失败）
cd 'F:\My Code\dsh-dispatch\dispatch'
$fail=0; Get-ChildItem test -Filter '*.test.mjs' | ForEach-Object { node $_.FullName *> $null; if ($LASTEXITCODE -ne 0) { $fail++; Write-Host "FAIL $($_.Name)" } }; Write-Host "失败文件=$fail"

# 2) 常驻探针
cd 'F:\My Code\dsh-dispatch'
node tools/verify-plugin.mjs      # 23 项
node tools/verify-opencode.mjs    # 10 项（加 --live 才真调免费模型）

# 3) 端到端（真调免费模型，约 1 分钟）
node tasks/e2e-opencode-dispatch.mjs

# 4) auto 行为门禁（离线，假执行器抓 argv）
node tasks/zb45-auto-gate.mjs     # 11 PASS / 0 FAIL

# 5) 通道过滤开关判据（真实清单：22 条 ⇒ 17 / 22 / 13）
node tasks/filter-check.mjs

# 6) 并发上限实验（可选）
node tools/oc-concurrency-probe.mjs 2
```

**最近一次全绿记录（2026-10-16 22:0x，冻结树）**：
- 离线 **37 文件 / 0 失败**（连跑 3 次一致）
- `tools/verify-plugin.mjs` **23 项 / 0 失败**
- `tools/verify-opencode.mjs` **10 项：PASS 9 / FAIL 0 / SKIP 1**
- `tasks/zb45-auto-gate.mjs` **11 PASS / 0 FAIL**
- `tasks/e2e-opencode-dispatch.mjs`（真调免费模型）：通道 10+12、prompt `done`（PONG，6.6s）、
  写文件 `done`（`hi from opencode`）、坏模型 `failed exit=1`（原始错误透传）、降级目标落盘
- `node --check`：7 个入口文件全部 exit 0

---

## 9. 交付后仍未做（**交接给下一个会话**）

1. **宿主重启 + 浏览器真机目视**：`index.js`/`wire.host.mjs`/`core/*` 要**完全退出 DSH 再启动**；
   `client.js`/`locale` 要**刷新页面**。本会话**没有**做这两步，也没有在真实面板里目视分组效果
   （DSH GUI 是宿主应用本身，内置浏览器自动化无法驱动它）。客户端改动由 46 项离线契约锁兜住。
2. **真派发一次**（需总开关打开；2026-10-16 21:03 查为关）：面板上验证引擎徽标 / 用量 / 放行徽标。
3. **git 提交**：本轮 13 改 + 13 新**全部未提交**（等用户确认）。
   `git status` 里应无 `collab/` 之类运行期产物（已加 `.gitignore`）。
4. 可选：profile 里显式配 `opencodeRunnerPath`（机器专有路径不进 `cordis.patch.yml`）；
   `engines` 改派生；token 用量喂 `dsh-cost-meter`；路线 B（常驻 serve + SSE）。
