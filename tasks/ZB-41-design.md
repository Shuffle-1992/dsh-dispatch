# ZB-41 设计：DSH 派发台（多引擎）+ OpenCode 集成探索

> 生成：本轮（已实测）｜状态：**待用户决策 3 项**（见 §6），决策后开工
> 依据文档：`OPENCODE-DISPATCH-HANDOFF.md`（根目录，2026-10-16 交接）

---

## 一、本轮实测事实（2026-10 复测，非转述）

| 项 | 命令 | 结果 |
|---|---|---|
| OpenCode 版本 | `opencode --version` | ✅ **1.19.2**（与交接文档一致） |
| 免费模型 | `opencode models` | ✅ **正好 12 个**，全部 `opencode/*`（0 凭据下可见的只有这些） |
| 执行器仍可用 | `opencode run "…PONG…" -m opencode/deepseek-v4.1-flash-free --format json` | ✅ **5 秒**返回 `PONG`，`cost: 0` |
| 事件谱 | 同上 stdout | ✅ 与文档一致：`step_start` → `text` → `step_finish`（带 `tokens` 与 `cost`） |
| 门禁 | 未登录、未伪装 UA | ✅ 正常放行（`opencode` 本体发的请求天然合法） |

> 结论：**交接文档的实测结论今天全部成立**，可以直接按路线 A（CLI 派发）开工。

### 1.1 你问的「OpenCode 派发只需要哪些免费模型」——答案

`opencode models` 在**无任何凭据**时只返回这 12 个，**全部免费、无需登录**（这也是"只需要免费模型"的完整集合）：

```
opencode/big-pickle
opencode/cat-jam-free                        ← 文档标注「限时免费」
opencode/deepseek-v4.1-flash-free            ← 你点名的（实测 5s，最快）
opencode/glm-5.3-flash-free                  ← 你点名的（文档实测 28s）
opencode/ll-alpha-free
opencode/longcat-2.5-preview-free
opencode/mimo-v2.6-flash-free
opencode/muse-spark-1.3-contributor-free     ← 文档标注「限时免费/限区域」
opencode/nemotron-3-ultra-free
opencode/nemotron-3.5-lightning-free
opencode/nemotron-3.5-super-vl-free
opencode/space-bunny-free
```

**建议：不写死枚举，改为「探测式」**（每次 `opencode models` 拉取，失败降级为空目录并正常挂载）——
理由：这 12 个名单会随上游变动；写死会重演 ZB-31「档位表变了但代码写死」的坑。
默认模型取 `deepseek-v4.1-flash-free`（最快），思考强度映射到 OpenCode 的 `--variant`。

---

## 二、面板结构：**建议「渠道内集成」，不新开 tab**

### 2.1 现状

面板是**单列手风琴**（`client.js` 的 `Section` 组件），四个分区：

```
标题栏「ZCode 派发台」 [派发：开] [已连接]
 ├─ 通道     ← 通道/模型/思考强度 + 免费额度条 + 自动降级
 ├─ 用量     ← 5h/本周/今日
 ├─ 进程     ← 任务列表（进行中/需处理/异常/已完成）
 └─ 仓库文件锁
```

`core/dispatch-core.mjs` 的抽象已经**天然通用**：`job.spec`（kind/task/prompt/dir/write/lock/timeout）
+ 锁注册表 + 队列 + 用量 + 降级链 + 唤醒通知，**没有一处依赖 ZCode**。真正 ZCode 专属的只有两处：
`buildRunnerArgs()`（拼 `--provider/--model/--reasoning-level`）与 `startJob()` 里写死的 `runnerPath`。

### 2.2 两个方案对比

| | **A. 渠道内集成（推荐）** | **B. 双 tab（ZCode / OpenCode 各一页）** |
|---|---|---|
| 做法 | 通道下拉里同时列 ZCode 通道与 OpenCode 免费模型，按引擎分组；通道带 `engine` 字段 | 顶部 tab 栏，每个引擎一套「通道/用量/进程」 |
| 通道列表 | `<optgroup label="ZCode">` + `<optgroup label="OpenCode 免费">` | 各自一份 |
| 核心改动 | `spec.engine` → 选 runner + 选 args builder（**约 2 处分支**） | 要拆两套渲染 + 两套状态订阅 |
| 进程列表 | **天然统一**：一个列表看全部引擎的任务 | 割裂：切 tab 才看得到另一半 |
| **跨引擎降级** | ✅ **可做**：ZCode 额度耗尽 → 自动落到 OpenCode 免费模型 | ❌ 做不了（降级链在各自 tab 内） |
| 面板体积 | 不变（不加 tab 栏，悬浮小窗本来就窄） | +一行 tab，垂直空间更紧 |
| 引擎专属设置 | 按**当前选中通道**动态显示（ZCode：额度条/记忆锁；OpenCode：variant/并发/权限） | 天然隔离（这是 B 唯一优势） |
| 复用既有设施 | 锁/队列/用量/唤醒/通知/降级 **全部复用** | 全部要复制一份或做成通用组件 |

### 2.3 推荐：A（渠道内集成）

**核心理由三条**：

1. **「通道」这个既有抽象本来就等于「执行目标」**——ZCode 通道 = provider×model，OpenCode 免费模型 = provider×model。
   两者是同一层概念，不该分家。派发的语义（单写者锁、并发上限、超时、唤醒）也完全一致。
2. **不做 tab 才能拿到最高价值的能力：跨引擎降级**。ZCode 付费额度 5 小时窗口撞顶时，
   自动落到 OpenCode 免费模型继续跑 —— 这比"两个独立派发台"有用得多。
3. **双 tab 的成本被低估了**：不是加一行 tab，而是把「进程列表 / 用量 / 锁 / 降级链」四套 UI 与状态
   各拆两份（或抽成通用组件），而它们**本来就与引擎无关**，拆了纯亏。

**B 的唯一优势（引擎专属设置隔离）用「动态显示」即可解决**：选中 OpenCode 通道时，
「通道」分区里把 ZCode 的免费额度条换成 OpenCode 的 variant/并发/权限提示，反之亦然。零额外结构。

### 2.4 集成后「通道」分区的形态（提案）

```
通道   [ ZCode ▾ ]                      ← optgroup 分组，不可用通道不出现在列表（ZB-36 既有行为）
         ├ ZCode
         │   ├ 免费额度（Start Plan）
         │   ├ BigModel - Coding Plan
         │   └ 个人 API
         └ OpenCode 免费
             ├ DeepSeek V4.1 Flash（免费）
             ├ GLM-5.3 Flash（免费）
             └ …共 12 个
模型   [ GLM-5.3-Flash ▾ ]              ← 按选中通道联动（既有行为）
思考强度 [ Agent决定（按任务判断）▾ ]     ← ZCode=reasoningLevel；OpenCode=映射到 --variant
──────── 以下按选中通道的引擎动态切换 ────────
[ZCode 通道]  免费额度剩余 ▓▓▓▓░░ 279.9M/300M · 窗口剩余 20.9 小时
[OpenCode]   ⓘ 免费层按 IP 限流，请勿并发轰炸（单写者 + 并发上限 2）
自动降级：关/开（目标可跨引擎 —— ZCode 撞顶 ⇒ 落 OpenCode）
```

---

## 三、核心技术改动（预估）

| 层 | 改动 | 风险 |
|---|---|---|
| `core/dispatch-core.mjs` | ① 通道模型加 `engine` 字段（`'zcode' \| 'opencode'`）；② `startJob()` 按 `effectiveEngine(spec)` 选 runner；③ 新增 `buildOpenCodeArgs()`（`run <task> -m <model> --format json --dir <dir> [--variant]`）；④ 新增 OpenCode NDJSON 事件解析（`handleLine` 分派）；⑤ `validateSpec` 放开 ZCode 专属校验（provider 概念对 OpenCode 无意义） | 中——`handleLine` 是 ZCode 输出的解析器，需按引擎分派 |
| 新增 `core/opencode-run.mjs` | OpenCode 执行器（spawn + 事件聚合），与 `collab-kit/zcode-run.mjs` 平级 | 低——可完全照 zcode-run 的结构写 |
| `index.js` | 工具加 `engine` 参数（或不加：通道 id 已带引擎前缀）；system prompt 提示段改文案；新增 config（opencode 路径/并发/是否探测） | 低 |
| `client.js` | 通道下拉 `optgroup` 分组；引擎专属区块按选中通道切换；进程卡片加引擎徽标 | 低-中（纯渲染） |
| `locale/*.json` | 新增 OpenCode 相关文案 | 低 |

**关键实现纪律**（来自交接文档 §7，必须遵守）：
1. **不伪装身份**（不伪造 UA / session id / 假工具定义）——本方案的意义就在于此；
2. **不读写用户自己的 OpenCode 配置与数据**（`~\.config\opencode\`、`~\.local\share\opencode\`）——只读 `opencode models` 探测；
3. **默认不开 `--auto`**；
4. **免费层按 IP 限流 ⇒ 不并发轰炸**（OpenCode 侧并发上限建议 2，且与 ZCode 分开计数）；
5. **未知事件类型不崩**（降级透传原始行）。

---

## 四、改名方案（你要求的）

### 4.1 表面改名（安全，无副作用）

| 位置 | 现值 | 改为 |
|---|---|---|
| `package.json` `meta.title` | `ZCode 派发台` | **`DSH 派发台`** |
| `locale/{zh,en}.json` `meta.title` | `ZCode 派发台` | **`DSH 派发台`** |
| `locale/{zh,en}.json` `ui.title`（面板标题） | `ZCode 派发台` | **`派发台`** |
| `ui.headerTip` | `打开 / 收起 ZCode 派发台面板` | `打开 / 收起派发台面板` |
| `ui.switchTitle` | `ZCode 派发总开关…` | `派发总开关…` |
| `package.json` `description` | `…派发/监视多个 ZCode 无头进程…` | 多引擎（ZCode / OpenCode）表述 |
| `client.js` STRINGS | 同上（单源哨兵要求与 locale 一致） | 同上 |

### 4.2 深度改名（**有兼容代价，需你决策**）

| 项 | 现值 | 影响面 |
|---|---|---|
| **agent 工具名** | `zcode_dispatch` | 改名后**所有会话的提示词/习惯/文档**都要跟着改；本插件自己注入的 system prompt 提示段会同步改（自洽），但外部引用会失效 |
| **npm 包名** | `dsh-zcode-dispatch` | 需同步改 profile `package.json` 的 `dsh.profile.bundles`、junction 目录名、`cordis.patch.yml` 的 `name:` |
| **bundle/patch id** | `zcode-dispatch` | ⚠️ **profile 覆盖 patch 是按 id 匹配的**（`~/.dsh/profiles/desktop/cordis.patch.yml` 里 `- id: zcode-dispatch`）——改了 id 必须同步改 profile，否则**部署配置全部失效**（runner/workRoot/switch 路径丢失 → 面板不工作） |
| **switch 真值文件** | `<宿主仓库>/collab/zcode-dispatch.switch.json` | ⚠️ **跨仓库契约**：宿主仓库的 `zcode-switch.mjs` 与 `PROTOCOL.md §7` 都依赖它。改名要两边一起改 |
| **台账** | `<宿主仓库>/collab/logs/zcode-runs.jsonl` | 同上，跨仓库契约 |
| **CLI** | `bin/zcd.mjs` | 可保留（zcd = zcode dispatch）或改名 |
| **数据目录** | `<插件>/work`（旧）→ `.data` | 已是通用名，无需改 |

> ⚠️ **为什么不建议无脑全改**：`bundle id` 与 `switch/ledger` 是**跨仓库/跨文件契约**，
> 单侧改名会让 DSH **静默丢失部署配置**（面板还在，但 runner/workRoot 为空 ⇒ 派发不可用），
> 正是 `pitfalls.md` 里"启动事故"那一类。建议：**显示层全改，契约层保持或双读兼容**。

---

## 五、建议的落地顺序

1. **ZB-41：改名（显示层）+ OpenCode 执行器**——先把面板变成「派发台」并让 OpenCode 能跑通（CLI 直连 + 工具可调）
2. **ZB-42：渠道内集成**——OpenCode 免费模型进入通道列表，进程/用量/锁统一
3. **ZB-43：跨引擎降级**——ZCode 撞顶 ⇒ 落 OpenCode（这是集成方案的最大增量）
4. **P2（可选）**：`opencode serve` + SSE 实时流、额度/成本喂 `dsh-cost-meter`

---

## 六、待你决策（3 项）

1. **面板结构**：(A) 渠道内集成（推荐）｜(B) 双 tab
2. **深度改名的范围**：
   - 只改显示层（面板标题/包标题），**包名/bundle id/工具名保持不变**（安全，但"包名"没改成）
   - 包名 + bundle id 一起改（**要同步改 profile patch/junction/bundles**，改错会导致插件不加载）
   - agent 工具名 `zcode_dispatch` 是否也改（改则外部引用失效）
3. **宿主仓库契约（switch 文件 / 台账路径）**是否改名（跨仓库，需另开修改）

> 「包名等相关的改成 DSH 派发台」——注意 **npm 包名不能含中文**，故建议
> `name: "dsh-dispatch"` + `meta.title: "DSH 派发台"`；若你要的字面中文包名，只能用于显示层。
