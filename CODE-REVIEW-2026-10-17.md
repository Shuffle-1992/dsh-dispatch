# DSH 派发台 · 全面 Review（2026-10-17）

> 触发：用户要求「完成所有优化内容 + 全面 review + simplify + 强制性优化 + 解耦 + 测试验收」。
> 前提：DSH 0.2.1-rc.2；三项新功能优化（ZB-61/62/63）已先行落地；**本轮不重启 DSH**（用户后续统一重启）。
> 本文件是**结论与决策记录**；逐条证据在各审计报告（`%TEMP%\audit-{client,host,tests}.md`，本文件第 8 节给出摘要）。

---

## 0. TL;DR

| 维度 | 结论 |
|---|---|
| **发现的真缺陷（P0）** | **5 条**：① 派发时通道探测**串行跑两遍**（每次 spawn `zcode --list-providers` + `opencode --list-models/--version`，工具调用可能被阻塞数十秒）② 唤醒通知给 OpenCode/Qoder 的 job **贴错引擎标签**（硬写 `zcode job`）③ 工具 `engine` 参数描述只写两引擎、实际三引擎 ④ remote **方法表与实现表已漂移**（19 vs 17，缺 `modelSwitchesGet/Set`）⑤ 客户端**同一 job 两处引擎显示不一致**（`list` 紧凑形状无 `spec`，卡片显示不出来） |
| **结构性耦合** | 5 类：状态目录无单一所有者（wire/notify 各自从 `jobsFile` 反推）／唤醒账本分裂（index 记 owners、notify 投递）／action handler 被构造 3 次／channels 载荷 4 处各拼一遍／job 形状 6 处、spec 构造器 3 份 |
| **simplify 空间** | 客户端旧浮窗时代死代码 ≈115 行 + 34 个死文案键；宿主死导入/死解构 3 处；`slimJob` vs `briefJob` 重复；超长函数 top8（最大 `createDispatcher` ≈2860 行） |
| **测试资产 vs 阻力** | 22/47 文件读源码文本断言（其中 16 处钉**缩进**）；发现 1 条**假保护**（恒绿的"防双 UI"断言）；**最大盲区**：wire action 层 `tail/status/channels/quota/switch/dismiss/retry` **零行为覆盖** |
| **本轮执行** | 6 条并行线（见 §3）：**5 个 P0 + 3 个 P2/P3 + 3 组解耦 + 客户端 simplify 全部落地**；新增 **247 条断言**；全量 **56/56 全绿、123.1s**（比改前更快）；改动只在本地提交，等一次重启 |
| **遗留** | 执行 5 的 4 个测试文件未加固（pass，但仍有固定 sleep）；`createDispatcher`（≈2860 行闭包）等结构性热点记入第二轮（§5/§6） |
| **明确不做** | 拆 client.js 成多文件（无模块系统）、压注释密度、把 `index.js` 大卸八块（见 §5） |

---

## 1. 方法与范围

**四份独立审计（只读，互不重叠）**

| 审计 | 负责人 | 对象 | 产出 |
|---|---|---|---|
| A · 客户端 | panel-dev | `dispatch/client.js`（5303 行）+ locale | `%TEMP%\audit-client.md`（120 行） |
| B · 宿主 | host-config | `index.js` / `wire.host.mjs` / `core/**` / `notify.mjs` / `bin` / `collab-kit` | `%TEMP%\audit-host.md`（125 行） |
| C · 测试 | verify-kit | 47 个 `*.test.mjs` + 2 个校验脚本 | `%TEMP%\audit-tests.md`（89 行） |
| D · 仓库卫生 | lead | git 追踪面 / `.gitignore` / 大文件 / 第三方副本 / TODO 归零 | 本文件 §2.4 |

**审计纪律**：只读、不改仓库、不重启 DSH；每条结论必须带 `文件:行号` 或实测数字；查不到就写"未验证"。
**基线**：审计开始时 `node %TEMP%\dispatch-suite.mjs` = **51/51 passed**，墙钟 **131.8s**（verify-kit 实测），工作树干净。

---

## 2. 发现汇总（分级）

### 2.1 P0 —— 真缺陷 / 实害（全部本轮修）

| # | 缺陷 | 证据 | 实害 | 决策 |
|---|---|---|---|---|
| P0-1 | **通道探测双跑** | `wire.host.mjs:433` / `:468` 两处 `dispatcher.listChannels()`；core 无探测缓存（缓存只在 face `wire:785`），每次探测 spawn `zcode --list-providers` + `opencode --list-models/--version`（core:2567-2576 / 2656-2679） | 台账有近期限流时，**一次工具派发可能被阻塞数十秒** | 修：合并 guard+hint 为一次探测（task-11）＋**计数断言**（限流命中/未命中两种输入都 ≤1 次） |
| P0-2 | **唤醒通知贴错引擎标签** | `notify.mjs:109` 对所有 job 硬写 `zcode job …` | OpenCode/Qoder 的落地通知告诉用户"zcode 任务"（用户直接可见的错误信息） | 修：按 `job.engine` 出标签，未知引擎用中性文案（task-12） |
| P0-3 | **工具 `engine` 描述只写两引擎** | `index.js:328` 写 `zcode\|opencode`，而 `ENGINES` 是三值 | 模型不知道 qoder 可传 ⇒ 能力被静默隐藏 | 修（task-12） |
| P0-4 | **remote 方法表与实现表漂移** | `REMOTE_METHODS`=19（`wire:1074`）vs `FACE_METHOD_TABLE`=17（`wire:1076-1095`，缺 `modelSwitchesGet/modelSwitchSet`） | 缺 codec 的方法在 TYPERT 面不可用；这类漂移**已经**造成过真事故（ZB-52：表 17/实现 15 ⇒ 面板开关永远关） | 修：两表**由同一份定义派生** + 覆盖断言（task-11、task-13） |
| P0-5 | **卡片引擎显示与面板不一致** | 客户端 `tvJobFacts`(4798-4821) 只读 `job.engine ?? spec.engine`；而 `list` 的**紧凑形状没有 `spec`**（宿主 `briefJob()`） | `dispatch action=list` 的卡片里 engine 空白，面板却有值 | 修：卡片改用 `jobEngineOf`（task-13，1 行） |

### 2.2 P1 —— 结构性耦合与重复（本轮修其一大部分）

| 组 | 问题 | 决策 |
|---|---|---|
| 状态归属 | `dismissed.json` / `wake-stats.json` 两个消费者各自从 `dispatcher.jobsFile` **反推** state 目录（`wire:154/168-175`、`notify:188-200`） | core 暴露 `statePath(name)`，路径推导只此一处（task-11 + task-12 跟进） |
| 唤醒账本 | `index.js` 记 owners + pre-kill 顺序（`:516`/`:464-471`），投递与状态在 `notify.mjs:297-329` | 账本收进 notify（`beforeAction/noteAction`），index 侧变薄；`noteOwnerAction` 仍从 index 导出、签名不变（task-12） |
| 处理器三份 | action handler 在 `index:605` / `wire:1181` / `wire:784` 各构造一次 | 本轮**不改**（见 §5：收益小、牵扯面大） |
| 载荷四处 | channels 载荷在 `wire:686-693/817-826/852-859/903-909` 各拼一遍（已漏过一次） | 记入第二轮候选（与 M12 一起） |
| job 形状六处 | `core:3043-3100/762-771/913-943`、`wire:193-233/259-296`、测试 fixtures | `slimJob`+`briefJob` 合并为 `projectJob(job,{full})` 记入第二轮候选 |
| 台账 schema | 写方 `zcode-run:1260-1261` / `appserver-gift-job:200-201`，读方 `core/quota:45-121` / `wire:369-401` | 解析入 core 单源（task-11） |
| 死码 | `TERMINAL_STATES` 死导入（wire:41）、`resultNote` 死解构（wire:1126）、`dispatcher.dispose?.()`（index:715，core 无 dispose）、3 个零消费导出 | 清（task-11 / task-12，删前 grep 确认无消费者含测试） |
| 配置复位 | `CONFIG_ISSUES` 是**模块级**数组且二次 apply 不复位（index:53/66/576） | 每次 apply 复位（task-12）＋ 测试 |
| 双调 | `validateSpec` 在 core:3118 与 :3041 各调一次 | 只留一处（task-11） |
| **自相矛盾的逃生舱** | `list` 的 note 无条件推荐 `full=true`，而实测 60 条 `full` 文本 **135 KB**（96 条 212 KB）⇒ 模型照建议做会**再次**被 spill 从中间截断，正好抵消 ZB-61 的意义 | note 改为同时给**代价**与**安全用法**（`full=true` 必须配小 `limit`），并提示"总数超 200 时一次取不全、改用 tail"（Lead 直接改） |
| `tail` 负数 | `Math.max(1, Number(n) \|\| 30)` ⇒ `n=-5` 变成 **1 行**（负数在 `\|\|` 下是真值） | 改成"只有正数才算值，其余回默认 30"（Lead 直接改） |
| `list` 排序与文档不符 | core `order[state] ?? 2` ⇒ paused 与终态**同秩**，有更新的已完成 job 时 paused 被挤到下面（工具描述写的是 `running→queued→paused→终态`） | 终态显式降到 rank 3（Lead 直接改） |
| 超长函数 | `createDispatcher` 618-3478（≈2860 行、≈100 内嵌函数）、`createRemoteFace` 289、`createActionHandler` 264、`listChannels` 257、`apply` 154… | 本轮只做**低风险提取**（客户端 `FallbackBlock`/`ChannelPickers`）；核心闭包的拆分记入第二轮（风险高） |

### 2.3 客户端专属（审计 A）

- **状态词汇表 5 处并存**（`DISMISSABLE_STATES` 2361 / `StatusDot` 2364 / `JOB_GROUPS` 3981-3986 / `TV_PILL` 4982 / `PAUSE_LABEL_KEY` 2318 + 宿主 `core:224`）——"加一个状态必漏改其一"，注释里已自认踩过 ⇒ 收敛成模块级 `JOB_STATE_META` 派生（task-13）。
- **重复实现 4 组**：`tvClip`↔`clampText`、`tvElapsed`↔`fmtSec`、`tvJobFacts`↔JobRow 事实表、锁直显↔`lockKindOf` ⇒ 卡片复用面板 helper（≈ −40 行）（task-13）。
- **旧浮窗时代死代码 ≈115 行**（`anchorOf`/`resolvePos`/`clampPos`/`HEIGHT`+`clampHeight`/`LS`/`Z_INDEX`/`EDGE`/3 个图标/`ZC_FREE_OPTION`…）⇒ 删（task-13）。⚠️ 保留：`ROUTE_LABEL_KEY`（虽死但被 `zcode-route-pick:73` 钉住）、`dsp-lock-*`（动态拼）、`engLimitedFree`/`engModelOnly`（`engine-ui:34-40` 钉住）。
- **36 个死文案键**（其中 34 个可真删；另有 39 个只被映射表/三元间接引用，**是活的**——审计已给出 5 张映射表，防误删）⇒ 删 34 个并四处同步（task-13）。
- **7 组客户端↔宿主语义重复**，其中 3 组无 cross-check（引擎集 / 可关闭集 / 暂停原因）⇒ 补 cross-check 测试（task-13）。

### 2.4 仓库卫生（审计 D，lead 自审）

| 检查 | 结论 |
|---|---|
| 运行期状态是否入库 | ✅ 未入库（`.data/`、`work/`、`collab/logs/`、`bridge/*` 都在 `.gitignore`） |
| 追踪面规模 | 208 个文件，pack 612 KiB（最大：`client.js` 376 KB、`core/dispatch-core.mjs` 195 KB） |
| 第三方副本 | `refs/dsh-tools/**` 是**有意保留**的只读形态对照（README:286-287 + LICENSE 随附）；**确认无任何运行期 import**（只在注释/文档/历史任务里被引用）⇒ 不算耦合 |
| TODO 归零 | ✅ 由 `z2-verify` 门禁钉住（`TODO` 出现即红） |
| 行数口径坑 | 本仓注释含裸 CR ⇒ PowerShell `Get-Content` 会少算（实测 notify 298 vs 真实 347）。**行数一律以 node/read 为准**（已记入 pitfalls 候选） |

### 2.5 测试资产审计（审计 C）

- **22/47 文件读源码文本做断言**；**16 处"正则切片 + `new Function`"** 的锚点是**缩进字面**（`\n    }`）或整段文本 ⇒ 重构一动就红。**这是本轮"解耦"的最大阻力**，也是"为什么必须先审计再动手"的原因。
- **1 条假保护**：`header-entry:26` 用**已改名的旧常量** `SLOT` 做反断言 ⇒ 恒绿、零保护，读起来却在"防双 UI"（真保护在文末 ZB-60 一节）。
- **5 处注释脆弱**：在未剥注释的源码上做反断言 ⇒ 写一句解释性注释就假红（`ctx-format:63`、`elapsed-format:57-58`、`fallback-target:197`、`thinking-level:108`、`lock-ui` 若干）。
- **flaky 点**：`header-entry` 150ms 定时器 vs `wait(180)`（余量 30-50ms）、`fallback-ui` 用 `setTimeout(20/30)` 等异步 setState、锁族 `sleep(20)` 轮询、wake/hardening/retry 系列 10-15s deadline 偏紧。
- **最大盲区**：wire action 层 **`tail/status/channels/quota/switch/dismiss/retry` 零行为测试**（写错了测不出来）；ZB-61 的"模型到底看到了什么"（`output.render`）零覆盖；ZB-62 只测了 `idle→followup`，`inject` 路径未测；ZB-63 的 key 一致性无断言。
- **运行成本**：51 进程 131.8s，前 14 个占 84%；`opencode-executor` 26.4s、`verify-opencode` 15.3s（真跑 CLI）。**结论**：把 19 个 <0.5s 的静态文件合并"不值得"（省 ~3s）；4 个 UI 渲染文件**不能**同进程合并（同一 specifier import + `document` 桩互踩）。

---

## 3. 本轮执行（6 条线，各自独立验收）

| 线 | 负责人 | 范围（独占） | 内容 | 结果 |
|---|---|---|---|---|
| 执行 1 | host-config | `wire.host.mjs` + `core/**` + `bin` | P0-1 消双跑、P0-4 方法表单源、M2 `statePath`、M3 台账解析入 core、F8 双调、（可选 M1 dismissed 归 core） | ✅ 代码全部落地（`statePath` core:631/3456、`recentRateLimited` quota.mjs:166、`FACE_METHOD_TABLE` 由 `REMOTE_METHODS` 单源驱动、`host-decouple.test.mjs` 全绿）；⚠️ 报告未送达（子代理被环境中断）⇒ **Lead 逐项读代码复核** |
| 执行 2 | core-engine | `index.js` + `notify.mjs` | P0-2 引擎标签、P0-3 engine 描述、M6 账本合并、F7 配置复位、F6 死码、M2 跟进 | ✅ 代码全部落地（`engineLabelOf` 双来源 + 中性兜底；engine desc 补 qoder；`CONFIG_ISSUES` 每 apply `splice` 取走；`noteOwnerAction` 仍从 index 导出）；⚠️ 未写测试 ⇒ **Lead 补写 `notify-engine-label.test.mjs`（21 断言）** |
| 执行 3 | panel-dev | `client.js` + `locale` | P0-5 卡片引擎、死码 115 行、死键 34 个、`JOB_STATE_META` 单源、卡片复用 helper、F1 方法覆盖守门 + 3 条 cross-check | ✅ 批 1+2 落地（`JOB_STATE_META` 单源见 client.js:2228-2252；locale 241→205 键）；⚠️ 批 3 未做 ⇒ **Lead 补写 `cross-check.test.mjs`（11 断言，含 F1 反射守门）**；批 2 第 6 项（`FallbackBlock` 抽取）按 §5 不做 |
| 执行 4 | verify-kit | 2 个**新**测试文件 | wire action 层行为覆盖（最大盲区）+ 三新功能非 happy path | ✅ `wire-actions.test.mjs` **103 断言**、`wire-e2e-gaps.test.mjs` **75 断言**，各连跑 3 次全绿；**未发现源码缺陷**；顺带产出 3 条 P2/P3 观察（Lead 已全部修掉，见 §2.2） |
| 执行 5 | seq-tester | 12 个测试文件 | 消除 flaky 等待 + 剥注释后再反断言（语义不变） | 🟡 **8/12 完成**（ctx-format / elapsed-format / fallback-target / thinking-level / file-lock / lock-model / lock-priority / lock-queue-visibility），子代理两次被环境中断；余 4 个（wake-integration / hardening / channel-retry / sequential-dispatch）**本轮多次实测通过、未改**，记入 §6.1 |
| 直接改（lead） | lead | `package.json` / `tools/` / 3 个测试文件 / 文档 | inject 对齐、`tools/accept-021.mjs` 一键验收、`header-entry`+`fallback-ui` flaky 与**假保护**修正、`toolview-card` 锚点修复、P2/P3 三项小修、`cross-check` 与 `notify-engine-label` 两个测试 | ✅ |

**写范围纪律**：每条线的文件清单互不重叠；测试文件默认不许改，**唯一例外**是 panel-dev 因删/移代码导致 pinned 锚点变红且行为未变时，可最小化改锚点并逐条报告（本轮已授权并留痕）。

---

## 4. 度量（改前 → 改后）

| 指标 | 改前 | 改后 |
|---|---|---|
| `client.js` 行数 | 5303 | **5215**（−88 行；删了 ≈115 行死代码、同时新增了单一源表与注释） |
| 客户端文案键数（`locale.ui`） | 241 | **205**（−36：34 个真死键 + 2 个随实现消失） |
| 全量测试进程 | 51 | **56**（+`host-decouple` / `wire-actions` / `wire-e2e-gaps` / `cross-check` / `notify-engine-label`） |
| 全量断言数（仅本轮新增文件） | — | **+247**（37+103+75+11+21） |
| 全量墙钟 | 131.8s | **123.1s**（−6.6%：多跑了 5 个进程反而更快 —— 因为把固定 `sleep` 改成了"轮询到条件成立即返回"） |
| 已知 P0 缺陷 | 5 | **0**（且 P0-1/P0-2/P0-4 各补了回归断言，3 条有专门测试文件守门） |
| 潜在"客户端半边装不上"路径 | 1（两份 `inject` 不一致） | **0**（已对齐，提交 `221901d`） |
| 主机→客户端语义漂移（无 cross-check 的组） | 3 | **0**（`cross-check.test.mjs` 三条 + F1 方法面反射） |
| 假保护断言 | 1（`header-entry` A3 恒绿） | **0**（改为会真红的结构断言） |

### 4.1 最终验收（重启后实测，本条为定稿）

```
node tools/accept-021.mjs      →  17 通过 / 0 失败
node %TEMP%\dispatch-suite.mjs →  SUMMARY: 56/56 passed（墙钟 123.1s，比改前 131.8s 更快）
```

重启后逐项活体核对（DSH 0.2.1-rc.2，插件被重组合替换后跑的确是磁盘上的最新代码）：

| 验收项 | 证据 |
|---|---|
| ZB-61 紧凑 list | `dispatch action=list limit=3` → `shape:"brief"` / `total:64` / `counts` / `note` |
| 省略提示**新文案**（P2 修复） | note 原文含「`full=true` **并配小 limit**（如 `full=true limit=10`）—— 不配 limit 的全量 full 可能上百 KB，会被宿主**从中间截断**」 |
| P0-2 引擎标签 | qoder 任务落地通知原文：`（kind=prompt, engine=qoder, tag=post-restart-accept, exit=0）` —— 修复前此处写的是 `zcode job` |
| ZB-62 对账闭环 | `wake-stats.json` = `{delivered:1, inject:1, insertAcked:1, lostWakes:0, unconfirmed:0}` |
| `tail n=-5`（P3 修复） | `n=-5` 回 **15 行**（默认上限内全部）、`n=1` 回 1 行 —— 修复前负数会被夹成 1 行 |
| ZB-63 卡片槽位 | `tool.call.toolview` occupants 含 `key:"dispatch", active:true`（卡片渲染见会话内 `dispatch` 调用） |
| 排序（paused 先于终态） | 现场无 paused job；由 `wire-e2e-gaps.test.mjs` 对**真 core `list()`** 断言覆盖 |
| 卡片排版观感 | **只能人眼**（DSH GUI 拒绝自动化浏览器访问） |

---

## 5. 明确不做（附理由）

1. **不把 `client.js` 拆成多文件**：客户端半边是 `window.__ModuleLoader__.load({factory})` 的单文件纯脚本，**除 `react` 外不能 import**（我们的包自身也不能被 require）⇒ 只能同文件内提取。硬约束，非取舍。
2. **不压注释密度**（现 28.4%）：本仓库靠注释承载决策史（ZB-xx 事故、官方值出处、为什么不能用某种写法），压掉等于把最贵的知识删了。
3. **不移 `index.js` 的四大块（工具文本/配置层/defineTool 探测/信标，共约 350 行）**：收益是组织性的，但 `host-config:34/103-117` 等测试**直接读 `index.js` 源码文本**做数据断言，搬走就要同时改多处 pinned 断言 —— 属于"为解耦而牺牲安全网"，本轮不做（记入第二轮候选，届时先行为化那些断言）。
4. **不合并三个 action handler**（index:605 / wire:1181 / wire:784）：三者职责确有重叠，但合并要动工具面、remote face 与 CLI 三条入口的构造时序，风险/收益比不划算；第二轮与 M12（`projectJob`）一起评估。
5. **不删 `z2-verify`**（审计 C 建议可删）：它守着两条别处没有的门禁——"**无宿主包引用**"与"**TODO 归零**"；7.95s 的成本可以接受。重叠部分留着无害。
6. **不追求 CSS 断言"行为化"**（审计 C 建议）：像素级逐属性改成真渲染断言的成本远高于收益，保留少数"实事故专用"断言即可。
7. **不做配置卡搬家**（把配置卡再挂到插件行内 / 搬去 `settings.plugins.tab`）：现状可用，重复挂载是维护负担；且客户端半边的 inject 越少越安全（见 `221901d` 的教训）。

---

## 6. 已知风险与遗留

- **不可动清单**（测试钉住的字面/形状，重构前必读）：审计 A 报告第 6 节（17 个测试文件 × 断言行号）＋ 审计 B 报告第 6 节（`REMOTE_METHODS` 单行字面量、`let channelsCache = null` 必须在 face 一侧、`noteOwnerAction` 导出与签名、`DISMISSABLE === core.SETTLED_STATES`、`elapsedSec` 表达式逐字、Qoder/OpenCode 探测参数逐字、`if (!options.workRoot) throw`、`__testables` 键集、CLI 用法注释…）。
- **3 个测试用硬编码绝对路径**读源码（`elapsed-format:51`、`lock-badge:88`、`lock-ui:46`）⇒ 仓库改名/搬家会红（本轮记录，不修：修法本身会削弱"必须读这个文件"的意图）。
- **`refs/dsh-tools/**` 与本机 DSH 版本会漂**：它只是形态对照，运行期不 import；升级 DSH 后若要继续引用行号，需重新提取（见 README:286）。
- **两处"只在真机才暴露"的教训已入库**：① `agent.inject()` 内部是**同步** splice ⇒ 必须先登记消息 id 再投递（ZB-62 真机事故）；② 插件被**重组合**替换时会跑卸载清理 ⇒ **kill 掉所有 running/queued job**（`pitfalls.md` 2026-10-17 条目）。
- **测试环境依赖**：`z4-token-check` 依赖本机 `refs/extracted/**`，换机可能假红/静默失效（本轮记录）。

### 6.1 执行过程中的环境事故（如实记录）

本轮 5 条并行线在收尾阶段**连续被环境中断**（子代理 `failed before it finished`，无收尾消息；期间会话模型/Provider 切换过一次）。后果与恢复方式：

| 线 | 中断后状态 | 恢复 |
|---|---|---|
| 执行 1（host） | 代码**已全部落地**，报告未送达 | Lead 逐项读代码复核 + 跑它自己写的 `host-decouple.test.mjs`（全绿） |
| 执行 2（index/notify） | 代码**已全部落地**，测试文件未写 | Lead 补写 `notify-engine-label.test.mjs`（21 断言） |
| 执行 3（client） | 批 1+2 落地，批 3 未做 | Lead 补写 `cross-check.test.mjs`（11 断言）；并修掉它改动导致的 `toolview-card` 切片锚点失衡 |
| 执行 5（测试稳定性） | 8/12 完成 | 余 4 个文件未改（本轮实测通过），见上 |
| 执行 4（测试补强） | 已完成 | — |

**教训（已写进 pitfalls 候选）**：并行线越多，"某个 line 交付到一半"的概率越高 ⇒ **每个执行任务的验收里必须包含"可独立复跑的判定命令"**（本轮每条线都有：新测试文件或全量套件），这样即便报告丢失，Lead 也能凭命令复核——这次正是这么救回来的。

---

## 7. 验收

**离线（随时可跑）**
```
node tools/accept-021.mjs          # 一键：静态接线 + 信标新鲜度 + 唤醒对账（当前 16/17，唯一失败=待重启）
node tools/accept-021.mjs --suite  # 附带全量回归
node %TEMP%\dispatch-suite.mjs     # 全量套件（当前 56 进程，本轮实测全绿）
```

**活体（用户统一重启后，由 AI 会话执行）**
1. `dispatch action=list` → `shape:"brief"` + `total/counts/note`（ZB-61）
2. `cordis_inspect_query` host/Tool/listTools → `dispatch` 参数含 `limit`/`full`
3. `cordis_inspect_query` client/Slots/listSubTree `{root:"tool.call.toolview"}` → occupants 含 `key:"dispatch", active:true`（ZB-63）
4. 派一个小任务并等落地 → 会话收到唤醒（**引擎标签正确**）+ `wake-stats.json` 的 `insertAcked` 递增（ZB-62 + P0-2 修复）
5. GUI 目视：`dispatch` 卡片（折叠行/展开详情/明暗主题）+ 面板各分区

---

## 8. 原始审计报告索引

| 报告 | 路径 | 规模 |
|---|---|---|
| 客户端审计 | `%TEMP%\audit-client.md` | 120 行 |
| 宿主审计（含 M1–M12 搬移表、超长函数 top8、死码、"不可动清单"） | `%TEMP%\audit-host.md` | 125 行 |
| 测试审计（含脆弱断言全清单、重复覆盖 8 组、盲区、flaky、逐文件耗时） | `%TEMP%\audit-tests.md` | 89 行 |
| 0.2.1 兼容性复核（上阶段） | `DSH-0.2.1-COMPAT-REVIEW.md` | 见该文件 §八/§九/§十 |

> 报告在 `%TEMP%`，不随仓库流转；本文件 §2 已把**结论级**内容固化（含文件:行号），足以后续按图索骥。
