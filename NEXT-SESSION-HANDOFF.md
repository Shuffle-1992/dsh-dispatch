# 交接：DSH 派发台 —— 下一步做 OpenCode 集成

> 生成：2026-10-16 ｜ 上一会话结束状态：工作树干净，`HEAD == origin/main == 65b4d39`
> **给下一个会话的 Agent**：先读完本文第 0/1/2 节，再动手。OpenCode 执行器的**实测细节**在
> 根目录 `OPENCODE-DISPATCH-HANDOFF.md`（已核对、今天仍然成立），本文只写**它没覆盖的变化**。

---

## 0. 一分钟上手（路径与名字都变了，别用旧的）

| 项 | 值 |
|---|---|
| GitHub 仓库 | **`https://github.com/Shuffle-1992/dsh-dispatch`**（旧名 `zcode-dispatch` 自动 301 重定向） |
| 本机仓库根 | **`F:\My Code\dsh-dispatch`**（**已不是** `zcode-dispatch`） |
| 插件目录 | **`dispatch/`**（仓库根下；**已不是** `zcode-dispatch/`） |
| npm 包名 / bundle id | `dsh-dispatch` / **`dispatch`** |
| agent 工具名 | **`dispatch`**（**已不是** `zcode_dispatch`） |
| remote 服务名 | `dispatch`（**已不是** `zcodeDispatch`） |
| 面板标题 / 包标题 | `派发台` / `DSH 派发台` |
| 环境变量前缀 | `DSP_`（**已不是** `ZCD_`，如 `DSP_FAKE_RUNNER`） |
| runner | `collab-kit\zcode-run.mjs`（**名字保留**——它确实只跑 ZCode 引擎） |
| 开关 CLI | `collab-kit\dispatch-switch.mjs`（原 `zcode-switch.mjs`） |
| 插件 CLI | `dispatch\bin\dispatch.mjs`（原 `bin\zcd.mjs`） |

**刻意保留 ZCode 字样的地方**（这些是正确的，别再"去品牌化"）：`collab-kit/zcode-run.mjs`、
`ZCODE_CLI` / `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` / `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`
（ZCode 引擎专属环境变量）、`dsh-connect-zcode`（那是 ZCode 的 **provider 通道**插件）。

---

## 1. 已完成的三轮（**别重做**）

### ZB-41 去品牌化改名（显示层 + 包标识 + 工具名 + remote + 环境变量 + 目录）
`dsh-zcode-dispatch→dsh-dispatch`、`zcode-dispatch→dispatch`、`zcode_dispatch→dispatch`、
`zcodeDispatch→dispatch`、`ZCD_→DSP_`、CSS 命名空间 `zcd-*→dsp-*`。
面板标题 `派发台`、包标题 `DSH 派发台`。详见 `tasks/ZB-41-delivery.md`。

### ZB-42 冻结开关不再挡住只读探测（+ BOM 加固）
用户现场：开关一关，面板看不到任何通道还报「通道清单加载失败」，以为插件坏了。
真因：ZB-33 把开关闸门提到 runner 最前，**连带挡住只读的 `--list-providers`**。
修：闸门**下移到 `--list-providers` 分支之后**（仍在凭据读取与 `spawnSync` 之前）；
面板冻结时在「通道」分区显示 `switchOffBlocked`（复用既有键）。
附带：解析开关文件前**剥 UTF-8 BOM**（BOM 会让 `JSON.parse` 抛 ⇒ fail-open ⇒ **冻结静默失效**）。
详见 `tasks/ZB-42-delivery.md`。

### ZB-43 仓库改名（GitHub + 本机根目录）
`Shuffle-1992/zcode-dispatch` → `Shuffle-1992/dsh-dispatch`；`F:\My Code\zcode-dispatch` → `F:\My Code\dsh-dispatch`。
234 处引用同步。详见 `tasks/ZB-43-delivery.md`（本轮）。

---

## 2. 当前部署状态（**改部署前必读**）

| 项 | 值 |
|---|---|
| profile | `C:\Users\Administrator\.dsh\profiles\desktop` |
| junction | `...\node_modules\dsh-dispatch` → `F:\My Code\dsh-dispatch\dispatch` |
| profile patch id | `- id: dispatch` / `name: dsh-dispatch` |
| `runnerPath` | `F:\My Code\dsh-dispatch\collab-kit\zcode-run.mjs` |
| `runnerCwd` | `F:\My Code\keysion dac vue`（宿主项目） |
| `workRoot` | `F:\My Code\dsh-dispatch\dispatch\.data` |
| `switchPath` | `F:\My Code\keysion dac vue\collab\dispatch.switch.json` |
| `ledgerPath` | `F:\My Code\keysion dac vue\collab\logs\dispatch-runs.jsonl` |
| profile 备份 | `package.json.zb41-backup` / `cordis.patch.yml.zb41-backup` |

### 跨仓库共享契约（⚠️ 改名时必须三个仓库同一次改完）

开关真值文件与额度台账**由 provider 通道（`dsh-connect-zcode`）与派发台共用**
（宿主 `collab/PROTOCOL.md` §7.1：关了开关两者一起冻结）。**单侧改名会让台账分裂** ⇒ 用量统计静默出错。

| 侧 | 位置 |
|---|---|
| 派发台（本仓库） | 默认名 + `collab-kit/dispatch-switch.mjs` |
| 宿主仓库 | `keysion dac vue\collab\dispatch.switch.json`、`collab\logs\dispatch-runs.jsonl`、`PROTOCOL.md`、`TOOLS-MOVED.md` |
| 第三方插件 | `F:\My Code\dsh-connect-zcode`（默认路径 + 文档 + 自检；已提交 `6d4e4f8`） |
| profile | **两个条目**（`zcode-connect` 与 `dispatch`）的 `switchPath`/`ledgerPath` |

> ⚠️ 宿主仓库 `keysion dac vue` 的 `collab/PROTOCOL.md`、`collab/TOOLS-MOVED.md` 两处改动
> **尚未提交**（那是另一个项目，留给用户决定）。

---

## 3. 下一步任务：OpenCode 集成（**用户已定方案**）

### 3.1 方案决策（已与用户确认，别再问）

- **渠道内集成，不做双 tab**。理由：「通道」这个既有抽象本来就等于「执行目标」；
  进程列表/锁/队列/用量/唤醒/通知/降级链**全部与引擎无关**，拆两个 tab 会把进程列表与降级链割裂，
  **失去跨引擎降级**这个最大增量。引擎专属设置用「按选中通道动态显示」解决。
- **只用免费模型**（用户明确）。

### 3.2 免费模型（今天实测，`opencode models` 在 0 凭据下**只有这 12 个**，全部免费、无需登录）

```
opencode/big-pickle                              opencode/mimo-v2.6-flash-free
opencode/cat-jam-free *                          opencode/muse-spark-1.3-contributor-free *
opencode/deepseek-v4.1-flash-free   ← 用户点名   opencode/nemotron-3-ultra-free
opencode/glm-5.3-flash-free         ← 用户点名   opencode/nemotron-3.5-lightning-free
opencode/ll-alpha-free                           opencode/nemotron-3.5-super-vl-free
opencode/longcat-2.5-preview-free                opencode/space-bunny-free
```
`*` = 上游标注「限时免费 / 限区域」。

> **建议探测式获取**（每次跑 `opencode models`），**不要写死枚举** —— 否则会重演 ZB-31
> 「档位表变了但代码写死」的坑。探测失败 ⇒ 降级为空目录并**正常挂载**（不要因此让 DSH 启动失败）。

### 3.3 已实测的执行器事实（2026-10-16 复测）

| 项 | 值 |
|---|---|
| 版本 | OpenCode **1.19.2**（`opencode --version`） |
| 免费模型调用 | `opencode run "…PONG…" -m opencode/deepseek-v4.1-flash-free --format json` → **5 秒**返回，`cost: 0` |
| 事件谱 | NDJSON：`step_start` → `text` → `step_finish`（`step_finish.part.tokens` 带完整用量，`cost` 字段存在） |
| 续会话 | `-s <sessionID>`（**跨独立进程有效**，会话持久化在 SQLite，不需要常驻进程） |
| 思考档位 | `--variant`（模型相关，如 high/max/minimal） |
| 工作目录 | `--dir <repo>` |

事件样例（`--format json`，**每行一个 JSON**）：
```json
{"type":"step_start","sessionID":"ses_…","part":{"type":"step-start",…}}
{"type":"text","sessionID":"ses_…","part":{"type":"text","text":"PONG",…}}
{"type":"step_finish","part":{"type":"step-finish","reason":"stop","tokens":{"total":7986,"input":6191,"output":3,"reasoning":0,"cache":{"write":0,"read":1792}},"cost":0}}
```
**解析必须"未知类型不崩"**：只观测到 4 种（`step_start`/`text`/`tool_use`/`step_finish`），
其余一律降级**原始透传**，绝不抛异常终止整轮。

### 3.4 建议改动清单（按落点）

| 层 | 改动 |
|---|---|
| `dispatch/core/dispatch-core.mjs` | ① 通道模型加 `engine`（`'zcode' \| 'opencode'`）；② `startJob()` 按引擎选 runner；③ 新增 `buildOpenCodeArgs()`；④ `handleLine` 按引擎分派事件解析；⑤ `validateSpec` 放开 ZCode 专属校验（`provider` 对 OpenCode 无意义） |
| 新增 `dispatch/core/opencode-run.mjs` | OpenCode 执行器（spawn + NDJSON 聚合），结构照 `collab-kit/zcode-run.mjs` |
| `dispatch/index.js` | 工具加引擎相关参数/说明；新增 config（opencode 路径、并发上限、是否探测）；system prompt 提示段补 OpenCode |
| `dispatch/client.js` | 通道下拉 `optgroup` 分组（ZCode / OpenCode 免费）；引擎专属区块按选中通道切换；进程卡片加引擎徽标 |
| `dispatch/locale/*.json` | 新增文案（记得**中英同步** + `client.js` STRINGS 单源哨兵要求 key-for-key 一致） |

### 3.5 硬约束（来自 `OPENCODE-DISPATCH-HANDOFF.md` §7，**必须遵守**）

1. **不伪装身份**：不伪造 User-Agent、不伪造 `ses_*` 时间戳 session id、不塞假工具定义。
   本方案的全部价值就在于「请求真的来自 OpenCode 本体」。
2. **不读写用户自己的 OpenCode 配置与数据**：`~\.config\opencode\`、`~\.local\share\opencode\`（`opencode.db`）。
   需要隔离就用独立 XDG 根目录。
3. **默认不开 `--auto`**（它会放行所有未显式拒绝的权限）。
4. **免费层按 IP 限流** ⇒ 并发上限要低（建议 OpenCode 侧 2，且与 ZCode 分开计数），失败重试带退避。
5. **未知事件类型不崩**（见 3.3）。

---

## 4. 这个仓库踩过的坑（防复发，都是真事故）

| # | 坑 | 教训 |
|---|---|---|
| 1 | **改名保护串只写单反斜杠** | 源码里的 JS 字面量是**双反斜杠**（`'F:\\My Code\\…'`）。只护单形态 ⇒ 根路径被一起改，10 个测试文件 ENOENT。**四种形态（双反斜杠/单反斜杠/正斜杠/URL）必须全覆盖** |
| 2 | **GitHub URL 被误改** | 脚本把 `github.com/Shuffle-1992/zcode-dispatch` 也改成了 `/dispatch`。仓库名与包名是两件事，**别混** |
| 3 | **BOM 让冻结静默失效** | PowerShell 5 的 `Set-Content -Encoding UTF8`、记事本另存为 UTF-8 都写 BOM ⇒ `JSON.parse` 必抛 ⇒ 安全开关 **fail-open**。已剥 BOM，但**写测试文件时也要用 Node 写盘**（`writeFileSync`），否则自己踩自己 |
| 4 | **Windows junction 不能 `rmSync`** | 删 junction 用 `cmd /c rmdir "<link>"`（只删链接），删后**立即验证目标仍在** |
| 5 | **改根目录名会打断 node_modules 里的 junction** | `node_modules/@deepseek-ai/{schemastery,cosmokit}` 指向旧根的 `refs/dsh-typert/*`，悬空后插件降级、`hardening.test.mjs` 变红。**改根目录后要全量扫一遍悬空 junction** |
| 6 | **PowerShell 读 UTF-8 会乱码** | `Get-Content`/`ConvertFrom-Json` 按 ANSI 读 ⇒ 中文乱码 + JSON 解析失败。**校验中文 JSON/YAML 一律用 Node** |
| 7 | **`Select-String` 管道的 `$LASTEXITCODE` 不可信** | 管道会让退出码变成 1。要真退出码就 `$out = & node …; $c = $LASTEXITCODE` |
| 8 | **闸门位置** | 只读探测**必须能过闸**（否则冻结期间面板没通道）；真实派发必过闸；闸门要在凭据读取之前。`test/frozen-probe.test.mjs` E 段有源码锁 |
| 9 | **改 bundle id 要同步三处** | profile 的 `package.json` bundles + 依赖 link + `cordis.patch.yml` 的 `id`/`name` + **junction 目录名**。漏一处 ⇒ 插件静默不加载 |

---

## 5. 生效语义（改完怎么验证）

| 改动位置 | 生效方式 |
|---|---|
| `dispatch/client.js`、`locale/*` | **刷新页面** |
| `dispatch/index.js`、`wire.host.mjs`、`core/*` | **完全退出 DSH 再启动**（cordis `_reload` 不重新 import） |
| `collab-kit/*`（runner / 执行器） | **下次派发即生效**（每次 spawn 新进程，不用重启） |
| bundle id / 包名 / junction | **完全重启**，且四处配置必须同时改 |

---

## 6. 验证命令（可复跑）

```powershell
cd 'F:\My Code\dsh-dispatch\dispatch'
# 全量测试（31 文件 / 478 断言，期望 0 失败）
$fail=0; Get-ChildItem test -Filter '*.test.mjs' | ForEach-Object { node $_.FullName *> $null; if ($LASTEXITCODE -ne 0) { $fail++; Write-Host "FAIL $($_.Name)" } }; Write-Host "失败文件=$fail"

cd 'F:\My Code\dsh-dispatch'
node tools/verify-plugin.mjs            # 期望 23 项 0 失败

# runner 只读探测（开关关闭时也应成功 —— ZB-42 的修复点）
cd 'F:\My Code\keysion dac vue'
node 'F:\My Code\dsh-dispatch\collab-kit\zcode-run.mjs' --list-providers

# OpenCode 执行器连通性（免费模型）
cd $env:TEMP
opencode run "Reply with exactly: PONG" -m opencode/deepseek-v4.1-flash-free --format json
opencode models                          # 期望 12 个 opencode/* 免费模型
```

**当前开关状态**：用户在 2026-10-16 20:17 打开过、之后又关闭；
**动手前先 `dispatch action=status` 查实时状态**，别假设。

---

## 7. 必读文档

| 文档 | 用途 |
|---|---|
| `OPENCODE-DISPATCH-HANDOFF.md` | **OpenCode 执行器实测细节**（CLI 参数、事件谱、路线 A/B、验收标准、禁做事项） |
| `pitfalls.md` | DSH 插件开发的两次启动事故（config 必须是 Standard Schema；客户端 inject 不能自声明自家 remote 命名空间） |
| `tasks/ZB-41-design.md` | 多引擎集成的方案对比（渠道内集成 vs 双 tab）与免费模型清单 |
| `tasks/ZB-41/42/43-delivery.md` | 最近三轮的改动与验证证据 |
| `dispatch/README.md` | 插件自身文档（配置表、总开关契约、思考强度、降级链） |

---

## 8. 给下一个会话的第一句话（可直接复制）

> 仓库在 `F:\My Code\dsh-dispatch`，插件目录是 `dispatch/`。
> 先读根目录 `NEXT-SESSION-HANDOFF.md` 与 `OPENCODE-DISPATCH-HANDOFF.md`，
> 然后按 §3 做 OpenCode 集成（渠道内集成、12 个免费模型、跨引擎降级）。
