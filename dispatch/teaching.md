# 派发台使用教学（新 Agent 上手）

> 目标读者：**刚接触本插件的 Agent / 开发者**。读完可独立把三个引擎跑起来，且能自己排障。
> 纪律：本文每条结论都标注依据（`实测` / `官方文档` / `设计约定`）。**没实测的不写**。
> 机器相关事实来自 Windows + ZCode 客户端 + OpenCode CLI + Qoder CN CLI 的真机环境。

---

## 1. 这是什么 / 一句话上手

派发台把任务派给**无头 agent 进程**执行，支持三个引擎：**ZCode / OpenCode / Qoder**。
执行器按需 spawn 子进程、解析事件流、落台账，面板可看进程/锁/用量，支持续跑与跨引擎降级。

最小上手（两条命令）：

```powershell
# ① 看这台机器上有哪些引擎、哪些通道
dispatch action=channels

# ② 派一个任务（默认参数已最优，多数情况只需 kind + prompt + provider）
dispatch action=dispatch { kind:'prompt', prompt:'回复 PONG', provider:'opencode/deepseek-v4.1-flash-free', timeoutMin:5 }
```

先确认总开关（关着时只读探测仍可用，但**真实派发会被拒**）：

```powershell
dispatch action=status
```

---

## 2. 三个引擎：装什么、怎么登、在哪

| 引擎 | 形态 | 可执行文件（真机落点） | 登录态判据 | env 覆盖 |
|---|---|---|---|---|
| **ZCode** | 桌面客户端**自带** CLI | `F:\Program Files\ZCode\resources\glm\zcode.cjs`（**不在 PATH**） | `~/.zcode/v2/credentials.json` 存在且非空 | `ZCODE_CLI` / `ZCODE_HOME` / `ZCODE_INSTALL_DIR` |
| **OpenCode** | npm 全局 CLI | `%APPDATA%\npm\opencode.cmd` | `~/.local/share/opencode/auth.json`（**注意：通常没有**，见 §4 第 4 条） | `OPENCODE_CLI` / `OPENCODE_BIN` |
| **Qoder CN** | IDE + 独立 CLI | `~/.qoder-cn/bin/qoderclicn/qoderclicn.exe` | **`--list-models` 能否成功**（不是看 `.auth/`） | `QODERCN_CLI_BIN` |
| Qoder 全球版 | 同上 | `~/.qoder/bin/qoder` | 同上 | `QODER_CLI_BIN` |

安装命令（**CN 与全球版是不同域名，别搞混**）：

```powershell
# Qoder CN（国内版）
irm https://qoder.com.cn/install.ps1 | iex
# Qoder 全球版
irm https://qoder.com/install.ps1 | iex
```

登录：

```powershell
qoderclicn login      # 浏览器设备码流程，**5 分钟有效期**（会打印一个 URL，超时要重来）
qoderclicn --list-models   # 登录成功的权威验证（未登录会报 Not logged in 且 exit=1）
```

> 🔴 **IDE 登录 ≠ CLI 登录**（实测）。Qoder CN 的 IDE 明明登录着，CLI 仍报 `Not logged in` ——
> 两者凭据独立，`~/.qoder-cn/.auth/` 里只有 `machine_id`（不是凭据）。**CLI 必须单独登录一次**。

---

## 3. 自动发现：插件怎么找到它们（**五级**）

插件安装后**自动**按下列顺序查找，**用户不需要手填任何路径**：

1. **环境变量**（`ZCODE_CLI` / `QODERCN_CLI_BIN` …）—— 最高优先，供 CI/多机覆盖
2. **插件配置**里显式给的路径
3. **PATH**（Windows 按 PATHEXT：`.exe` / `.cmd` / `.bat` / `.ps1`；**同名多命中只取第一个**）
4. **已知安装位置扫描**（客户端/IDE 自带 CLI 走这条；**含跨盘符**枚举）
5. 全部失败 ⇒ **该引擎通道为空 + 可读说明**（写明查过多少处、怎么修），**其它引擎照常**

每个引擎上报**四件事**，面板「引擎」状态条直接显示：

| 上报项 | 含义 | 取值 |
|---|---|---|
| `entry` | 找到哪个可执行文件 | 绝对路径 |
| `version` | 版本 | 如 `1.1.73`（取不到就是 null，**不伪造**） |
| `loggedIn` | 是否已登录 | `true` / `false` / **`null`（无法判定，不谎报）** |
| `form` | 形态 | `cli` / `client-bundled-cli` / `ide-bundled` / `ide-entry` |

真机示例（`dispatch action=channels` 的 `engineDetail`）：

```
zcode:    client-bundled-cli · v0.16.9 · 已登录 · F:\Program Files\ZCode\resources\glm\zcode.cjs
opencode: cli · v1.19.2 · 登录态未知 · %APPDATA%\npm\opencode.cmd
qoder:    cli · cn · v1.1.73 · 已登录 · ~\.qoder-cn\bin\qoderclicn\qoderclicn.exe
```

---

## 4. 十面墙（现象 → 原因 → 怎么办）

### ① 任务"成功"但一个文件都没改（Qoder 默认权限模式）
- **现象**：`state=done`、`is_error=false`、`permission_denials=[]`，但文件根本不存在。
- **原因**：无头模式下凡是"需要确认"的操作会被**直接拒绝**（不会挂住等人）。Qoder 的默认模式在无头下就等于"写操作全拒"，而且**失败得很安静** —— 唯一线索是 `result` 文本里一句
  *"It looks like the write was denied. Would you like to allow it…"*。
- **怎么办**：执行器默认带 `--permission-mode accept_edits --add-dir <cwd>`；要全放行时派发方**显式**传 `auto:true`（映射为 `bypass_permissions`）。`auto` 默认 **false**，绝不自作主张。

### ② 目录不受信任 ⇒ 权限模式被回落（同一面墙的另一半）
- **现象**：同上（任务成功但没改），因为非默认权限模式**只在受信任目录生效**。
- **怎么办**：执行器恒带 `--add-dir <cwd>`，并**比对 `init.permissionMode`**：
  与传入值不一致即判定"回落了"，在 `[qoder-run]` 行里**明确报警**。
  ⚠️ 注意 `accept_edits` 回传的是 **`acceptEdits`（驼峰）** —— 判据值必须用驼峰比对，否则会永远误报。

### ③ Qoder 未登录
- **现象**：`--list-models` 报 `Not logged in. Run 'qoderclicn login'`，exit=1。
- **怎么办**：跑 `qoderclicn login`（5 分钟有效期的设备码），或设 `QODER_PERSONAL_ACCESS_TOKEN`（PAT，适合 CI）。**别指望 IDE 登录能顶替**（见 §2）。

### ④ Qoder 的 token 字段可能是 0
- **实测**：`input_tokens` / `output_tokens` / `cache_read_input_tokens` / `contextWindow` **全为 0**。
- **怎么办**：**用量看 `total_credits` 与 `usage.context_usage_ratio`** —— 它们是真实计量。
  面板显示为 0 不代表没消耗。

### ⑤ 慢模型被误杀（历史事故）
- **现象**：`glm-5.3-flash-free` 首次调用约 14 秒，曾被一个**独立于 `--timeout-min` 的 15 秒兜底**判成挂死（out/err 都是 0 字节）。
- **怎么办**：兜底只挂在 `timeoutMin` 之上（`settleDeadlineMs = timeoutMin*60000 + 120000`）。
  给慢模型留足 `timeoutMin`（首次冷启动普遍 10–20 秒，别用 3 秒去"快速失败"）。

### ⑥ 并发多个 CLI agent 会互相干扰
- **现象**：同一进程链里在 `run` 进行中再起一个 opencode（如探测）⇒ 前者**零输出 exit 1**。
- **怎么办**：探测已改顺序 + 缓存。**两个独立的 `run` 并发本身是安全的**（实测 2/2 成功），
  但**免费层不要并发派多个长任务**（实测两个长任务会一起卡在 `spawn` 零输出）。
  建议 `maxConcurrentOpenCode` 保持 **1–2**，别用并发去"提速"。

### ⑦ 免费层限流
- **现象**：429 / `Endpoint is unavailable`，间歇失败；也可能表现为长时间零输出。
- **怎么办**：这是上游限流，**不是插件坏了**。等窗口恢复，或换通道（`action=channels` 看可用项）。
  排查方法：**完全绕过派发台**直接手跑一次（如 `opencode run "回复 PONG"`）—— 若同样挂住，就是上游问题。

### ⑧ 续会话必须同一 cwd
- **原因**：会话按工作目录/项目作用域隔离。
- **怎么办**：系统把 `sessionId` 与 `cwd` **成对**持久化；续跑必须带同一 `cwd`。
  跨引擎交接**绝不 resume**（会话不通用），必定开新会话。

### ⑨ 权限放行是显式的、且永远可见
- `auto` 默认 **false**；开启后 job 上有 `autoApproved` 标记 + 面板「已放行权限」徽标
  + 执行器打 `auto=on` 告知行 ⇒ **放行永远可见**，不会偷偷全放行。

### ⑩ 改完不生效（改动生效层级不同）
| 改了哪 | 怎么生效 |
|---|---|
| `client.js` / `locale/*` | **刷新页面**即可 |
| `index.js` / `wire.host.mjs` / `core/*` | **完全退出 DSH 再启动** |
| `collab-kit/*`（执行器） | **下次派发即生效**（每次 spawn 新进程） |

---

## 5. 三个引擎的能力差异（速查）

| 维度 | ZCode | OpenCode | Qoder |
|---|---|---|---|
| 思考强度旗标 | `--reasoning-level` | `--variant` | `--reasoning-effort` |
| 档位表事件 | `reasoning-levels` | `variants` | `reasoning-efforts` |
| 生效确认行 | `reasoning-level=<lv> target=<p>/<m>` | `variant=<v> model=<id>` | `reasoning-effort=<lv> model=<id>` |
| 不支持 | — | `mode` / `memoryBench` | `mode` / `memoryBench` |
| 权限放行 | 无（不需要） | `--auto`（默认关） | `--permission-mode`（默认 `accept_edits`） |
| 续会话 | `--resume` | `-s <id>`（同 cwd） | `--session-id`（按项目隔离） |
| 并发上限 | `maxConcurrent` | `maxConcurrentOpenCode`（默认 2） | `maxConcurrentQoder`（默认 1） |
| 通道 id 形态 | `plan` / `account:<family>-start-plan` | `opencode/<model>` | `qoder/<model>` |
| 档位探测开关 | `--list-providers` 自带 | `--list-models --with-variants` | `--list-models --with-efforts` |

---

## 6. 面板里怎么选（通道 → 模型）与思考强度

### 6.1 「顺序派发」与「模型」下拉

「通道」下拉只列**引擎**（ZCode / OpenCode / Qoder）；具体模型在「模型」下拉里选：

```
通道: ZCode     → 模型: 顺序派发 / GLM-5.3 / GLM-5.3-Flash / GLM-5.3-Flash「免费」
通道: OpenCode  → 模型: 顺序派发 / 10 个免费模型（opencode/<model>）
通道: Qoder     → 模型: 顺序派发 / 15 个模型（qoder/<model>）
```

**「顺序派发」（模型下拉首项，ZB-52）** —— 不绑定任何模型（存值为空 `''`）：

- **选它 = 开启顺序派发**（⚠️ **没有开关**）：唯一真相就是"该通道的模型为空"。
  有开关时会出现"开关开着、模型却是具体值"这种**自相矛盾**状态，故 ZB-52 第三轮按用户要求去掉开关。
- 派发时按**顺序列表从上到下**尝试模型：**前一个报错就换下一个**，全试完仍失败才报错；
  **第一跳就是列表第一项**（不是引擎默认模型）—— 面板显示什么顺序就按什么顺序跑。
- 列表**每引擎各自一份**（ZCode / OpenCode / Qoder 互不影响），用列表旁的 **↑↓ 调整次序**；
  每行右边的**「档位」**可单独设该模型的思考强度（「默认」= 用引擎默认档位）。
- 列表里没有的模型自动排在末尾（**新增模型不会消失**）。
- ⚠️ **主通道与降级通道都支持**，可**同时**成立（如主通道 OpenCode 顺序 + 降级 Qoder 顺序）：
  降级目标的「模型」也选「顺序派发」即可，它与主通道**共用同一份按引擎存的列表**。
- ⚠️ **换模型 = 新开会话**（换进程甚至换引擎，会话无法继承）：磁盘上**已完成的文件改动会保留**，
  新模型会收到交接提示词被告知"接着做"。
- 顺序列表跑完仍失败 ⇒ 才轮到**「自动降级」**（跨通道续命）。**先顺序、后降级**；
  降级到某个"也是顺序派发"的目标时，会在那个引擎的列表里再跑一轮。

**它治什么问题**：免费模型有**额度上限**、或**用的人太多会临时报错** —— 逐个试过去总能撞上一个可用的。

**触发面**（用户选定「任何失败都延续，除参数错误」）：`failed` 与所有 `paused` 都延续，
**唯独 `config-error` 不延续** —— 那是参数/配置错，换任何模型都一样，延续只是白烧额度。

> 注：**显式指定了模型**的派发**不会被顺序链劫持**（指定了就按指定的跑）。
> 顺序派发只在"模型为空"时接管 —— 这也意味着**没法用"显式命名列表第一项"来启动顺序派发**。

**「…「免费」」后缀**表示该项走**免费额度（Start Plan）**通道 —— 它与套餐是**两套独立实现**
（不同 provider、不同端点、独立额度）。⚠️ 两者**提供同样的模型名**（如都有 `GLM-5.3-Flash`），
但**免费额度实测只给 `GLM-5.3-Flash`**，故免费项只列它并加「免费」后缀，避免与套餐项混淆。

### 6.2 思考强度（三引擎都支持，档位来自**真实探测**）

| 引擎 | 旗标 | 档位来源 | 实测档位 |
|---|---|---|---|
| ZCode | `--reasoning-level` | runner `--list-providers` 的 `reasoning-levels` 行 | 逐模型声明 |
| OpenCode | `--variant` | `opencode models --verbose` 的 `variants` 键（**逐模型**） | 如 `low,medium,high,xhigh,max` |
| Qoder | `--reasoning-effort` | **哨兵值逼 CLI 报出合法集合** + 逐个实测接受性 | `auto,none,low,medium,high,xhigh,max,ultracode` |

要点（**别踩的坑**）：

- **档位是探测出来的，不写死**：上游改了模型目录，档位表跟着变（重演 ZB-31「表变了但代码写死」的坑）。
- **探测很慢**（Qoder 实测约 2 分钟：15 模型 × 9 次 CLI 调用）⇒ 走 **TTL 缓存 + 后台预热**。
  故**首次**打开面板时「思考强度」下拉可能是空的，**下次刷新就有**（这是设计，不是坏了）。
- **OpenCode 的档位是逐模型的**：真机有 4 个模型**根本没有**档位维度
  （`big-pickle` / `mimo-v2.6-flash-free` / `nemotron-3-ultra-free` / `nemotron-3.5-lightning-free`）
  —— 它们不会被造出档位。面板的档位下拉取**该引擎所有模型的并集**，
  故选中的模型**未必**支持下拉里的每一项；档位与模型不匹配时由 CLI 自己报错。
- **Qoder 逐模型的档位子集拿不到**（CLI 只在真正开会话时才判定"模型×档位"匹配，只读探测无出口）
  ⇒ 面板给的是**引擎级**合法集合，不谎称逐模型精确。


---

## 7. 常用操作速查

```powershell
dispatch action=status                       # 总开关
dispatch action=channels                     # 引擎与通道（含 engineDetail、warnings）
dispatch action=dispatch { kind:'prompt', prompt:'…' }
dispatch action=list                         # 进程列表
dispatch action=tail  { id:'j-…', n:30 }     # 读尾部输出
dispatch action=wait  { id:'j-…', timeoutSec:120 }
dispatch action=kill  { id:'j-…' }
dispatch action=retry { id:'j-…' }           # 续跑（同通道 resume / 换通道交接）
dispatch action=quota                        # 用量台账
```

`kind` 三选一：`prompt`（完整指令）/ `target`（目标描述，执行器自续跑）/ `task`（任务包文件绝对路径）。

---

## 8. 出问题时怎么自查（三步）

1. **`dispatch action=channels`** —— 看通道在不在、`warnings` 说什么。
   找不到引擎时 warnings 会写明**查过多少处**与**怎么修**；未登录时会写明登录方式。
2. **看 job 的失败字段** —— `paused`/`failed` 的 `pauseReason` / `pauseDetail`，以及 `tail` 尾部。
3. **引擎级问题直接手跑一条最小命令** —— 例：`qoderclicn -p -o json "回复 PONG"`。
   能过 ⇒ 问题在派发台；同样失败 ⇒ 问题在引擎/上游。

---

## 9. 给 Agent 的三条纪律

1. **不要把"没找到引擎"当成插件坏了** —— 先看 `channels` 的 warnings，那里写了查过哪里与怎么修。
2. **派慢模型要给足 `timeoutMin`** —— 不要用短超时"快速失败"；免费层冷启动 10–20 秒很正常。
3. **需要权限放行时显式传 `auto:true`**，并在交付说明里写清"这次是放行了权限的"（可审计）。

---

## 10. 当前实现状态

| 引擎 | 状态 |
|---|---|
| ZCode | ✅ 完整可用 |
| OpenCode | ✅ 完整可用 |
| Qoder | ✅ **完整可用**（真机验收通过：`--model Fast` 问答 7 秒完成、credits 与上下文占比正确上报、权限模式如实回显） |

Qoder 通道形态为 `qoder/<模型名>`（真机模型名含空格与点，如 `qoder/Qwen3.8-Max`），
共 15 个模型可选（`Auto` / `Fast` / `Qwen3.8-Max` / `DeepSeek-V4-Pro` / `GLM-5.3` / `Kimi-K3` …）。
用量以 `total_credits` 为准（该引擎 token 字段恒为 0，见 §4 第 4 条）。

**真机验收记录（ZB-52 顺序派发 + 档位）**：

- **顺序派发**：列表每引擎一份，失败按序换模型（详见 §6.1）。
- **档位补齐**：三引擎都能在面板选思考强度，档位来自真实探测（详见 §6.2）——
  实测 Qoder 15/15 个模型拿到 8 档、OpenCode 6/10 个模型有档位（其余 4 个确无该维度）。
- **千问 3.8-Flash 长任务验收**：30 个文件逐个写入，**69.4 秒 / 31 轮 / 58 次工具调用**，
  产出 30/30 逐字节正确，心跳 6 条（每 10s：`tools=33→58` 单调增长），`credits=0`，无解析噪音。
