# ZB-51：三引擎自动发现（CLI / IDE / 客户端三种形态都要认）

> 生成：2026-10-16 ｜ 触发：用户要求「**插件安装后能自动检索相关登录态路径和 CLI**，
> 别人的 DSH 装了这个插件就能开箱即用」「要支持转 IDE 或 CLI 等情况下的检测」
> 本文件是**发现层的定稿设计**；每个引擎的执行器实现分列在 §5 的工单里。

---

## 1. 为什么必须做（本机实测的现状）

| 引擎 | 本机实际形态 | 现有代码怎么找到它 | 问题 |
|---|---|---|---|
| **ZCode** | **桌面客户端（Electron）**，装在 `F:\Program Files\ZCode\`；CLI 是它自带的脚本 `resources/glm/zcode.cjs`（15MB）。`zcode` **不在 PATH** | `zcode-run.mjs` **硬编码** `'F:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs'`，可用 `ZCODE_CLI` 覆盖 | 🔴 **换盘符/换机器就找不到**（本机恰好在 F: 盘才没暴露） |
| **OpenCode** | **npm 全局 CLI**（`%APPDATA%\npm\opencode.cmd`）；也可能有人装客户端 | core 里可配置 `opencodeRunnerPath`（执行器脚本），执行器再调 `opencode` | 🟡 依赖 PATH；客户端形态不认识 |
| **Qoder CN** | **IDE 已装**（`%LOCALAPPDATA%\Qoder CN`，进程在跑），用户数据在 `~/.qoder-cn/`；**CLI (`qoderclicn`) 未安装**（`~/.qoder-cn/bin/qoderclicn/qoderclicn.exe` 不存在；`~/.qoder-cn/bin/` 目前只有 `qoder-cn-computer-use`） | 无 | 🔴 未接入；且 **CN 版与全球版名字/路径完全不同** |

**结论**：三个引擎有三种截然不同的形态（客户端自带 CLI、npm CLI、IDE + 可选 CLI），
硬编码或"只认 PATH"都不可能开箱即用。必须有一个**统一的、按形态分层的发现层**。

---

## 2. 发现层设计（**统一五级探测，每个引擎一张候选表**）

### 2.1 统一优先级（与 Qoder CN 官方 dispatcher 同构 —— 它已经踩过这些坑）
本机 `~/.qoder-cn/entry/qodercn-dispatcher.ps1` 是一份**官方写的跨形态发现实现**，它的顺序验证了这套优先级：

```
① 显式 env 覆盖（QODERCN_CLI_BIN）        ← 用户/CI 强制指定，最高优先
② Get-Command <name> -CommandType Application（走 PATHEXT，同时命中 .cmd shim 与 .exe）
③ 已知的用户级回退路径（~/.qoder-cn/bin/qoderclicn/qoderclicn.exe）
```
其注释还明确写了一条**我们要照抄的教训**：
> "Get-Command can emit every PATH match (for example the standalone CLI **plus an IDE-bundled qodercli.exe**).
> Keep normal PATH priority but return **one scalar path**"
→ 即：**同一名字可能命中多个（独立 CLI + IDE 自带的），必须只取第一个，别把数组当命令名**。

我们统一为**五级**（比它多两级，覆盖"客户端自带 CLI"和"跨平台常见安装位置"）：

| 级 | 手段 | 说明 |
|---|---|---|
| **L1** | env 覆盖：`<ENGINE>_CLI` / `<ENGINE>_CLI_BIN` | 例：`ZCODE_CLI`、`OPENCODE_CLI`、`QODERCN_CLI_BIN` |
| **L2** | 插件 config 显式路径（机器专有路径**只进 profile patch**，不进仓库） | `zcodeCliPath` / `opencodeCliPath` / `qoderCliPath` |
| **L3** | PATH 查找（**PATHEXT 感知**，`.exe`/`.cmd`/`.ps1` 都认；多个命中只取第一个） | `Get-Command` 等价实现 |
| **L4** | **已知安装位置的扫描**（客户端/IDE 自带 CLI 走这条；跨盘符枚举） | 见 §2.2 每引擎候选表 |
| **L5** | 都失败 ⇒ **该引擎通道为空 + 可读 warning**，其余引擎照常 | 绝不整体失败 |

### 2.2 每引擎候选表（L4 的清单）

**ZCode**（客户端自带 CLI）
```
%ProgramFiles%\ZCode\resources\glm\zcode.cjs          # 本机实测（F: 盘）
%ProgramFiles(x86)%\ZCode\resources\glm\zcode.cjs
%LOCALAPPDATA%\Programs\ZCode\resources\glm\zcode.cjs
%LOCALAPPDATA%\ZCode\resources\glm\zcode.cjs
# 跨盘符：枚举 C:..H: 的 \Program Files\ZCode\resources\glm\zcode.cjs
# （ZCode 安装器允许改装到别的盘 —— 本机就在 F:，这正是硬编码挂掉的原因）
+ PATH 里的 zcode / zcode.cmd / zcode.ps1
```
凭据/登录态：`~/.zcode/v2/credentials.json`（存在 + 非空即视为已登录；**不解析内容**）；
`~/.zcode/cli/config.json`（CLI 侧配置）。

**OpenCode**（npm CLI 为主，客户端为兼容形态）
```
PATH: opencode / opencode.cmd / opencode.ps1
%APPDATA%\npm\node_modules\opencode-ai\bin\opencode.exe   # npm 全局实际落点（本机实测）
%LOCALAPPDATA%\Programs\opencode\opencode.exe             # 客户端形态（若存在）
~/.opencode/bin/opencode                                  # *nix 安装脚本落点
```
凭据/登录态：`~/.local/share/opencode/auth.json`（SDK 目录约定；**不解析内容**）。

**Qoder = 全球版 + CN 版（两套名字都要认）**
| | 全球版 | **CN 版（本机）** |
|---|---|---|
| CLI 命令 | `qoder` | **`qoderclicn`**（dispatcher 里也认 `qodercn.exe`） |
| 统一入口 | `qoder` | **`qoder-cn.cmd` / `qodercn.cmd`**（`~/.qoder-cn/entry/`，**dispatcher 会分派 CLI vs IDE**） |
| 用户配置目录 | `~/.qoder` | **`~/.qoder-cn`** |
| env 覆盖 | `QODER_PERSONAL_ACCESS_TOKEN`、`QODER_CONFIG_DIR` | **`QODERCN_CLI_BIN`**；CN 的 PAT/配置目录变量名待抓（**不能假设与全球版同名**） |
| IDE 安装 | `%LOCALAPPDATA%\Programs\Qoder` | **`%LOCALAPPDATA%\Qoder CN`**（只有 Launcher） |
| 凭据落点 | `~/.qoder`（auth status） | **`~/.qoder-cn/.auth/`**（本机实测：`.credential-transaction` + `machine_id`） |

Qoder 候选（L4）：
```
# CN 优先（若两者都装，CN 的 dispatcher 在自己目录里，不会互相抢）
~/.qoder-cn/bin/qoderclicn/qoderclicn.exe              # CN CLI 的用户级回退（本机未装）
~/.qoder-cn/entry/qoder-cn.cmd                          # CN 统一入口（本机有！可当 CLI 用）
%LOCALAPPDATA%\Qoder CN\...                             # IDE 安装目录
~/.qoder/bin/qoder                                      # 全球版
PATH: qoderclicn / qoder / qoder-cn / qodercn
```
> ⚠️ **CN 与全球版不要同时启用**：账号与额度体系不同（`qoder.cn` vs `qoder.com`）。
> 发现层应把它们视作**两个候选通道**（`qoder` / `qoder-cn`），各自独立上报可用性，而不是二选一硬编码。

### 2.3 探测结果要"可解释"（避免"为什么这个通道不见了"的撞墙）
每个引擎探测后必须能回答四问，并**在 `channels` 的 warning/提示里给出**：
1. **找到哪个可执行文件**（绝对路径，L1–L4 哪一级命中）；
2. **版本**（`--version`，用于"输出格式漂移"的门禁）；
3. **是否已登录**（只看凭据文件是否存在，不读内容）；
4. **形态**（`cli` / `ide-bundled` / `client`），面板上作为通道徽标的一部分。

---

## 3. 登录态探测（**合规边界**）

| 引擎 | 检测什么 | **不**做什么 |
|---|---|---|
| ZCode | `~/.zcode/v2/credentials.json` 存在且非空 | 不解析 token；不读 `~/.zcode/memories`、`~/.zcode/cli/db` |
| OpenCode | `~/.local/share/opencode/auth.json` 存在 | 不读其内容；不碰 `~/.local/share/opencode/opencode.db` |
| Qoder | `~/.qoder-cn/.auth`（或全球版 `~/.qoder` 的 auth status）存在；或 env 有 PAT | **不读会话内容** `~/.qoder*/projects/**/*.jsonl`；不写用户 settings |

**判据一律是"存在性 + 是否非空"**，永不解析凭据内容 —— 这既满足合规，也避免把 token 带进日志。

---

## 4. 开箱即用：插件的默认行为（自动配置，零手填）

插件 `apply()` 时执行一次发现，并把结果**自动**填进 dispatcher 配置（用户什么都不用配）：

| 情况 | 插件行为 |
|---|---|
| 某引擎找到 CLI + 已登录 | 启用该引擎的通道（探测模型清单） |
| 某引擎找到 CLI 但**未登录** | 通道**列出但标注不可用** + 可操作提示（去哪登录/怎么设 PAT），**不阻断其它引擎** |
| 某引擎**没找到 CLI** | 不列该引擎通道；在 `warnings` 里说明"未检测到 X（已查 L1–L4 的哪几处）" |
| 只装了 IDE（如本机 Qoder CN） | **尝试 IDE 自带 CLI / 统一入口**（Qoder CN 的 `~/.qoder-cn/entry/qoder-cn.cmd` 就是这种），能跑则照常启用 |
| 都找不到 | 面板给出"三种引擎各需要什么"的一页说明（教学文档的任务） |

**config 与发现的优先级**：显式 config（L2）> env（L1）？——
**反了，要按 §2.1 的顺序：env 最高**（CI/多机覆盖的常规做法），config 次之，然后 PATH、扫描。
但**插件自动写入的**只应是"发现结果缓存"，**不得**写进 profile patch（机器专有路径的纪律不变）。

---

## 5. 工单（实施顺序）

| # | 工单 | 依赖 | 状态 | 交付 |
|---|---|---|---|---|
| **T1** | `collab-kit/engine-discover.mjs`：统一发现层（五级 + 三引擎候选表 + 登录态存在性探测 + 可解释结果） | 无 | ✅ **完成** | 模块 378 行 + `dispatch/test/engine-discover.test.mjs` **62 PASS / 0 FAIL** |
| **T2** | 接进 core：`listChannels()` 带 `engineDetail`（form/version/loggedIn/variant/summary）+ 未找到/未登录的可读 warning；`ENGINES` 加 `qoder`；`qoderRunnerPath`/`buildQoderArgs`/`maxConcurrentQoder` 就位 | T1 | ✅ **完成** | 全量 39 文件 0 失败 |
| **T3** | **修掉 ZCode 硬编码**（CLI 与 builtin 配置都按"安装根"推导） | T1 | ✅ **完成** | `zcode-run.mjs` + `dispatch/test/zcode-discovery.test.mjs` **12 PASS** |
| **T4** | **Qoder 执行器** `collab-kit/qoder-run.mjs`（解析 `stream-json` 事件谱；权限默认 `accept_edits` + 回落报警；usage 用 `total_credits`/`context_usage_ratio`） | T2 | ✅ **完成** | 执行器约 630 行 + `qoder-executor.test.mjs` **104 PASS** + `qoder-routing.test.mjs` **7 PASS**；**真机验收通过**（详见 `ZB-50` §9） |
| **T5** | 面板：引擎徽标补"形态（IDE/CLI）"+ 未登录态的可操作提示 | T2 | ✅ **完成** | 客户端「引擎状态条」组件 + `engineOf()` 单一权威归一 + 13 个新 locale 键（中英 184/184）；`wire.host.mjs` 透传 `engineDetail`（快照 + channels 两路） |
| **T6** | **教学文档**（`dispatch/teaching.md`：新 Agent 上手 / 三引擎装登 / 十面墙清单） | 全部 | ✅ **完成** | `dispatch/teaching.md`（138 行，含九节：上手 / 三引擎事实 / 五级发现 / **十面墙** / 能力差异 / 速查 / 自查三步 / Agent 纪律 / 如实标注的实现状态） |

### T5 顺带修掉的两个真问题（都是"静默丢字段"类）

1. **`engineDetail` 在 host 侧被丢掉**：`wire.host.mjs` 的 `cachedChannels()` / `channelsCached()` / `impl.channels()`
   三处构造返回值时都没有带上它 —— T2 刚加的字段会被**静默丢弃**（客户端只是"画不出那条 UI"，不报错）。
   已全部透传，并**随快照一起下发**（否则状态条只在挂载时更新，登录态变化看不到）。
2. **客户端的分组判据是二元的**：`c.engine === 'opencode' ? 'opencode' : 'zcode'` 散落三处 ——
   第三个引擎（qoder）一来就会被**错误归进 ZCode 组**（分组/徽标/提示全错且不报错）。
   已收敛为单一权威 `engineOf()` + `KNOWN_ENGINES` 白名单。

> ⚠️ **教训（同类问题第三次出现）**：给 `ENGINES` 加引擎时，必须同步所有"按引擎分支"的地方。
> 目前已知的同步点：`LEVELS_KEYWORD` / `APPLIED_RE_OF` / `APPLIED_MAPPER`（core）、
> `RUN_PREFIX` / `RUNNER_BASENAME`（协议）、客户端分组与徽标、host 的字段透传。
> 漏一处就是"静默失效"（不抛错、只是行为错），比报错更难查 —— 故都补了契约锁断言。

### 实测记录（本轮）

本机三引擎发现结果（`node dispatch/test/engine-discover.test.mjs` 第 ⑪ 组实打印）：
```
zcode:    client-bundled-cli · v0.16.9 · 已登录 · F:\Program Files\ZCode\resources\glm\zcode.cjs
opencode: cli · v1.19.2 · 登录态未知 · C:\Users\Administrator\AppData\Roaming\npm\opencode.cmd
qoder:    cli · cn · v1.1.73 · 已登录 · C:\Users\Administrator\.qoder-cn\bin\qoderclicn\qoderclicn.exe
```

**发现层踩到并修掉的四个真机坑**（都写了回归断言）：
1. **PATH 同名多命中**：npm 目录里 `opencode`（无扩展名 shell 脚本）会先被命中，Windows 下 `spawnSync` 直接 `EINVAL` ⇒ 拿不到版本。⇒ 带可执行扩展名（`.exe`/`.cmd`）优先，无扩展名排最后。
2. **`.cmd` 必须经 shell**：`spawnSync('…\opencode.cmd', [...])` → `EINVAL`；`shell:true` → 正常输出 `1.19.2`。
3. **登录态不能瞎判**：`~/.local/share/opencode/` 里**没有** `auth.json`（只有 `opencode.db`）而 CLI 正常 ⇒ 改成"有凭据才说已登录，否则报**未知**"，不谎报；Qoder 更不能看 `.auth/` 目录（实测里面只有 `machine_id`），唯一可靠判据是 `--list-models` 能否跑通。
4. **加引擎必须同步三张表**：`LEVELS_KEYWORD` / `APPLIED_RE_OF` / `APPLIED_MAPPER`。漏掉会让 `resFor()` 在热路径抛 `is not a function`，整条通道清单与解析全废（已补 `qoder` 行 + 未知引擎兜底正则）。

**并发纪律（本轮实测）**：**免费层不要并发派多个 opencode 任务**。两个长任务并发时双双卡在 `spawn`、`chars=0`（且完全绕过派发台直接手跑 `opencode run` 同样挂住 ⇒ 是上游限流，与派发台无关）。建议 `maxConcurrentOpenCode` 由 2 降到 1。

> **本机现状对 T4 的阻塞**：Qoder CN **只装了 IDE，没装 CLI**（`qoderclicn` 不存在）。
> 所以 T4 前需要用户在 CN 里装 CLI（`qoder-cn.cmd` 是统一入口，可用它引导），或直接装独立 CLI。

---

## 6. 本机实测记录（供后续对照）

```
引擎       形态                    可执行                                       登录态
ZCode      Electron 客户端         F:\Program Files\ZCode\resources\glm\zcode.cjs   ~/.zcode/v2/credentials.json (2486B) ✅
                                    （不在 PATH；zcode-run.mjs 硬编码此路径）
OpenCode   npm 全局 CLI            %APPDATA%\npm\opencode.cmd (1.19.2)            ~/.local/share/opencode/ (待核)
Qoder CN   IDE（Launcher only）     %LOCALAPPDATA%\Qoder CN\...Launcher.exe        ~/.qoder-cn/.auth/ ✅
           CLI 未安装              ~/.qoder-cn/bin/qoderclicn/qoderclicn.exe ✗ 不存在
           统一入口可用            ~/.qoder-cn/entry/qoder-cn.cmd ✅ 存在
```
